import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  PacketScenario,
  ParseRequest,
  Protocol,
  ProtocolField,
  SimulatedPacket,
  TimelineEvent
} from '../../shared/types';
import {
  clearSnapshot,
  loadSnapshot,
  saveSnapshot,
  snapshotKey,
  type ActiveView,
  type WorkspaceSnapshot
} from './workspaceSnapshots';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';

const scenarioLabels: Record<PacketScenario, string> = {
  request: '请求 / Request',
  response: '响应 / Response',
  handshake: '握手 / Handshake'
};

const DEFAULT_PROTOCOL: Protocol = 'HTTP';
const DEFAULT_SCENARIO: PacketScenario = 'request';

function App() {
  const [protocol, setProtocol] = useState<Protocol>(DEFAULT_PROTOCOL);
  const [scenario, setScenario] = useState<PacketScenario>(DEFAULT_SCENARIO);
  const [rawInput, setRawInput] = useState('');
  const [packet, setPacket] = useState<SimulatedPacket | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState<ActiveView>('overview');
  const [expandedFields, setExpandedFields] = useState<Record<string, boolean>>({});

  /** 完成启动恢复后置为 true，之后的 state 变化才会写入快照 */
  const hydratedRef = useRef(false);
  /** 当前选中的快照键，用于丢弃切换场景后迟到的响应，避免污染其他场景的快照 */
  const selectionRef = useRef(snapshotKey(DEFAULT_PROTOCOL, DEFAULT_SCENARIO));

  const availableScenarios = useMemo<PacketScenario[]>(
    () => (protocol === 'TCP' ? ['handshake', 'request', 'response'] : ['request', 'response']),
    [protocol]
  );

  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${API_BASE}${path}`, init);
    if (!response.ok) throw new Error(`API 请求失败：${response.status}`);
    return response.json() as Promise<{ data: SimulatedPacket }>;
  };

  const loadSample = async (nextProtocol = protocol, nextScenario = scenario) => {
    const targetKey = snapshotKey(nextProtocol, nextScenario);
    setLoading(true);
    setError('');
    try {
      const result = await request(
        `/api/simulate?protocol=${nextProtocol}&scenario=${nextScenario}`
      );
      if (selectionRef.current !== targetKey) return; // 场景已切换，丢弃迟到响应
      setPacket(result.data);
      setRawInput(result.data.raw);
    } catch (cause) {
      if (selectionRef.current !== targetKey) return;
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
      if (selectionRef.current !== targetKey) return;
      setPacket(result.data);
      setRawInput(result.data.raw);
    } catch (cause) {
      if (selectionRef.current !== targetKey) return;
      setError(cause instanceof Error ? cause.message : '解析数据包失败');
    } finally {
      setLoading(false);
    }
  };

  // 启动时只恢复当前选中组合（HTTP / request）的快照，其余场景保持静默
  useEffect(() => {
    const snapshot = loadSnapshot(DEFAULT_PROTOCOL, DEFAULT_SCENARIO);
    if (snapshot) {
      setRawInput(snapshot.rawInput);
      setActiveView(snapshot.activeView);
      setExpandedFields(snapshot.expandedFields);
      setPacket(snapshot.packet);
    } else {
      void loadSample(DEFAULT_PROTOCOL, DEFAULT_SCENARIO);
    }
    hydratedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 恢复完成后，当前组合的任何变化都按快照键写回存储
  useEffect(() => {
    if (!hydratedRef.current) return;
    saveSnapshot({
      protocol,
      scenario,
      rawInput,
      activeView,
      expandedFields,
      packet,
      updatedAt: Date.now()
    });
  }, [protocol, scenario, rawInput, activeView, expandedFields, packet]);

  const applySnapshot = (snapshot: WorkspaceSnapshot) => {
    setRawInput(snapshot.rawInput);
    setActiveView(snapshot.activeView);
    setExpandedFields(snapshot.expandedFields);
    setPacket(snapshot.packet);
    setError('');
  };

  const switchTo = (nextProtocol: Protocol, nextScenario: PacketScenario) => {
    if (nextProtocol === protocol && nextScenario === scenario) return;
    selectionRef.current = snapshotKey(nextProtocol, nextScenario);
    setProtocol(nextProtocol);
    setScenario(nextScenario);
    const snapshot = loadSnapshot(nextProtocol, nextScenario);
    if (snapshot) {
      applySnapshot(snapshot);
    } else {
      setPacket(null);
      setRawInput('');
      setExpandedFields({});
      setActiveView('overview');
      setError('');
      void loadSample(nextProtocol, nextScenario);
    }
  };

  const changeProtocol = (nextProtocol: Protocol) => {
    const nextScenario = nextProtocol === 'TCP' && scenario === 'response' ? 'handshake' : scenario;
    switchTo(nextProtocol, nextScenario);
  };

  const changeScenario = (nextScenario: PacketScenario) => {
    switchTo(protocol, nextScenario);
  };

  /** 只清空当前协议 + 场景组合的快照，其他场景的内容不受影响 */
  const resetScenario = () => {
    clearSnapshot(protocol, scenario);
    setPacket(null);
    setRawInput('');
    setExpandedFields({});
    setActiveView('overview');
    setError('');
    void loadSample(protocol, scenario);
  };

  const toggleField = (id: string) => {
    setExpandedFields((previous) => ({ ...previous, [id]: !(previous[id] ?? true) }));
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
            <p className="hero-subtitle">选择协议和场景，载入模拟流量，逐层查看字段、时间线与十六进制原始数据。</p>
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
            <button className="button ghost" onClick={resetScenario} disabled={loading}>清空此场景</button>
            <button className="button primary" onClick={() => void parsePacket()} disabled={loading || !rawInput.trim()}>{loading ? '处理中…' : '解析数据包 →'}</button>
          </div>
        </section>

        {error && <div className="error-banner">⚠ {error} <button onClick={() => setError('')}>关闭</button></div>}

        <section className="workspace-grid">
          <div className="left-column">
            <div className="panel packet-input-panel">
              <div className="panel-heading"><div><p className="section-kicker">01 / INPUT STREAM</p><h3>数据包输入</h3></div><span className="badge">{protocol}</span></div>
              <textarea value={rawInput} onChange={(event) => setRawInput(event.target.value)} spellCheck={false} aria-label="原始数据包输入" />
              <div className="input-footer"><span>{rawInput.length} chars · editable payload</span><button onClick={() => setRawInput('')}>清空输入</button></div>
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
                ? <FieldTree fields={packet?.fields ?? []} expandedFields={expandedFields} onToggleField={toggleField} />
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

interface FieldTreeProps {
  fields: ProtocolField[];
  expandedFields: Record<string, boolean>;
  onToggleField: (id: string) => void;
}

function FieldTree({ fields, expandedFields, onToggleField }: FieldTreeProps) {
  if (!fields.length) return <div className="empty-state">解析后将在这里显示协议层级字段。</div>;
  return <div className="field-tree">{fields.map((field) => <FieldNode key={field.id} field={field} depth={0} expandedFields={expandedFields} onToggleField={onToggleField} />)}</div>;
}

interface FieldNodeProps {
  field: ProtocolField;
  depth: number;
  expandedFields: Record<string, boolean>;
  onToggleField: (id: string) => void;
}

function FieldNode({ field, depth, expandedFields, onToggleField }: FieldNodeProps) {
  const expanded = expandedFields[field.id] ?? true;
  const hasChildren = Boolean(field.children?.length);
  return <div className="field-node" style={{ '--depth': depth } as CSSProperties}>
    <div className="field-row" onClick={() => hasChildren && onToggleField(field.id)}>
      <span className={`chevron ${hasChildren ? '' : 'invisible'} ${expanded ? 'open' : ''}`}>⌄</span>
      <span className="field-key">{field.key}</span>
      <span className="field-value">{field.value}</span>
      <span className="field-description">{field.description}</span>
    </div>
    {hasChildren && expanded && <div className="field-children">{field.children!.map((child) => <FieldNode key={child.id} field={child} depth={depth + 1} expandedFields={expandedFields} onToggleField={onToggleField} />)}</div>}
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
