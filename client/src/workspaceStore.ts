import type {
  HexRow,
  PacketScenario,
  Protocol,
  ProtocolField,
  SimulatedPacket,
  TimelineEvent
} from '../../shared/types';

/**
 * 按「协议 × 场景」隔离的工作区快照存储。
 *
 * 存储桶 packet-lab:workspaces:v2 一次装下所有组合的快照，多标签页之间
 * 通过 storage 事件按快照键做 last-writer-wins 合并；每次写入前都会先与
 * 磁盘上的最新桶重新合并，避免整桶覆盖。
 *
 * 旧版本只有一份全局状态（packet-lab:workspace / :v1），首次加载时迁移成
 * 当前活动组合对应的单个快照。
 */

export type ActiveView = 'overview' | 'hex';

export type ComboKey =
  | 'HTTP:request'
  | 'HTTP:response'
  | 'TCP:handshake'
  | 'TCP:request'
  | 'TCP:response';

export interface WorkspaceSnapshot {
  /** 最近一次输入 */
  rawInput: string;
  /** 活动视图：字段树 / 十六进制 */
  activeView: ActiveView;
  /** 被折叠的字段 id（默认展开，只记录折叠项） */
  collapsedFields: string[];
  /** 最后一次成功解析的结果 */
  packet: SimulatedPacket | null;
  updatedAt: number;
}

/** 写入时由调用方提供的部分（updatedAt 由存储层生成）。 */
export type WorkspaceSnapshotData = Omit<WorkspaceSnapshot, 'updatedAt'>;

export interface PersistResult {
  /** false 表示存储不可用或配额耗尽后仍无法写入（应用继续在内存中工作）。 */
  ok: boolean;
  /** true 表示当前快照被降级（丢弃解析结果 / 展开态 / 截断输入）。 */
  shrunk: boolean;
  /** 为腾出配额而被整体淘汰的其他快照键。 */
  evicted: ComboKey[];
  updatedAt: number;
}

interface WorkspaceStoreV2 {
  version: 2;
  activeKey: ComboKey | null;
  snapshots: Partial<Record<ComboKey, WorkspaceSnapshot>>;
  /** 被清空的键及其时间戳，防止其他标签页合并时用旧数据复活。 */
  tombstones: Partial<Record<ComboKey, number>>;
}

const STORE_KEY = 'packet-lab:workspaces:v2';
const LEGACY_KEYS = ['packet-lab:workspace:v1', 'packet-lab:workspace'];

const DEFAULT_KEY: ComboKey = 'HTTP:request';
const VALID_KEYS = new Set<ComboKey>([
  'HTTP:request',
  'HTTP:response',
  'TCP:handshake',
  'TCP:request',
  'TCP:response'
]);

// —— 大小约束：超限时逐项降级，而不是让整条存储报废 ——
const MAX_RAW_INPUT_CHARS = 64 * 1024;
const MAX_PACKET_CHARS = 256 * 1024;
const MAX_COLLAPSED_FIELDS = 512;
const MAX_SNAPSHOT_CHARS = 360 * 1024;
const MAX_STORE_CHARS = 4 * 1024 * 1024;
const MAX_SNAPSHOTS = 32;
const MAX_TOMBSTONES = 32;

const TIMELINE_PHASES: ReadonlySet<TimelineEvent['phase']> = new Set([
  'ingress',
  'parse',
  'transport',
  'application',
  'egress'
]);

// —— localStorage 访问：隐私模式 / 配额异常一律不抛出 ——

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* 某些浏览器在隐私模式下访问 localStorage 会直接抛错 */
  }
  return null;
}

