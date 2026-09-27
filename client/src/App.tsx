import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  PacketScenario,
  ParseRequest,
  Protocol,
  ProtocolField,
  SimulatedPacket,
  TimelineEvent
} from '../../shared/types';
import {
  clearWorkspace,
  comboFromKey,
  getActiveKey,
  getLastChangedKeys,
  getSnapshot,
  persistWorkspace,
  setActiveKey,
  snapshotKey,
  subscribe,
  type ActiveView,
  type PersistResult,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotData
} from './workspaceStore';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';
const SAVE_DEBOUNCE_MS = 400;

const scenarioLabels: Record<PacketScenario, string> = {
  request: '请求 / Request',
  response: '响应 / Response',
  handshake: '握手 / Handshake'
};

function scenariosFor(protocol: Protocol): PacketScenario[] {
  return protocol === 'TCP' ? ['handshake', 'request', 'response'] : ['request', 'response'];
}

function defaultScenarioFor(protocol: Protocol): PacketScenario {
  return protocol === 'TCP' ? 'handshake' : 'request';
}

function sameSnapshot(snapshot: WorkspaceSnapshot | null, data: WorkspaceSnapshotData): boolean {
  return Boolean(
    snapshot &&
      snapshot.rawInput === data.rawInput &&
      snapshot.activeView === data.activeView &&
      snapshot.collapsedFields.length === data.collapsedFields.length &&
      snapshot.collapsedFields.every((id, index) => id === data.collapsedFields[index]) &&
      (snapshot.packet?.id ?? null) === (data.packet?.id ?? null)
  );
}

