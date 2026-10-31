import React, { useEffect, useRef, useState } from 'react';
import type { ComposerCatalog, ConnectorBinding, ConnectorCard, ConnectorKind, RunSelection } from '../core.ts';
import { moveBinding, validateSelection } from '../core.ts';

export interface ConnectorComposerProps {
  /** Host-owned catalog; credentials and resource implementations must never enter this component. */
  loadCatalog: (workspaceId?: string) => Promise<ComposerCatalog>;
  /** Starts one run after host validation. Omit for selection-only integration. */
  onRun?: (selection: RunSelection, prompt: string, requestId: string, workspaceId?: string) => Promise<void>;
  /** Select-only hosts use the same composer and public selection contract. */
  onApply?: (selection: RunSelection) => void;
  /** Initial draft for this composer instance. */
  initialSelection?: RunSelection;
  /** Host-specific context shown above the work area. */
  subtitle?: string;
}
const labels: Record<ConnectorKind, string> = Object.assign(Object.create(null), { skill: '技能', mcp: 'MCP', session: '会话', subagent: '子 Agent', execution: '执行环境', instructions: '上下文', custom: '扩展' });
const symbols: Record<ConnectorKind, string> = Object.assign(Object.create(null), { skill: '✧', mcp: '⇄', session: '◷', subagent: '◇', execution: '⌘', instructions: '≡', custom: '+' });
const empty: RunSelection = { version: 1, bindings: [] };