function safeGetItem(key: string): string | null {
  try {
    return getStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): boolean {
  try {
    getStorage()?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemoveItem(key: string): void {
  try {
    getStorage()?.removeItem(key);
  } catch {
    /* ignore */
  }
}

function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

// —— 解析结果消毒：磁盘上的数据可能被任意篡改，渲染路径必须拿到结构合法的值 ——

function sanitizeFields(value: unknown, depth = 0): ProtocolField[] {
  if (depth > 8 || !Array.isArray(value)) return [];
  const fields: ProtocolField[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) continue;
    const node: ProtocolField = {
      id: asString(item.id, `field-${depth}-${index}`) || `field-${depth}-${index}`,
      key: asString(item.key, '—') || '—',
      value: asString(item.value, '—') || '—',
      description: asString(item.description, '')
    };
    const children = sanitizeFields(item.children, depth + 1);
    if (children.length) node.children = children;
    fields.push(node);
  }
  return fields;
}

function sanitizeHex(value: unknown): HexRow[] {
  if (!Array.isArray(value)) return [];
  const rows: HexRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const bytes = Array.isArray(item.bytes)
      ? item.bytes.filter((byte): byte is string => typeof byte === 'string').slice(0, 16)
      : [];
    rows.push({
      offset: asString(item.offset, '----'),
      bytes,
      ascii: asString(item.ascii, '')
    });
  }
  return rows;
}

function sanitizeTimeline(value: unknown): TimelineEvent[] {
  if (!Array.isArray(value)) return [];
  const events: TimelineEvent[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) continue;
    const phase = item.phase;
    events.push({
      id: asString(item.id, `event-${index}`) || `event-${index}`,
      timestamp: asString(item.timestamp, '—'),
      label: asString(item.label, 'Event'),
      phase: typeof phase === 'string' && TIMELINE_PHASES.has(phase as TimelineEvent['phase'])
        ? (phase as TimelineEvent['phase'])
        : 'parse',
      detail: asString(item.detail, '')
    });
  }
  return events;
}

function sanitizePacket(value: unknown): SimulatedPacket | null {
  if (!isRecord(value)) return null;
  const protocol = value.protocol === 'TCP' ? 'TCP' : value.protocol === 'HTTP' ? 'HTTP' : null;
  if (!protocol) return null;
  const scenario: PacketScenario =
    value.scenario === 'request' || value.scenario === 'response' || value.scenario === 'handshake'
      ? value.scenario
      : 'request';
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  return {
    id: asString(value.id, 'restored-packet') || 'restored-packet',
    protocol,
    scenario,
    summary: asString(value.summary, 'Restored packet'),
    raw: asString(value.raw, ''),
    hex: sanitizeHex(value.hex),
    fields: sanitizeFields(value.fields),
    timeline: sanitizeTimeline(value.timeline),
    metadata: {
      capturedAt: asString(metadata.capturedAt, '—'),
      source: asString(metadata.source, '—'),
      destination: asString(metadata.destination, '—'),
      length: typeof metadata.length === 'number' && Number.isFinite(metadata.length)
        ? metadata.length
        : 0,
      checksum: asString(metadata.checksum, '—')
    }
  };
}

// —— 组合键 ——

export function snapshotKey(protocol: Protocol, scenario: PacketScenario): ComboKey {
  // HTTP 没有 handshake 场景，归一化到 request，避免水合出 UI 无法表达的组合。
  if (protocol === 'HTTP' && scenario === 'handshake') return 'HTTP:request';
  return `${protocol}:${scenario}` as ComboKey;
}

export function comboFromKey(key: string): { protocol: Protocol; scenario: PacketScenario } {
  const [protocol, scenario] = key.split(':');
  if (
    (protocol === 'HTTP' || protocol === 'TCP') &&
    (scenario === 'request' || scenario === 'response' || scenario === 'handshake') &&
    !(protocol === 'HTTP' && scenario === 'handshake')
  ) {
    return { protocol, scenario };
  }
  return { protocol: 'HTTP', scenario: 'request' };
}

