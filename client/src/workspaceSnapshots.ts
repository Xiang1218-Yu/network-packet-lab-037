import type { PacketScenario, Protocol, SimulatedPacket } from '../../shared/types';

/**
 * 按「协议 + 场景」隔离的工作区快照存储。
 *
 * 每个 `${protocol}:${scenario}` 组合独立保存一份快照：
 * 最近一次输入、活动视图、字段展开状态和最后成功解析结果。
 * 旧版单份全局存储（LEGACY_STORE_KEY）会在首次读取时迁移为对应组合的快照。
 */

export type ActiveView = 'overview' | 'hex';

export interface WorkspaceSnapshot {
  protocol: Protocol;
  scenario: PacketScenario;
  rawInput: string;
  activeView: ActiveView;
  /** 字段树节点 id → 是否展开；缺省视为展开 */
  expandedFields: Record<string, boolean>;
  /** 最后一次成功解析/载入的数据包；尚未成功解析过则为 null */
  packet: SimulatedPacket | null;
  updatedAt: number;
}

interface SnapshotStore {
  version: 2;
  snapshots: Record<string, WorkspaceSnapshot>;
}

const STORE_KEY = 'packet-lab:workspace-snapshots:v2';
/** 旧版单份全局状态的存储键，读取时自动迁移 */
const LEGACY_STORE_KEY = 'packet-lab:last-workspace';

/** 单条原始输入的最大长度，超出部分截断而不是拖垮存储 */
const MAX_RAW_LENGTH = 64 * 1024;
/** 单条快照最多记录的展开状态条目数 */
const MAX_EXPANDED_KEYS = 500;
/** 快照总数上限，超出时按更新时间逐条淘汰最旧的 */
const MAX_SNAPSHOTS = 24;

export function snapshotKey(protocol: Protocol, scenario: PacketScenario): string {
  return `${protocol}:${scenario}`;
}

function isProtocol(value: unknown): value is Protocol {
  return value === 'HTTP' || value === 'TCP';
}

function isScenario(value: unknown): value is PacketScenario {
  return value === 'request' || value === 'response' || value === 'handshake';
}

function isActiveView(value: unknown): value is ActiveView {
  return value === 'overview' || value === 'hex';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 轻量结构校验：解析结果损坏时丢弃该字段，而不是让整份快照（乃至页面）崩溃 */
function sanitizePacket(value: unknown): SimulatedPacket | null {
  if (!isRecord(value)) return null;
  const { id, protocol, scenario, summary, raw, hex, fields, timeline, metadata } = value;
  if (typeof id !== 'string' || !isProtocol(protocol) || !isScenario(scenario)) return null;
  if (typeof summary !== 'string' || typeof raw !== 'string') return null;
  if (!Array.isArray(hex) || !Array.isArray(fields) || !Array.isArray(timeline) || !isRecord(metadata)) {
    return null;
  }
  return value as unknown as SimulatedPacket;
}

function sanitizeExpandedFields(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value)
    .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
    .slice(0, MAX_EXPANDED_KEYS);
  return Object.fromEntries(entries);
}

/**
 * 逐项校验单条快照：可修复的字段就地修复（截断、过滤），
 * 关键字段（协议/场景，且需与存储键一致）损坏时返回 null 表示淘汰该条。
 */
function sanitizeSnapshot(key: string, value: unknown): WorkspaceSnapshot | null {
  if (!isRecord(value)) return null;
  const { protocol, scenario } = value;
  if (!isProtocol(protocol) || !isScenario(scenario)) return null;
  if (snapshotKey(protocol, scenario) !== key) return null;

  const rawInput = typeof value.rawInput === 'string' ? value.rawInput : '';
  return {
    protocol,
    scenario,
    rawInput: rawInput.length > MAX_RAW_LENGTH ? rawInput.slice(0, MAX_RAW_LENGTH) : rawInput,
    activeView: isActiveView(value.activeView) ? value.activeView : 'overview',
    expandedFields: sanitizeExpandedFields(value.expandedFields),
    packet: sanitizePacket(value.packet),
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0
  };
}