function App() {
  // 启动时只确定用户当前选择的组合；其他快照保存在磁盘上，切换到了才水合。
  const [bootCombo] = useState(() => comboFromKey(getActiveKey()));
  const [protocol, setProtocol] = useState<Protocol>(bootCombo.protocol);
  const [scenario, setScenario] = useState<PacketScenario>(bootCombo.scenario);
  const [rawInput, setRawInput] = useState('');
  const [packet, setPacket] = useState<SimulatedPacket | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState<ActiveView>('overview');
  const [collapsedFields, setCollapsedFields] = useState<string[]>([]);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const [storageNotice, setStorageNotice] = useState('');

  // 异步请求回调与落盘计时器需要读到最新值，用 ref 在渲染间镜像状态。
  const protocolRef = useRef(protocol);
  const scenarioRef = useRef(scenario);
  const latestRef = useRef({ rawInput, activeView, collapsedFields, packet });
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);
  const lastSeenRef = useRef(0);
  const localClearRef = useRef<string | null>(null);

  useEffect(() => {
    protocolRef.current = protocol;
    scenarioRef.current = scenario;
    latestRef.current = { rawInput, activeView, collapsedFields, packet };
  });

  const availableScenarios = useMemo(() => scenariosFor(protocol), [protocol]);

  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${API_BASE}${path}`, init);
    if (!response.ok) throw new Error(`API 请求失败：${response.status}`);
    return response.json() as Promise<{ data: SimulatedPacket }>;
  };

  const loadSample = async (
    nextProtocol: Protocol = protocolRef.current,
    nextScenario: PacketScenario = scenarioRef.current
  ) => {
    const targetKey = snapshotKey(nextProtocol, nextScenario);
    setLoading(true);
    setError('');
    try {
      const result = await request(
        `/api/simulate?protocol=${nextProtocol}&scenario=${nextScenario}`
      );
      // 响应返回前用户可能已经切换组合，过期结果不能写进当前工作区。
      if (snapshotKey(protocolRef.current, scenarioRef.current) !== targetKey) return;
      setPacket(result.data);
      setRawInput(result.data.raw);
    } catch (cause) {
      if (snapshotKey(protocolRef.current, scenarioRef.current) !== targetKey) return;
      setError(cause instanceof Error ? cause.message : '加载模拟数据失败');
    } finally {
      setLoading(false);
    }
  };

  const parsePacket = async () => {
    const targetKey = snapshotKey(protocol, scenario);
    setLoading(true);
    setError('');
    const body: ParseRequest = { protocol, scenario, raw: rawInput };
    try {
      const result = await request('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (snapshotKey(protocolRef.current, scenarioRef.current) !== targetKey) return;
      setPacket(result.data);
      setRawInput(result.data.raw);
    } catch (cause) {
      if (snapshotKey(protocolRef.current, scenarioRef.current) !== targetKey) return;
      setError(cause instanceof Error ? cause.message : '解析数据包失败');
    } finally {
      setLoading(false);
    }
  };

  const reportPersistResult = useCallback((result: PersistResult) => {
    if (!result.ok) {
      setStorageNotice('浏览器本地存储不可用或配额已满，最近的修改只在本次会话中保留。');
    } else if (result.evicted.length) {
      setStorageNotice(`存储空间不足，已按时间淘汰 ${result.evicted.length} 个其他场景的旧快照。`);
    } else if (result.shrunk) {
      setStorageNotice('当前快照过大，已丢弃解析结果等次要字段以完成保存。');
    }
  }, []);

  // 切换标签页 / 页面隐藏前立即把待写内容刷盘。
  const flushPendingSave = useCallback(() => {
    if (!dirtyRef.current) return;
    const key = snapshotKey(protocolRef.current, scenarioRef.current);
    const { rawInput: raw, activeView: view, collapsedFields: collapsed, packet: currentPacket } =
      latestRef.current;
    dirtyRef.current = false;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const result = persistWorkspace(key, {
      rawInput: raw,
      activeView: view,
      collapsedFields: collapsed,
      packet: currentPacket
    });
    lastSeenRef.current = result.updatedAt;
    reportPersistResult(result);
  }, [reportPersistResult]);

  // 组合切换（或首次挂载）：有快照就恢复，没有则载入该组合的模拟包。
  useEffect(() => {
    const key = snapshotKey(protocol, scenario);
    setActiveKey(key);
    const saved = getSnapshot(key);
    lastSeenRef.current = saved?.updatedAt ?? 0;
    if (saved) {
      setRawInput(saved.rawInput);
      setActiveView(saved.activeView);
      setCollapsedFields(saved.collapsedFields);
      setPacket(saved.packet);
    } else {
      setRawInput('');
      setActiveView('overview');
      setCollapsedFields([]);
      setPacket(null);
      void loadSample(protocol, scenario);
    }
    setHydratedKey(key);
    // 仅在协议/场景变化时运行；loadSample 是组件内闭包。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protocol, scenario]);

  // 状态变化后防抖写入当前组合的快照。
  useEffect(() => {
    const key = snapshotKey(protocol, scenario);
    if (!hydratedKey || hydratedKey !== key) return;
    const data: WorkspaceSnapshotData = { rawInput, activeView, collapsedFields, packet };
    if (sameSnapshot(getSnapshot(key), data)) {
      const existing = getSnapshot(key);
      if (existing) lastSeenRef.current = existing.updatedAt;
      return;
    }
    dirtyRef.current = true;
    const timer = setTimeout(() => {
      dirtyRef.current = false;
      const result = persistWorkspace(key, data);
      lastSeenRef.current = result.updatedAt;
      reportPersistResult(result);
    }, SAVE_DEBOUNCE_MS);
    saveTimerRef.current = timer;
    return () => clearTimeout(timer);
  }, [hydratedKey, protocol, scenario, rawInput, activeView, collapsedFields, packet, reportPersistResult]);

  // 页面隐藏 / 卸载前刷盘。
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushPendingSave();
    };
    window.addEventListener('pagehide', flushPendingSave);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushPendingSave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [flushPendingSave]);

  // 多标签页同步：存储变化后按当前快照键水合，本地有未保存输入时不打断。
  useEffect(() => subscribe(() => {
    const key = snapshotKey(protocolRef.current, scenarioRef.current);
    if (!getLastChangedKeys().includes(key)) return;
    if (localClearRef.current === key) {
      localClearRef.current = null;
      return;
    }
    if (dirtyRef.current) return;
    const saved = getSnapshot(key);
    if (!saved) {
      // 其他标签页重置了本场景：跟随重置并重新载入模拟包。
      setRawInput('');
      setActiveView('overview');
      setCollapsedFields([]);
      setPacket(null);
      lastSeenRef.current = 0;
      setHydratedKey(key);
      void loadSample();
      return;
    }
    if (saved.updatedAt === lastSeenRef.current) return;
    setRawInput(saved.rawInput);
    setActiveView(saved.activeView);
    setCollapsedFields(saved.collapsedFields);
    setPacket(saved.packet);
    lastSeenRef.current = saved.updatedAt;
    setHydratedKey(key);
  }), []);

  const changeProtocol = (nextProtocol: Protocol) => {
    flushPendingSave();
    const nextScenario = scenariosFor(nextProtocol).includes(scenario)
      ? scenario
      : defaultScenarioFor(nextProtocol);
    setProtocol(nextProtocol);
    setScenario(nextScenario);
  };

  const changeScenario = (nextScenario: PacketScenario) => {
    flushPendingSave();
    setScenario(nextScenario);
  };

  const toggleField = (id: string) => {
    setCollapsedFields((previous) =>
      previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]
    );
  };

  // 只清空当前组合的快照与工作区，其他组合不受影响。
  const resetScenario = () => {
    const key = snapshotKey(protocol, scenario);
    dirtyRef.current = false;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    localClearRef.current = key;
    clearWorkspace(key);
    setRawInput('');
    setActiveView('overview');
    setCollapsedFields([]);
    setPacket(null);
    lastSeenRef.current = 0;
    setHydratedKey(key);
    void loadSample(protocol, scenario);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /> <span /> <span /></div>
          <div>
            <p className="eyebrow">PROJECT 10 / PACKET OBSERVATORY</p>
            <h1>网络协议数据包可视化实验室</h1>
          </div>
        </div>
        <div className="connection-status"><i /> API ONLINE <span>localhost:3001</span></div>
      </header>

      <main className="dashboard">
        <section className="hero-copy">
          <div>
            <p className="section-kicker">解析工作台 · INSPECTOR</p>
            <h2>把每一个字节，<em>还原成可读的网络故事。</em></h2>
            <p className="hero-subtitle">选择协议和场景，载入模拟流量，逐层查看字段、时间线与十六进制原始数据。输入、视图与展开状态按场景独立保存。</p>
          </div>
          <div className="hero-stat"><strong>{packet?.metadata.length ?? '—'}</strong><span>BYTES<br />CURRENT FRAME</span></div>
        </section>

        <section className="control-panel panel">
          <div className="control-group">
            <label>协议 <span>PROTOCOL</span></label>
            <div className="segmented-control">
              {(['HTTP', 'TCP'] as Protocol[]).map((item) => (
                <button key={item} className={protocol === item ? 'active' : ''} onClick={() => changeProtocol(item)}>{item}</button>
              ))}
            </div>
          </div>
          <div className="control-group scenario-control">
            <label>模拟场景 <span>SCENARIO</span></label>
            <select value={scenario} onChange={(event) => changeScenario(event.target.value as PacketScenario)}>
              {availableScenarios.map((item) => <option key={item} value={item}>{scenarioLabels[item]}</option>)}
            </select>
          </div>
          <div className="control-actions">
            <button className="button ghost" onClick={() => void loadSample()} disabled={loading}>↻ 载入模拟包</button>
            <button className="button primary" onClick={() => void parsePacket()} disabled={loading || !rawInput.trim()}>{loading ? '处理中…' : '解析数据包 →'}</button>
          </div>
        </section>

        {error && <div className="error-banner">⚠ {error} <button onClick={() => setError('')}>关闭</button></div>}
        {storageNotice && <div className="storage-notice">⌛ {storageNotice} <button onClick={() => setStorageNotice('')}>关闭</button></div>}

        <section className="workspace-grid">
          <div className="left-column">
            <div className="panel packet-input-panel">
              <div className="panel-heading"><div><p className="section-kicker">01 / INPUT STREAM</p><h3>数据包输入</h3></div><span className="badge">{protocol} · {scenario}</span></div>
              <textarea value={rawInput} onChange={(event) => setRawInput(event.target.value)} spellCheck={false} aria-label="原始数据包输入" />
              <div className="input-footer"><span>{rawInput.length} chars · 工作区快照按 {protocol}:{scenario} 隔离</span><span className="footer-actions"><button onClick={() => setRawInput('')}>清空输入</button><button onClick={resetScenario} disabled={loading}>重置本场景</button></span></div>
            </div>
            <div className="panel timeline-panel">
              <div className="panel-heading"><div><p className="section-kicker">02 / EVENT TRACE</p><h3>传输时间线</h3></div><span className="trace-id">{packet?.id ?? 'WAITING'}</span></div>
              <Timeline events={packet?.timeline ?? []} />
            </div>
          </div>

          <div className="right-column">
            <div className="panel packet-summary">
              <div className="summary-top"><div><p className="section-kicker">ACTIVE FRAME</p><h3>{packet?.summary ?? '等待数据包'}</h3></div><div className="live-chip"><i /> DECODED</div></div>
              <div className="metadata-grid">
                <Meta label="SOURCE" value={packet?.metadata.source ?? '—'} />
                <Meta label="DESTINATION" value={packet?.metadata.destination ?? '—'} />
                <Meta label="CAPTURED AT" value={packet?.metadata.capturedAt ?? '—'} />
                <Meta label="CHECKSUM" value={packet?.metadata.checksum ?? '—'} />
              </div>
            </div>

            <div className="panel details-panel">
              <div className="tabs"><button className={activeView === 'overview' ? 'selected' : ''} onClick={() => setActiveView('overview')}>协议字段树</button><button className={activeView === 'hex' ? 'selected' : ''} onClick={() => setActiveView('hex')}>十六进制视图</button></div>
              {activeView === 'overview'
                ? <FieldTree fields={packet?.fields ?? []} collapsedFields={collapsedFields} onToggle={toggleField} />
                : <HexView rows={packet?.hex ?? []} />}
            </div>
          </div>
        </section>
      </main>
      <footer className="footer"><span>PACKET LAB / EDUCATIONAL SIMULATOR</span><span>React + Vite + TypeScript · Express API</span></footer>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div className="meta-item"><span>{label}</span><strong>{value}</strong></div>;
}

function FieldTree({
  fields,
  collapsedFields,
  onToggle
}: {
  fields: ProtocolField[];
  collapsedFields: string[];
  onToggle: (id: string) => void;
}) {
  if (!fields.length) return <div className="empty-state">解析后将在这里显示协议层级字段。</div>;
  const collapsedSet = new Set(collapsedFields);
  return <div className="field-tree">{fields.map((field) => <FieldNode key={field.id} field={field} depth={0} collapsedSet={collapsedSet} onToggle={onToggle} />)}</div>;
}

function FieldNode({
  field,
  depth,
  collapsedSet,
  onToggle
}: {
  field: ProtocolField;
  depth: number;
  collapsedSet: Set<string>;
  onToggle: (id: string) => void;
}) {
  const hasChildren = Boolean(field.children?.length);
  const expanded = !collapsedSet.has(field.id);
  return <div className="field-node" style={{ '--depth': depth } as CSSProperties}>
    <div className="field-row" onClick={() => hasChildren && onToggle(field.id)}>
      <span className={`chevron ${hasChildren ? '' : 'invisible'} ${expanded ? 'open' : ''}`}>⌄</span>
      <span className="field-key">{field.key}</span>
      <span className="field-value">{field.value}</span>
      <span className="field-description">{field.description}</span>
    </div>
    {hasChildren && expanded && <div className="field-children">{field.children?.map((child) => <FieldNode key={child.id} field={child} depth={depth + 1} collapsedSet={collapsedSet} onToggle={onToggle} />)}</div>}
  </div>;
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) return <div className="empty-state">还没有事件记录。</div>;
  return <div className="timeline">{events.map((event, index) => <div className="timeline-event" key={event.id}><div className="timeline-marker"><span>{String(index + 1).padStart(2, '0')}</span></div><div className="timeline-content"><div><strong>{event.label}</strong><time>{event.timestamp}</time></div><p>{event.detail}</p><span className={`phase phase-${event.phase}`}>{event.phase}</span></div></div>)}</div>;
}

function HexView({ rows }: { rows: SimulatedPacket['hex'] }) {
  if (!rows.length) return <div className="empty-state">没有可显示的十六进制内容。</div>;
  return <div className="hex-view"><div className="hex-header"><span>OFFSET</span><span>HEX BYTES</span><span>ASCII</span></div>{rows.map((row) => <div className="hex-row" key={row.offset}><code>{row.offset}</code><code>{row.bytes.join(' ')}</code><code className="ascii">{row.ascii}</code></div>)}</div>;
}

export default App;