function isValidKey(key: string): key is ComboKey {
  return VALID_KEYS.has(key as ComboKey);
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 对单条快照做大小约束；返回 null 表示无法保留，调用方应淘汰该条。 */
function enforceSnapshotLimits(snapshot: WorkspaceSnapshot): WorkspaceSnapshot | null {
  const result: WorkspaceSnapshot = { ...snapshot };
  if (result.rawInput.length > MAX_RAW_INPUT_CHARS) {
    result.rawInput = result.rawInput.slice(0, MAX_RAW_INPUT_CHARS);
  }
  if (result.collapsedFields.length > MAX_COLLAPSED_FIELDS) {
    result.collapsedFields = result.collapsedFields.slice(0, MAX_COLLAPSED_FIELDS);
  }
  if (result.packet && jsonSize(result.packet) > MAX_PACKET_CHARS) {
    result.packet = null;
  }
  // 仍然超总限时逐项降级：解析结果 → 展开状态 → 输入 → 整条淘汰。
  while (jsonSize(result) > MAX_SNAPSHOT_CHARS) {
    if (result.packet) {
      result.packet = null;
      continue;
    }
    if (result.collapsedFields.length) {
      result.collapsedFields = [];
      continue;
    }
    if (result.rawInput.length) {
      result.rawInput = result.rawInput.slice(
        0,
        Math.min(1024, Math.floor(result.rawInput.length / 2))
      );
      continue;
    }
    return null;
  }
  return result;
}

function sanitizeSnapshot(key: string, value: unknown): WorkspaceSnapshot | null {
  if (!isValidKey(key) || !isRecord(value)) return null;
  const rawInput = typeof value.rawInput === 'string' ? value.rawInput : '';
  const activeView: ActiveView = value.activeView === 'hex' ? 'hex' : 'overview';
  const collapsedFields = Array.isArray(value.collapsedFields)
    ? value.collapsedFields.filter((item): item is string => typeof item === 'string')
    : [];
  const updatedAt = toFiniteNumber(value.updatedAt) ?? 0;
  const bounded = enforceSnapshotLimits({
    rawInput,
    activeView,
    collapsedFields,
    packet: sanitizePacket(value.packet),
    updatedAt
  });
  return bounded;
}

function createEmptyStore(): WorkspaceStoreV2 {
  return { version: 2, activeKey: null, snapshots: {}, tombstones: {} };
}

function pruneTombstones(target: WorkspaceStoreV2): void {
  const entries = Object.entries(target.tombstones) as [ComboKey, number][];
  if (entries.length <= MAX_TOMBSTONES) return;
  entries.sort((a, b) => b[1] - a[1]);
  target.tombstones = Object.fromEntries(entries.slice(0, MAX_TOMBSTONES)) as WorkspaceStoreV2['tombstones'];
}

function parseStore(raw: string): WorkspaceStoreV2 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 2 || !isRecord(parsed.snapshots)) return null;

  // 逐条校验：某一条损坏或超限只淘汰该条，其余照常恢复。
  const snapshots: Partial<Record<ComboKey, WorkspaceSnapshot>> = {};
  for (const [key, entry] of Object.entries(parsed.snapshots)) {
    const snapshot = sanitizeSnapshot(key, entry);
    if (snapshot) snapshots[key as ComboKey] = snapshot;
  }

  const tombstones: Partial<Record<ComboKey, number>> = {};
  if (isRecord(parsed.tombstones)) {
    for (const [key, at] of Object.entries(parsed.tombstones)) {
      if (isValidKey(key)) {
        const time = toFiniteNumber(at);
        if (time !== null) tombstones[key] = time;
      }
    }
  }

  const activeKey =
    typeof parsed.activeKey === 'string' && isValidKey(parsed.activeKey)
      ? parsed.activeKey
      : null;

  return { version: 2, activeKey, snapshots, tombstones };
}