/** Presentational composer shared by DSH Web and other hosts. No DSH service or transport imports. */
export default function ConnectorComposer({ loadCatalog, onRun, onApply, initialSelection = empty, subtitle }: ConnectorComposerProps) {
  const [catalog, setCatalog] = useState<ComposerCatalog>({ cards: [] });
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [selection, setSelection] = useState<RunSelection>(() => structuredClone(initialSelection));
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ConnectorKind | 'all'>('all');
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const mounted = useRef(true);
  const refreshId = useRef(0);
  const request = useRef<{ id: string; signature: string }>();
  const activeRun = useRef(false);
  async function refresh() {
    const id = ++refreshId.current;
    setLoading(true); setError('');
    try { const result = await loadCatalog(workspaceId); if (mounted.current && refreshId.current === id) setCatalog(result); }
    catch (failure) { if (mounted.current && refreshId.current === id) setError(failure instanceof Error ? failure.message : '读取连接器失败'); }
    finally { if (mounted.current && refreshId.current === id) setLoading(false); }
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; refreshId.current++; }; }, [loadCatalog, workspaceId]);
  const selected = new Set(selection.bindings.map(binding => binding.id));
  const visible = catalog.cards.filter(card => (filter === 'all' || card.kind === filter) && `${card.label} ${card.description}`.toLowerCase().includes(query.toLowerCase()));
  const byId = new Map(catalog.cards.map(card => [card.id, card]));
  const counts = new Map<ConnectorKind, number>();
  for (const card of catalog.cards) counts.set(card.kind, (counts.get(card.kind) ?? 0) + 1);
  const add = (id: string) => {
    if (running) return;
    const card = byId.get(id);
    if (!card || card.disabledReason) return;
    setSelection(previous => {
      if (previous.bindings.some(binding => binding.id === id)) return previous;
      return { version: 1, bindings: [...previous.bindings, { id }] };
    });
    if (card.fields?.length) setExpanded(id);
    setError('');
  };
  const update = (id: string, key: string, value: string) => setSelection(previous => ({ version: 1, bindings: previous.bindings.map(binding => binding.id === id ? { ...binding, config: { ...binding.config, [key]: value } } : binding) }));
  async function submit() {
    if (activeRun.current || loading) return;
    try {
      validateSelection(selection, catalog.cards);
      if (onApply) { onApply(structuredClone(selection)); return; }
      if (!onRun || !prompt.trim()) throw new Error('先写下本轮要完成的任务');
      const location = workspaceId ?? catalog.workspaceId;
      const signature = JSON.stringify({ selection, prompt, workspaceId: location });
      if (!request.current || request.current.signature !== signature) request.current = { id: crypto.randomUUID(), signature };
      activeRun.current = true; setRunning(true); setError('');
      await onRun(structuredClone(selection), prompt, request.current.id, location);
      if (mounted.current) { setPrompt(''); request.current = undefined; }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '启动失败，请重试'); }
    finally { activeRun.current = false; if (mounted.current) setRunning(false); }
  }
  const renderSelected = (binding: ConnectorBinding, index: number) => {
    const card = byId.get(binding.id);
    return <article className={`cc-selected ${!card ? 'cc-missing' : ''}`} key={binding.id} data-connector-id={binding.id}>
      <div className="cc-selected-top"><span className="cc-symbol">{card ? (symbols[card.kind] ?? '+') : '!'}</span><div className="cc-name"><strong>{card?.label || binding.id}</strong><small>{card ? (labels[card.kind] ?? card.kind) : '资源已不可用，请移除或刷新'}</small></div>
        <div className="cc-actions"><button type="button" disabled={running || index === 0} aria-label={`上移 ${card?.label}`} onClick={() => setSelection(previous => moveBinding(previous, binding.id, -1))}>↑</button><button type="button" disabled={running || index === selection.bindings.length - 1} aria-label={`下移 ${card?.label}`} onClick={() => setSelection(previous => moveBinding(previous, binding.id, 1))}>↓</button><button type="button" disabled={running} aria-label={`移除 ${card?.label || binding.id}`} onClick={() => setSelection(previous => ({ version: 1, bindings: previous.bindings.filter(item => item.id !== binding.id) }))}>×</button></div>
      </div>
      {!!card?.fields?.length && <><button className="cc-config-toggle" type="button" onClick={() => setExpanded(expanded === binding.id ? undefined : binding.id)}>{expanded === binding.id ? '收起配置' : '配置内容'} <span>{expanded === binding.id ? '−' : '+'}</span></button>
        {expanded === binding.id && <div className="cc-fields">{card.fields.map(field => <label key={field.key}>{field.label}{field.required && <span className="cc-required"> *</span>}{field.multiline ? <textarea disabled={running} value={binding.config?.[field.key] || ''} onChange={event => update(binding.id, field.key, event.target.value)} rows={4} /> : <input disabled={running} value={binding.config?.[field.key] || ''} onChange={event => update(binding.id, field.key, event.target.value)} />}</label>)}</div>}</>}
    </article>;
  };
  return <section className="cc-root" aria-label="连接器运行工作台">
    <style>{styles}</style>
    <header className="cc-header"><div><span className="cc-eyebrow">CONTEXT COMPOSER · 实验</span><h2>为这一轮，组合上下文</h2><p>{subtitle || '把需要的资源拖入右侧。只为本轮装配，原有会话和默认设置保持独立。'}</p></div><span className="cc-engine">DSH <span>●</span></span></header>
    {!!catalog.workspaces?.length && <label className="cc-location">运行位置 <select aria-label="运行位置" disabled={running || loading} value={workspaceId ?? catalog.workspaceId ?? ''} onChange={event => { setWorkspaceId(event.target.value); setSelection(empty); }} title="切换位置会清空本轮组合，重新发现该位置的资源">{catalog.workspaces.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
    <div className="cc-workbench"><aside className="cc-library"><div className="cc-section-title"><h3>连接器目录 <small>{catalog.cards.length}</small></h3><button type="button" onClick={() => void refresh()} disabled={loading || running}>刷新</button></div>
      <input className="cc-search" aria-label="搜索连接器" placeholder="搜索技能、服务、历史会话…" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="cc-filters"><button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</button>{([...counts.keys()] as ConnectorKind[]).map(kind => <button type="button" key={kind} aria-pressed={filter === kind} onClick={() => setFilter(kind)}>{labels[kind] ?? kind} <small>{counts.get(kind)}</small></button>)}</div>
      <div className="cc-catalog" aria-busy={loading}>{loading ? <p className="cc-empty">正在读取可用资源…</p> : !visible.length ? <p className="cc-empty">没有匹配的连接器</p> : visible.map(card => <article className={`cc-card ${selected.has(card.id) ? 'cc-chosen' : ''}`} key={card.id} draggable={!running && !card.disabledReason && !selected.has(card.id)} data-connector-id={card.id} onDragStart={event => { event.dataTransfer.setData('application/x-context-connector', card.id); event.dataTransfer.effectAllowed = 'copy'; }}>
        <span className="cc-symbol">{(symbols[card.kind] ?? '+')}</span><div className="cc-card-copy"><span className="cc-kind">{(labels[card.kind] ?? card.kind)}</span><strong>{card.label}</strong><p>{card.disabledReason || card.description}</p></div><button type="button" title={card.disabledReason} disabled={running || !!card.disabledReason || selected.has(card.id)} aria-label={`添加 ${card.label}`} onClick={() => add(card.id)}>{selected.has(card.id) ? '✓' : '+'}</button>
      </article>)}</div></aside>
      <main className="cc-run"><div className="cc-section-title"><h3>本轮上下文 <small>{selection.bindings.length}</small></h3><button type="button" disabled={running || !selection.bindings.length} onClick={() => setSelection(empty)}>清空</button></div>
        <div className={`cc-drop ${over ? 'cc-over' : ''}`} data-testid="connector-dropzone" onDragOver={event => { if (!running) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setOver(true); } }} onDragLeave={() => setOver(false)} onDrop={event => { event.preventDefault(); setOver(false); add(event.dataTransfer.getData('application/x-context-connector')); }}>
          {selection.bindings.length ? selection.bindings.map(renderSelected) : <div className="cc-placeholder"><span>＋</span><strong>拖入这轮需要的连接器</strong><p>也可以点击左侧的 + 添加<br />不选择历史会话，就从新的上下文开始</p></div>}
          {!!selection.bindings.length && <p className="cc-drop-hint">继续拖入资源，或调整上方装配顺序</p>}
        </div>
        {!onApply && <label className="cc-prompt">本轮任务<textarea aria-label="本轮任务" placeholder="希望 Agent 使用这些上下文完成什么？" value={prompt} disabled={running} onChange={event => setPrompt(event.target.value)} rows={4} /></label>}
        {!!error && <div className="cc-error" role="alert">{error}</div>}
        <footer className="cc-footer"><small>连接器装配 · 不包含网络读写隔离</small><button className="cc-primary" type="button" disabled={running || loading || (!onApply && !prompt.trim())} onClick={() => void submit()}>{running ? '正在创建运行…' : onApply ? '用于下一轮' : '开始这一轮 →'}</button></footer>
      </main></div>
  </section>;
}

