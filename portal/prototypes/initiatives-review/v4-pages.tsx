import React, { Fragment, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, DensityProvider, RailNavList } from '@connorhoehnslalom/ui-components/shared';
import { ChatPanel } from '@connorhoehnslalom/ui-components/social';
import { RichChatComposer, type RichChatDraft } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { Status, Chevron, money, envelopes, budgetRows, work, Envelopes } from './revision3';
import './refinement.css';

type Item = typeof work[number];
const filters = ['Open work', 'Next up', 'In progress', 'In review'];
const countFor = (filter: string) => work.filter(w => filter === 'Open work' || w.group === filter).length;
const target = (id: string, children: React.ReactNode) => document.getElementById(id) ? createPortal(children, document.getElementById(id)!) : null;
export function setRoute(route: string) { window.history.replaceState(null, '', `${window.location.href.split('#')[0]}#${route}`); }
export function Study() { return <p className="review-note">Design review · interactive local example</p>; }
export function Rail({ children }: { children: React.ReactNode }) { return target('review-rail', <div className="refine-rail">{children}</div>); }

function Discussion({ close }: { close: () => void }) {
  const messages = JSON.parse(document.getElementById('review-messages')?.textContent || '[]');
  const [draft, setDraft] = useState<RichChatDraft>({ html: '', files: [] });
  const [receipt, setReceipt] = useState('');
  return target('review-discussion', <div className="refine-discussion">
    <header><div><h2>Discussion</h2><span>Auth Migration</span></div><Button variant="ghost" size="sm" onClick={close}>Close</Button></header>
    <ChatPanel messages={messages} onSend={() => {}} postRhythm="chat" threaded alignOwnMessages={false} showHeader={false} fill
      composer={<><RichChatComposer draft={draft} onDraftChange={setDraft} onSend={() => { setReceipt('Draft preview only. Nothing sent.'); return false; }} toolbar="basic" collapseWhenIdle placeholder="Message the initiative…" inputLabel="Discussion message" allowAttachments={false} allowEmoji={false} />{receipt && <p className="refine-receipt" role="status">{receipt}</p>}</>} />
  </div>);
}
export function WorkRows({ filter, onOpen }: { filter: string; onOpen: (item: Item) => void }) {
  const [query, setQuery] = useState('');
  const rows = work.filter(w => (filter === 'Open work' || filter === 'Work' || w.group === filter) && `${w.id} ${w.title} ${w.owner}`.toLowerCase().includes(query.toLowerCase()));
  return <><div className="review-toolbar"><input aria-label="Find work" placeholder="Find work…" value={query} onChange={e => setQuery(e.target.value)} /><span>{rows.length} items</span></div>
    <div className="review-table-wrap"><table className="review-table work refine-work-table" aria-label="Work items"><colgroup><col style={{ width: '46%' }} /><col style={{ width: '19%' }} /><col style={{ width: '18%' }} /><col style={{ width: '17%' }} /></colgroup><thead><tr><th>Work item</th><th>Owner</th><th>Agent</th><th className="num">Cost</th></tr></thead><tbody>
      {rows.map(w => <tr key={w.id}><th scope="row"><button className="review-work-link" onClick={() => onOpen(w)}><span className="review-work-title">{w.title}</span><span className="review-work-meta"><span className="review-id">{w.id}</span><span>{w.type} · {w.pts} pts</span></span></button><small className={w.id.endsWith('-8') ? 'warning' : ''}>{w.id.endsWith('-8') ? 'Blocked · cutover decision' : w.group}</small></th><td>{w.owner}</td><td><Status tone={w.stage === 'Running' ? 'info' : w.stage === 'Needs review' ? 'warning' : ''}>{w.stage}</Status>{w.stage === 'Running' && <small>Running tests</small>}</td><td className="num">{w.cost}<small>{w.basis}</small></td></tr>)}
      {rows.length === 0 && <tr><td colSpan={4}>No work matches “{query}”.</td></tr>}
    </tbody></table></div></>;
}
export function ItemDetail({ item, back }: { item: Item; back: () => void }) {
  return <><Button variant="ghost" size="sm" onClick={back}>← Back to work</Button><header className="review-heading refine-record-heading"><div><p className="review-id">{item.id}</p><h1>{item.title}</h1><p>{item.owner} · {item.type} · {item.pts} points</p></div></header><div className="review-summary"><Status>{item.group}</Status><span>{item.cost} {item.basis.toLowerCase()}</span></div><section className="review-detail-section"><h2>Next action</h2><p>{item.note}</p></section></>;
}
export function Work() {
  const [view, setView] = useState('Open work');
  const [item, setItem] = useState<Item | null>(null);
  const [discussion, setDiscussion] = useState(window.innerWidth > 1100);
  useEffect(() => { document.body.dataset.discussion = discussion ? 'open' : 'closed'; }, [discussion]);
  const navigate = (next: string) => { setView(next); setItem(null); setRoute(`work/${next.toLowerCase().replaceAll(' ', '-')}`); };
  return <><Rail><div className="refine-rail-heading"><span>Initiative</span><strong>Auth Migration</strong></div>
    <div className="refine-rail-section"><h2>Work</h2><RailNavList currentStyle="tint" aria-label="Work views" items={filters.map(f => ({ id: f, label: f, count: countFor(f), current: view === f && !item, onSelect: () => navigate(f) }))} /></div>
    <div className="refine-rail-section"><h2>Budget</h2><RailNavList aria-label="Initiative budget" currentStyle="tint" items={[{ id: 'envelope', label: 'Your envelope', current: view === 'Your envelope', onSelect: () => navigate('Your envelope') }]} /><div className="refine-rail-balance"><strong>$12.28</strong><span>remaining · Sprint 10</span><small>$0.30 reserved</small></div></div>
    <details className="refine-rail-about"><summary>About this initiative</summary><p>Owner · Vera Green</p><p>SMEs · Simone Chang, Nora DaSilva, Rhea Castellanos</p><p>Consolidate login on Cognito and retire the legacy SAML shim.</p></details>
  </Rail><div className="review-page refine-work"><div className="refine-heading-row"><div><Study/><h1>{item ? 'Work item' : view}</h1></div><Button variant="secondary" size="sm" onClick={() => setDiscussion(!discussion)}>{discussion ? 'Hide discussion' : 'Show discussion'}</Button></div>
    {item ? <ItemDetail item={item} back={() => { setItem(null); setRoute('work'); }} /> : view === 'Your envelope' ? <><p className="refine-subtitle">Nora DaSilva · Sprint 10 — Session hygiene</p><dl className="review-facts"><div><dt>Granted</dt><dd>$15.00</dd></div><div><dt>Reserved</dt><dd>$0.30</dd></div><div><dt>Spent</dt><dd>$2.42</dd></div><div><dt>Remaining</dt><dd>$12.28</dd></div></dl><p className="review-footnote warning">1 run has no recorded cost and is excluded from the balance.</p></> : <WorkRows key={view} filter={view} onOpen={w => { setItem(w); setRoute(`work/${w.id}`); }} />}
  </div><Discussion close={() => setDiscussion(false)} /></>;
}
function CompactEnvelopes() {
  return <div className="review-table-wrap"><table className="review-table refine-compact-table" aria-label="Sprint envelopes"><colgroup><col style={{ width: '36%' }} />{[0,1,2,3].map(i => <col key={i} style={{ width: '16%' }} />)}</colgroup><thead><tr><th>Holder</th><th className="num">Granted</th><th className="num">Reserved</th><th className="num">Spent</th><th className="num">Remaining</th></tr></thead><tbody>{envelopes.map(e => <tr key={e.name}><th scope="row">{e.name}{e.unknown > 0 && <span className="refine-unknown" title="1 run has no recorded cost">1 unknown</span>}</th><td className="num">{money(e.grant)}</td><td className="num">{money(e.reserved)}</td><td className="num">{money(e.spent)}</td><td className="num strong">{money(e.grant-e.reserved-e.spent)}</td></tr>)}</tbody><tfoot><tr><th>Total</th>{['grant','reserved','spent','remaining'].map(k => <td className="num" key={k}>{money(envelopes.reduce((s,e) => s+(k==='remaining'?e.grant-e.reserved-e.spent:e[k as 'grant'|'reserved'|'spent']),0))}</td>)}</tr></tfoot></table></div>;
}
export function Budget() {
  const [expanded, setExpanded] = useState('Auth Migration');
  const [query, setQuery] = useState('');
  return <div className="review-page"><Study/><header className="review-heading"><div><h1>Initiative budgets</h1><p>October 2026 · allocations, envelope funding and recorded spend</p></div></header><div className="review-summary"><span><b>{money(budgetRows.reduce((s,r)=>s+r[1],0))}</b> allocated</span><span><b>{money(budgetRows.reduce((s,r)=>s+r[4],0))}</b> recorded spend</span><span className="warning">{budgetRows.reduce((s,r)=>s+r[5],0)} runs with unknown cost</span></div>
    <div className="review-toolbar"><input aria-label="Search initiative budgets" placeholder="Search initiatives…" value={query} onChange={e=>setQuery(e.target.value)}/></div><div className="review-table-wrap"><table className="review-table budget" aria-label="Initiative budgets"><colgroup><col style={{width:'30%'}}/>{[0,1,2,3,4].map(i=><col key={i} style={{width:'14%'}}/>)}</colgroup><thead><tr><th>Initiative</th><th className="num">Allocated</th><th className="num">Automation</th><th className="num">Envelopes</th><th className="num">Unassigned</th><th className="num">Spent</th></tr></thead><tbody>{budgetRows.filter(r=>r[0].toLowerCase().includes(query.toLowerCase())).map(([name,allocated,floor,granted,spent,unknown])=><Fragment key={name}><tr className={expanded===name?'selected':''}><th scope="row"><button className="review-row-link" aria-expanded={expanded===name} onClick={()=>setExpanded(expanded===name?'':name)}><Chevron open={expanded===name}/>{name}</button></th><td className="num">{allocated?money(allocated):'Unallocated'}</td><td className="num">{money(floor)}</td><td className="num">{money(granted)}</td><td className="num strong">{allocated?money(Math.max(0,allocated-floor-granted)):'—'}</td><td className="num">{money(spent)}{unknown>0&&<small className="warning">+ {unknown} unknown</small>}</td></tr>{expanded===name&&<tr className="review-child-row"><td colSpan={6}><section className="refine-budget-child" aria-label={`${name} funding details`}><div className="refine-child-title"><h2>Envelopes</h2><span>{name==='Auth Migration'?'Sprint 10 · Session hygiene':'Sprint funding'}</span></div>{name==='Auth Migration'?<CompactEnvelopes/>:<p className="review-footnote">{granted?`${money(granted)} assigned; holder details are outside this example.`:'No envelopes in this example.'}</p>}<div className="refine-reserve-line"><span>Automation reserve{name==='Auth Migration'?' · 3 scheduled bots':''}</span><strong>{money(floor)}</strong></div><details className="refine-balance-help"><summary>How these balances are calculated</summary><p>Unassigned = allocation − automation reserve − envelope grants. Envelope remaining = granted − reserved − recorded spend. Unknown costs are excluded.</p>{name==='Auth Migration'&&<p>Granted by Sienna Garcia. Scheduled bots: auth-dep-watch, api-contract-watch, compliance-evidence-cron.</p>}</details></section></td></tr>}</Fragment>)}</tbody></table></div></div>;
}
const sprints = [
  {id:'inventory',title:'Sprint 5 — Inventory',initiative:'Zero Trust Network',ends:'4 Nov',granted:8},
  {id:'format',title:'Sprint 6 — Format decision',initiative:'Data Lake Migration',ends:'1 Nov',granted:10},
  {id:'observability',title:'Sprint 11 — Span metrics + decom',initiative:'Observability Platform',ends:'28 Oct',granted:30},
  {id:'auth',title:'Sprint 10 — Session hygiene',initiative:'Auth Migration',ends:'3 Nov',granted:45},
  {id:'evals',title:'Sprint 9 — Judge + evals',initiative:'LLM Application Platform',ends:'28 Oct',granted:35},
  {id:'inference',title:'Sprint 9 — Queue-depth scaling',initiative:'Inference Platform',ends:'28 Oct',granted:15},
  {id:'cost',title:'Sprint 10 — Attribution',initiative:'Cost Optimization',ends:'28 Oct',granted:20},
];
export function Sprints() {
  const [selected,setSelected]=useState('auth');
  const [view,setView]=useState('Work');
  const [item,setItem]=useState<Item|null>(null);
  const [query,setQuery]=useState('');
  const sprint=sprints.find(s=>s.id===selected);
  const navigate=(id:string,section='Work')=>{setSelected(id);setView(section);setItem(null);setRoute(id?`sprints/${id}/${section.toLowerCase()}`:'sprints');};
  return <><Rail><div className="refine-rail-heading"><span>Plan</span><strong>Sprints</strong></div><RailNavList currentStyle="tint" aria-label="Sprint views" items={[{id:'all',label:'All sprints',count:sprints.length,current:!selected,onSelect:()=>navigate('')}]} /><div className="refine-rail-section"><h2>Active · preview selection</h2><div className="refine-sprint-nav">{sprints.map(s=><Fragment key={s.id}><button className={selected===s.id?'is-selected':''} onClick={()=>navigate(s.id)} aria-current={selected===s.id?'page':undefined}><span>{s.title}</span><small>{s.initiative}</small></button>{selected===s.id&&<div className="refine-sprint-subnav"><RailNavList currentStyle="tint" aria-label={`${s.title} sections`} items={['Work','Envelopes'].map(v=>({id:v,label:v,count:s.id==='auth'?(v==='Work'?4:3):undefined,current:view===v,onSelect:()=>navigate(s.id,v)}))}/></div>}</Fragment>)}</div></div></Rail><div className="review-page refine-sprints"><Study/>
    {!sprint?<><header className="review-heading"><div><h1>Active sprints</h1><p>Select a sprint to open its work and funding.</p></div></header><div className="review-toolbar"><input aria-label="Search sprints" placeholder="Search sprints…" value={query} onChange={e=>setQuery(e.target.value)}/></div><div className="review-table-wrap"><table className="review-table" aria-label="Sprints"><colgroup><col style={{width:'42%'}}/><col style={{width:'30%'}}/><col style={{width:'14%'}}/><col style={{width:'14%'}}/></colgroup><thead><tr><th>Sprint</th><th>Initiative</th><th>Ends</th><th className="num">Granted</th></tr></thead><tbody>{sprints.filter(s=>(s.title+s.initiative).toLowerCase().includes(query.toLowerCase())).map(s=><tr key={s.id}><th scope="row"><button className="review-row-link" onClick={()=>navigate(s.id)}>{s.title}</button></th><td>{s.initiative}</td><td>{s.ends}</td><td className="num">{money(s.granted)}</td></tr>)}</tbody></table></div></>:<><header className="review-heading"><div><h1>{sprint.title}</h1><p>{sprint.initiative}{sprint.id==='auth'?' · Nora DaSilva, steward':''} · ends {sprint.ends}</p></div><Status tone="info">Active</Status></header><div className="refine-section-title"><h2>{item?'Work item':view}</h2>{!item&&sprint.id==='auth'&&<span>{view==='Work'?'4 open items':'3 holders · $45.00 granted'}</span>}</div>{sprint.id!=='auth'?<p className="review-footnote">This study includes the detailed {view.toLowerCase()} view for Sprint 10 — Session hygiene. Select it in the sidebar to explore the layout.</p>:item?<ItemDetail item={item} back={()=>setItem(null)}/>:view==='Work'?<WorkRows filter="Work" onOpen={w=>{setItem(w);setRoute(`sprints/auth/work/${w.id}`);}}/>:<><Envelopes/><p className="review-footnote">$2.24 spent outside envelopes this sprint. Unknown costs are excluded from remaining balances.</p></>}</>}
  </div></>;
}