/** 旧的单份全局存储 → 单键快照迁移。 */
function legacyToStore(raw: string): WorkspaceStoreV2 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  // 兼容 { version: 1, state: {...} } 包装与裸状态两种写法。
  const body = isRecord(parsed.state) ? parsed.state : parsed;

  const protocol: Protocol = body.protocol === 'TCP' ? 'TCP' : 'HTTP';
  const scenario: PacketScenario =
    body.scenario === 'request' || body.scenario === 'response' || body.scenario === 'handshake'
      ? body.scenario
      : 'request';
  const key = snapshotKey(protocol, scenario);

  const rawInput =
    typeof body.rawInput === 'string'
      ? body.rawInput
      : typeof body.input === 'string'
        ? body.input
        : '';
  const activeView: ActiveView =
    body.activeView === 'hex' || body.view === 'hex' ? 'hex' : 'overview';
  const collapsedFields = Array.isArray(body.collapsedFields)
    ? body.collapsedFields.filter((item): item is string => typeof item === 'string')
    : [];
  const packetSource = 'packet' in body ? body.packet : ('lastPacket' in body ? body.lastPacket : body.result);
  const updatedAt =
    toFiniteNumber(body.updatedAt) ??
    toFiniteNumber(body.savedAt) ??
    toFiniteNumber(body.timestamp) ??
    Date.now();

  const snapshot = enforceSnapshotLimits({
    rawInput,
    activeView,
    collapsedFields,
    packet: sanitizePacket(packetSource),
    updatedAt
  });
  if (!snapshot) return null;
  return { version: 2, activeKey: key, snapshots: { [key]: snapshot }, tombstones: {} };
}

function migrateLegacyStore(): WorkspaceStoreV2 | null {
  for (const legacyKey of LEGACY_KEYS) {
    const raw = safeGetItem(legacyKey);
    if (!raw) continue;
    const migrated = legacyToStore(raw);
    if (migrated) {
      // 迁移成功后移除所有旧键；失败则保留，下一次启动还能再试。
      for (const key of LEGACY_KEYS) safeRemoveItem(key);
      return migrated;
    }
  }
  return null;
}

// —— 内存态与合并 ——

let store: WorkspaceStoreV2 = createEmptyStore();
let storeLoaded = false;
let storeVersion = 0;
let changedKeys: ComboKey[] = [];
const listeners = new Set<() => void>();

function emitChange(): void {
  storeVersion += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* 订阅方异常不能影响存储流程 */
    }
  }
}

function pruneSnapshotCount(): void {
  const entries = Object.entries(store.snapshots) as [ComboKey, WorkspaceSnapshot][];
  if (entries.length <= MAX_SNAPSHOTS) return;
  entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [key] of entries.slice(0, entries.length - MAX_SNAPSHOTS)) {
    delete store.snapshots[key];
  }
}

/**
 * 按快照键合并两个桶：同键取 updatedAt 更大者；tombstone 时间戳更新或更新
 * 的快照可以否决对方，保证「清空」不会被旧标签页的写入复活。
 */
function mergeStores(a: WorkspaceStoreV2, b: WorkspaceStoreV2): WorkspaceStoreV2 {
  const snapshots: Partial<Record<ComboKey, WorkspaceSnapshot>> = { ...a.snapshots };
  const tombstones: Partial<Record<ComboKey, number>> = { ...a.tombstones };

  for (const [key, at] of Object.entries(b.tombstones) as [ComboKey, number][]) {
    tombstones[key] = Math.max(tombstones[key] ?? 0, at);
  }
  for (const [key, incoming] of Object.entries(b.snapshots) as [ComboKey, WorkspaceSnapshot][]) {
    const tombstoneAt = tombstones[key] ?? 0;
    if (incoming.updatedAt <= tombstoneAt) {
      delete snapshots[key];
      continue;
    }
    const current = snapshots[key];
    if (!current || incoming.updatedAt >= current.updatedAt) {
      snapshots[key] = incoming;
    }
  }
  for (const [key, snapshot] of Object.entries(snapshots) as [ComboKey, WorkspaceSnapshot][]) {
    if (snapshot.updatedAt <= (tombstones[key] ?? 0)) delete snapshots[key];
  }

  // 活动选择只在启动时读取，各标签页保留自己的选择，不互相覆盖。
  return { version: 2, activeKey: a.activeKey ?? b.activeKey, snapshots, tombstones };
}