const styles = `
.cc-location{display:flex;gap:12px;align-items:center;margin:0 auto 16px;max-width:1320px;color:#6a6a6a;font-size:12px}.cc-location select{font:inherit;max-width:400px;border:1px solid #c4c7cc;border-radius:8px;background:white;padding:6px 12px;color:#1b1b1b}
.cc-root{font-family:"PingFang SC",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1b1b1b;background:#f7f8fa;padding:24px;box-sizing:border-box;width:100%;height:100%;min-height:540px;font-size:14px;line-height:1.5;overflow:auto}.cc-root *{box-sizing:border-box}.cc-root button,.cc-root input,.cc-root textarea{font:inherit}.cc-root button{cursor:pointer;border:1px solid #e1e3e6;border-radius:8px;background:white;padding:6px 10px;color:#6a6a6a}.cc-root button:disabled{cursor:default;opacity:.45}.cc-root button:focus-visible,.cc-root input:focus,.cc-root textarea:focus{outline:2px solid #1869f5;outline-offset:2px}.cc-header{display:flex;justify-content:space-between;gap:24px;margin-bottom:24px}.cc-eyebrow{font-size:11px;letter-spacing:1.5px;color:#6a6a6a}.cc-header h2{font-weight:500;font-size:24px;margin:8px 0}.cc-header p{margin:0;color:#6a6a6a;max-width:660px}.cc-engine{height:32px;padding:6px 12px;background:white;border:1px solid #e1e3e6;border-radius:8px;font-size:12px;white-space:nowrap}.cc-engine span{color:#2fbc44;font-size:8px;margin-left:8px}.cc-workbench{display:grid;grid-template-columns:minmax(250px, .9fr) minmax(320px,1.1fr);gap:20px;max-width:1320px;margin:auto}.cc-library,.cc-run{background:white;border:1px solid #e1e3e6;border-radius:12px;padding:20px;min-width:0}.cc-section-title{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:16px}.cc-section-title h3{font-size:15px;font-weight:500;margin:0}.cc-section-title h3 small{color:#9d9d9d;margin-left:8px}.cc-section-title>button{border:0;font-size:12px;padding:4px}.cc-search,.cc-fields input,.cc-root textarea{display:block;width:100%;border:1px solid #c4c7cc;border-radius:8px;padding:10px 12px;background:white;color:#1b1b1b;resize:vertical}.cc-filters{display:flex;gap:4px;flex-wrap:wrap;margin:12px 0 16px}.cc-filters button{border:0;background:#f7f8fa;font-size:12px}.cc-filters button[aria-pressed=true]{background:#fff0ed;color:#f63218}.cc-filters small{opacity:.65}.cc-catalog{display:flex;flex-direction:column;gap:8px;max-height:550px;overflow:auto}.cc-card{display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid #e1e3e6;border-radius:8px;background:#fff}.cc-card[draggable=true]{cursor:grab}.cc-card[draggable=true]:hover{border-color:#f63218;box-shadow:0 2px 8px #00000008}.cc-chosen{background:#fafafa}.cc-symbol{display:grid;place-items:center;flex-shrink:0;width:32px;height:32px;border-radius:8px;background:#f4f5f7;color:#6a6a6a;font-size:20px}.cc-card-copy{flex:1;min-width:0}.cc-kind{font-size:10px;color:#9d9d9d;display:block}.cc-card strong{font-weight:500;display:block;overflow-wrap:anywhere}.cc-card p{font-size:12px;color:#6a6a6a;margin:4px 0 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.cc-card>button{width:28px;height:28px;padding:0;flex-shrink:0;font-size:18px}.cc-drop{max-height:420px;overflow-y:auto;border:1px dashed #c4c7cc;border-radius:8px;padding:12px;min-height:250px;background:#fafbfc;transition:background .15s,border-color .15s}.cc-over{border-color:#f63218;background:#fff4f1}.cc-placeholder{display:flex;min-height:225px;align-items:center;justify-content:center;flex-direction:column;text-align:center}.cc-placeholder>span{font-size:28px;color:#c4c7cc;margin-bottom:12px}.cc-placeholder strong{font-weight:400;color:#6a6a6a}.cc-placeholder p,.cc-drop-hint{font-size:12px;color:#9d9d9d}.cc-selected{padding:12px;background:white;border:1px solid #e1e3e6;border-radius:8px;margin-bottom:8px}.cc-selected-top{display:flex;align-items:center;gap:10px}.cc-name{flex:1;min-width:0}.cc-name strong{font-weight:500;display:block;overflow-wrap:anywhere}.cc-name small{color:#9d9d9d;font-size:11px}.cc-actions{display:flex;gap:2px}.cc-actions button{padding:2px 5px;border:0;font-size:16px}.cc-missing{border-color:#f63218}.cc-drop-hint{text-align:center;margin:12px 0 0}.cc-config-toggle{display:flex;width:100%;justify-content:space-between;margin-top:8px;border:0!important;font-size:12px!important;background:#f7f8fa!important}.cc-fields{display:grid;gap:12px;margin-top:12px}.cc-fields label{font-size:12px;color:#6a6a6a}.cc-fields input,.cc-fields textarea{margin-top:4px;font-size:13px}.cc-required{color:#f63218}.cc-prompt{display:block;margin-top:20px;font-weight:500}.cc-prompt textarea{margin-top:8px;font-weight:400}.cc-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:20px}.cc-footer small{font-size:11px;color:#9d9d9d}.cc-primary{background:#f63218!important;border-color:#f63218!important;color:white!important;padding:10px 16px!important;white-space:nowrap}.cc-error{background:#fff0ed;color:#b42815;border-radius:8px;padding:10px 12px;margin-top:12px;font-size:13px}.cc-empty{color:#9d9d9d;text-align:center;padding:32px 8px}@media(max-width:720px){.cc-root{padding:16px}.cc-workbench{grid-template-columns:1fr}.cc-catalog{max-height:260px}.cc-header h2{font-size:20px}.cc-footer{flex-wrap:wrap}.cc-library,.cc-run{padding:16px}}
`;