function emptyStore(): SnapshotStore {
  return { version: 2, snapshots: {} };
}

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* 忽略：存储不可用时保持页面可用 */
  }
}

/** 旧版单份全局状态 → 按协议与场景键控的快照 */
function migrateLegacy(store: SnapshotStore): boolean {
  const legacyRaw = safeGet(LEGACY_STORE_KEY);
  if (legacyRaw === null) return false;
  safeRemove(LEGACY_STORE_KEY);
  try {
    const legacy: unknown = JSON.parse(legacyRaw);
    if (!isRecord(legacy) || !isProtocol(legacy.protocol) || !isScenario(legacy.scenario)) return false;
    const key = snapshotKey(legacy.protocol, legacy.scenario);
    const migrated = sanitizeSnapshot(key, legacy);
    if (!migrated) return false;
    const existing = store.snapshots[key];
    if (!existing || existing.updatedAt <= migrated.updatedAt) {
      store.snapshots[key] = migrated;
    }
    return true;
  } catch {
    return false;
  }
}

/** 超出数量上限时按 updatedAt 逐条淘汰最旧快照 */
function evictOverflow(store: SnapshotStore): boolean {
  const keys = Object.keys(store.snapshots);
  if (keys.length <= MAX_SNAPSHOTS) return false;
  keys
    .sort((a, b) => (store.snapshots[a].updatedAt ?? 0) - (store.snapshots[b].updatedAt ?? 0))
    .slice(0, keys.length - MAX_SNAPSHOTS)
    .forEach((key) => {
      delete store.snapshots[key];
    });
  return true;
}

/**
 * 读取整份快照存储。整体 JSON 损坏时返回空存储（页面正常启动），
 * 单条损坏时仅淘汰该条，其余快照不受影响。
 */
function readStore(): SnapshotStore {
  const store = emptyStore();
  const raw = safeGet(STORE_KEY);
  let dirty = false;
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && isRecord(parsed.snapshots)) {
        for (const [key, value] of Object.entries(parsed.snapshots)) {
          const snapshot = sanitizeSnapshot(key, value);
          if (snapshot) {
            store.snapshots[key] = snapshot;
          } else {
            dirty = true; // 淘汰损坏条目
          }
        }
      } else {
        dirty = true;
      }
    } catch {
      dirty = true; // 整体损坏：从空存储重新开始，不白屏
    }
  }
  if (migrateLegacy(store)) dirty = true;
  if (evictOverflow(store)) dirty = true;
  if (dirty) writeStore(store);
  return store;
}

/** 写入存储；配额不足时逐条淘汰最旧快照重试，最终失败也不影响页面 */
function writeStore(store: SnapshotStore): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (safeSet(STORE_KEY, JSON.stringify(store))) return;
    const keys = Object.keys(store.snapshots);
    if (!keys.length) return;
    const oldest = keys.reduce((a, b) =>
      (store.snapshots[a].updatedAt ?? 0) <= (store.snapshots[b].updatedAt ?? 0) ? a : b
    );
    delete store.snapshots[oldest];
  }
}

/** 读取指定协议 + 场景组合的快照，不存在或已损坏时返回 null */
export function loadSnapshot(protocol: Protocol, scenario: PacketScenario): WorkspaceSnapshot | null {
  const store = readStore();
  return store.snapshots[snapshotKey(protocol, scenario)] ?? null;
}

/**
 * 保存一份快照。写入前重新读取最新存储，仅覆盖自己的键，
 * 因此多个标签页并发写入时按快照键合并，互不丢数据。
 */
export function saveSnapshot(snapshot: WorkspaceSnapshot): void {
  const store = readStore();
  store.snapshots[snapshotKey(snapshot.protocol, snapshot.scenario)] = snapshot;
  evictOverflow(store);
  writeStore(store);
}

/** 仅清空指定组合的快照，其他协议 / 场景的内容不受影响 */
export function clearSnapshot(protocol: Protocol, scenario: PacketScenario): void {
  const store = readStore();
  const key = snapshotKey(protocol, scenario);
  if (!(key in store.snapshots)) return;
  delete store.snapshots[key];
  writeStore(store);
}