function cloneStore(source: WorkspaceStoreV2): WorkspaceStoreV2 {
  return JSON.parse(JSON.stringify(source)) as WorkspaceStoreV2;
}

/** 写入前与磁盘上的最新桶重新合并（read-merge-write）。 */
function rebaseOnDisk(): void {
  const raw = safeGetItem(STORE_KEY);
  if (!raw) return;
  const parsed = parseStore(raw);
  if (parsed) store = mergeStores(store, parsed);
  // 磁盘内容损坏时不并入内存态，本次写入会顺带修复它。
}

function evictOldestFrom(
  target: WorkspaceStoreV2,
  protectKey: ComboKey | undefined,
  evicted: ComboKey[]
): boolean {
  let oldest: ComboKey | null = null;
  for (const key of Object.keys(target.snapshots) as ComboKey[]) {
    if (protectKey && key === protectKey) continue;
    const current = target.snapshots[key];
    const winner = oldest ? target.snapshots[oldest] : null;
    if (current && (!winner || current.updatedAt < winner.updatedAt)) oldest = key;
  }
  if (!oldest) return false;
  delete target.snapshots[oldest];
  target.tombstones[oldest] = Date.now();
  pruneTombstones(target);
  evicted.push(oldest);
  return true;
}

/** 对受保护快照做一次降级，返回 false 表示已无可降级项。 */
function shrinkSnapshot(snapshot: WorkspaceSnapshot): boolean {
  if (snapshot.packet) {
    snapshot.packet = null;
    return true;
  }
  if (snapshot.collapsedFields.length) {
    snapshot.collapsedFields = [];
    return true;
  }
  if (snapshot.rawInput.length) {
    snapshot.rawInput = snapshot.rawInput.slice(
      0,
      Math.min(1024, Math.floor(snapshot.rawInput.length / 2))
    );
    return true;
  }
  return false;
}

function commitStore(protectKey: ComboKey | undefined): PersistResult {
  const evicted: ComboKey[] = [];
  let shrunk = false;

  // 所有淘汰 / 降级先在草稿上尝试；写盘成功才提交到内存态，这样存储完全
  // 不可用时用户的当前工作区不会在内存中被连带破坏。
  let draft: WorkspaceStoreV2 = cloneStore(store);
  while (jsonSize(draft) > MAX_STORE_CHARS && evictOldestFrom(draft, protectKey, evicted)) {
    /* continue */
  }

  let ok = safeSetItem(STORE_KEY, JSON.stringify(draft));
  while (!ok) {
    // 配额失败：先淘汰其他场景的最旧快照，最后才降级当前场景。
    if (evictOldestFrom(draft, protectKey, evicted)) {
      ok = safeSetItem(STORE_KEY, JSON.stringify(draft));
      continue;
    }
    const protectedSnapshot = protectKey ? draft.snapshots[protectKey] : null;
    if (protectedSnapshot && shrinkSnapshot(protectedSnapshot)) {
      shrunk = true;
      ok = safeSetItem(STORE_KEY, JSON.stringify(draft));
      continue;
    }
    break;
  }

  if (ok) {
    store = draft;
    return { ok, shrunk, evicted, updatedAt: 0 };
  }
  // 写盘失败：内存态保持完整，本次只放弃持久化。
  return { ok: false, shrunk: false, evicted: [], updatedAt: 0 };
}

// —— 对外 API ——

export function loadStore(): void {
  if (storeLoaded) return;
  storeLoaded = true;

  const raw = safeGetItem(STORE_KEY);
  if (raw) {
    const parsed = parseStore(raw);
    if (parsed) {
      store = parsed;
      // v2 已建立，历史遗留的单份存储不再需要。
      for (const key of LEGACY_KEYS) safeRemoveItem(key);
      pruneTombstones(store);
      return;
    }
    // v2 桶整体损坏：不要白屏，尝试旧格式迁移，否则从空桶开始。
  }

  store = migrateLegacyStore() ?? createEmptyStore();
  pruneTombstones(store);
  commitStore(store.activeKey ?? undefined);
}

export function getActiveKey(): ComboKey {
  loadStore();
  return store.activeKey && isValidKey(store.activeKey) ? store.activeKey : DEFAULT_KEY;
}

export function setActiveKey(key: ComboKey): void {
  loadStore();
  rebaseOnDisk();
  if (store.activeKey === key) return;
  store.activeKey = key;
  commitStore(key);
}

export function getSnapshot(key: ComboKey): WorkspaceSnapshot | null {
  loadStore();
  return store.snapshots[key] ?? null;
}

export function persistWorkspace(key: ComboKey, data: WorkspaceSnapshotData): PersistResult {
  loadStore();
  rebaseOnDisk();

  const collapsedFields = Array.from(new Set(data.collapsedFields)).slice(0, MAX_COLLAPSED_FIELDS);
  const snapshot: WorkspaceSnapshot = {
    rawInput: typeof data.rawInput === 'string' ? data.rawInput.slice(0, MAX_RAW_INPUT_CHARS) : '',
    activeView: data.activeView === 'hex' ? 'hex' : 'overview',
    collapsedFields,
    packet: data.packet ? sanitizePacket(data.packet) : null,
    updatedAt: Date.now()
  };

  store.snapshots[key] = snapshot;
  delete store.tombstones[key];
  pruneSnapshotCount();

  const result = commitStore(key);
  changedKeys = [key, ...result.evicted];
  emitChange();
  return { ...result, updatedAt: snapshot.updatedAt };
}

/** 只清空指定组合；其他组合的快照原样保留。 */
export function clearWorkspace(key: ComboKey): void {
  loadStore();
  rebaseOnDisk();
  if (!(key in store.snapshots) && (store.tombstones[key] ?? 0) > 0) {
    changedKeys = [key];
    emitChange();
    return;
  }
  delete store.snapshots[key];
  store.tombstones[key] = Date.now();
  pruneTombstones(store);
  commitStore(undefined);
  changedKeys = [key];
  emitChange();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLastChangedKeys(): ComboKey[] {
  return changedKeys;
}

// —— 多标签页：其他标签页写入后按快照键并入内存态 ——

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key && event.key !== STORE_KEY) return; // event.key === null 表示整库被清空
    if (!storeLoaded) {
      loadStore();
      changedKeys = Object.keys(store.snapshots) as ComboKey[];
      if (changedKeys.length) emitChange();
      return;
    }

    const before = new Map(
      (Object.keys(store.snapshots) as ComboKey[]).map((key) => [
        key,
        store.snapshots[key]?.updatedAt ?? 0
      ])
    );

    const raw = safeGetItem(STORE_KEY);
    const parsed = raw ? parseStore(raw) : null;
    if (parsed) store = mergeStores(store, parsed);
    // 整库被外部清空时保留本标签页内存中的内容，绝不连带删除用户工作区。

    const diff: ComboKey[] = [];
    const allKeys = new Set<ComboKey>([
      ...before.keys(),
      ...(Object.keys(store.snapshots) as ComboKey[])
    ]);
    for (const key of allKeys) {
      if ((before.get(key) ?? 0) !== (store.snapshots[key]?.updatedAt ?? 0)) diff.push(key);
    }
    changedKeys = diff;
    if (diff.length) emitChange();
  });
}
