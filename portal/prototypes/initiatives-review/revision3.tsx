import React, { Fragment, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, DensityProvider, WorkflowStepper } from '@connorhoehnslalom/ui-components/shared';
import { ComposerPromptDeck, RichChatComposer, type ComposerPrompt, type RichChatDraft } from '@connorhoehnslalom/ui-components/social/rich-composer';
import './review.css';

// Review-only fixtures. No API client, authentication, dispatch, or message transport.
const money = (n: number) => `$${n.toFixed(2)}`;
const envelopes = [
  { name: 'Simone Chang', grant: 20, reserved: 0, spent: 3.10, unknown: 0 },
  { name: 'Nora DaSilva', grant: 15, reserved: .30, spent: 2.42, unknown: 1 },
  { name: 'Rhea Castellanos', grant: 10, reserved: 0, spent: 0, unknown: 0 },
];
const budgetRows = [
  ['Observability Platform', 95, 1.91, 25, 5.97, 2], ['Auth Migration', 75, .64, 45, 8.07, 1],
  ['LLM Application Platform', 85, 6.35, 30, 11.35, 0], ['Cost Optimization', 45, .40, 0, 1.67, 0],
  ['Real-time Analytics Pipeline', 20, .85, 0, .85, 0], ['Data Lake Migration', 15, 0, 0, 0, 0],
  ['ML Feature Store', 18, 1.39, 0, 1.39, 0], ['Mobile App Redesign', 15, .75, 0, .75, 0],
  ['Design System v3', 15, 1.03, 0, 1.03, 0], ['Design System API', 15, .78, 0, .78, 0],
  ['Inference Platform', 0, .78, 0, 3.12, 3], ['RAG Knowledge Search', 5, .52, 0, .52, 0],
  ['SOC2 Compliance', 18, 1.08, 0, 1.08, 0], ['Zero Trust Network', 10, 0, 0, 0, 0],
] as const;
const work = [
  { id: 'ORG-AUTH-8', title: 'Tenant-by-tenant cutover runbook with rollback', owner: 'Simone Chang', type: 'Story', pts: 5, group: 'Next up', stage: 'Not started', note: 'Blocked · cutover decision', cost: '~$0.75', basis: 'Forecast' },
  { id: 'ORG-AUTH-9', title: 'Logout leaves the legacy shim cookie alive', owner: 'Vera Green', type: 'Bug', pts: 2, group: 'Next up', stage: 'Queued', note: 'Waiting for a computer', cost: '$0.30', basis: 'Reserved' },
  { id: 'ORG-AUTH-5', title: 'Refresh loop when a grant is revoked mid-session', owner: 'Vera Green', type: 'Bug', pts: 3, group: 'In progress', stage: 'Running', note: 'Running tests · turn 4', cost: '$0.18', basis: 'Spent · ~$0.30 forecast' },
  { id: 'ORG-AUTH-4', title: 'Session cookie hardening: max-age, rotation on switch', owner: 'Nora DaSilva', type: 'Story', pts: 5, group: 'In review', stage: 'Needs review', note: 'Result ready', cost: '$1.12', basis: 'Spent · ~$1.50 forecast' },
];

function Status({ children, tone = '' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`review-status ${tone}`}>{children}</span>;
}
function Tabs({ items, value, onChange }: { items: string[]; value: string; onChange: (v: string) => void }) {
  return <div role="tablist" className="review-tabs">{items.map(item => <button type="button" key={item} role="tab" aria-selected={item === value} onClick={() => onChange(item)}>{item}</button>)}</div>;
}
function Note() { return <p className="review-note">Interactive design study · illustrative data · actions stay in this preview</p>; }
function Chevron({ open }: { open: boolean }) {
  return <svg className="review-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d={open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
}
function Envelopes() {
  return <div className="review-table-wrap"><table className="review-table envelopes" aria-label="Sprint envelopes">
    <colgroup><col style={{ width: '36%' }} />{Array.from({length:4},(_,i)=><col key={i} style={{width:'16%'}} />)}</colgroup>
    <thead><tr><th>Holder</th><th className="num">Granted</th><th className="num">Reserved</th><th className="num">Spent</th><th className="num">Remaining</th></tr></thead>
    <tbody>{envelopes.map(e => <tr key={e.name}><th scope="row"><span>{e.name}</span>{e.unknown > 0 && <small className="warning">1 run has unknown cost</small>}</th><td className="num">{money(e.grant)}</td><td className="num">{money(e.reserved)}</td><td className="num">{money(e.spent)}</td><td className="num strong">{money(e.grant - e.reserved - e.spent)}</td></tr>)}</tbody>
    <tfoot><tr><th>Total</th>{['grant','reserved','spent','remaining'].map(k => <td className="num" key={k}>{money(envelopes.reduce((sum,e)=>sum+(k === 'remaining' ? e.grant-e.reserved-e.spent : e[k as 'grant'|'reserved'|'spent']),0))}</td>)}</tr></tfoot>
  </table></div>;
}
function Budget() {
  const [expanded,setExpanded] = useState('Auth Migration');
  const [query,setQuery] = useState('');
  const rows = budgetRows.filter(r=>r[0].toLowerCase().includes(query.toLowerCase()));
  return <div className="review-page"><Note /><header className="review-heading"><div><h1>Initiative budgets</h1><p>October 2026 · allocations, envelope funding and recorded spend</p></div></header>
    <div className="review-summary"><span><b>{money(budgetRows.reduce((s,r)=>s+r[1],0))}</b> allocated</span><span><b>{money(budgetRows.reduce((s,r)=>s+r[4],0))}</b> recorded spend</span><span className="warning">{budgetRows.reduce((s,r)=>s+r[5],0)} runs with unknown cost</span></div>
    <div className="review-toolbar"><input aria-label="Search initiative budgets" placeholder="Search initiatives…" value={query} onChange={e=>setQuery(e.target.value)} /><span>{rows.length} initiatives</span></div>
    <div className="review-table-wrap"><table className="review-table budget" aria-label="Initiative budgets"><colgroup><col style={{width:'30%'}} /><col style={{width:'14%'}} /><col style={{width:'14%'}} /><col style={{width:'14%'}} /><col style={{width:'14%'}} /><col style={{width:'14%'}} /></colgroup>
      <thead><tr><th>Initiative</th><th className="num">Allocated</th><th className="num">Automation</th><th className="num">Envelopes</th><th className="num">Unassigned</th><th className="num">Spent</th></tr></thead>
      <tbody>{rows.map(([name,allocated,floor,granted,spent,unknown])=><Fragment key={name}><tr className={expanded===name?'selected':''}>
        <th scope="row"><button className="review-row-link" onClick={()=>setExpanded(expanded===name?'':name)} aria-expanded={expanded===name}><Chevron open={expanded===name} /><span>{name}</span></button></th>
        <td className="num">{allocated ? money(allocated) : 'Unallocated'}</td><td className="num">{money(floor)}</td><td className="num">{money(granted)}</td><td className="num strong">{allocated ? money(Math.max(0,allocated-floor-granted)) : '—'}</td><td className="num">{money(spent)}{unknown>0&&<small className="warning">+ {unknown} unknown</small>}</td>
      </tr>{expanded===name&&<tr className="review-child-row"><td colSpan={6}><section className="review-child" aria-label={`${name} funding details`}>
        <div className="review-section-heading"><div><h2>Envelopes{ name==='Auth Migration' ? ' · 3' : ''}</h2><p>{name==='Auth Migration'?'Sprint 10 · Session hygiene · granted by Sienna Garcia':'Funding assigned to people for sprint work'}</p></div></div>
        {name==='Auth Migration'?<Envelopes />:<p>{granted ? `${money(granted)} assigned. Holder detail is outside this review example.` : 'No envelopes in this review example.'}</p>}
        <div className="review-reserved"><div><h3>Reserved for automation</h3><p>{name==='Auth Migration'?'3 scheduled bots · auth-dep-watch, api-contract-watch, compliance-evidence-cron':'Scheduled maintenance funding'}</p></div><strong>{money(floor)}</strong></div>
        <p className="review-footnote">Unassigned = allocated − automation reserve − envelope grants. Spend is reported separately; it is not deducted a second time. Remaining envelope balances exclude unknown costs.</p>
      </section></td></tr>}</Fragment>)}</tbody>
    </table></div>
  </div>;
}
function WorkTable({ onOpen }: { onOpen: (id:string)=>void }) {
  const [query,setQuery]=useState('');
  const [closed,setClosed]=useState<string[]>([]);
  const rows=work.filter(w=>(w.title+' '+w.id+' '+w.owner).toLowerCase().includes(query.toLowerCase()));
  return <><div className="review-toolbar"><input aria-label="Find work" placeholder="Find work…" value={query} onChange={e=>setQuery(e.target.value)} /><span>Grouped by work status</span></div>
    <div className="review-table-wrap"><table className="review-table work" aria-label="Work items"><colgroup><col style={{width:'46%'}} /><col style={{width:'18%'}} /><col style={{width:'18%'}} /><col style={{width:'18%'}} /></colgroup><thead><tr><th>Work item</th><th>Owner</th><th>Agent</th><th className="num">Cost</th></tr></thead><tbody>
      {['Next up','In progress','In review'].map(group=>{const items=rows.filter(w=>w.group===group);return items.length>0&&<Fragment key={group}>
        <tr className="review-group"><th colSpan={4}><button onClick={()=>setClosed(closed.includes(group)?closed.filter(g=>g!==group):[...closed,group])} aria-expanded={!closed.includes(group)}><Chevron open={!closed.includes(group)} />{group}<span>{items.length}</span></button></th></tr>
        {!closed.includes(group)&&items.map(w=><tr key={w.id}><th scope="row"><button className="review-work-link" onClick={()=>onOpen(w.id)}><span className="review-work-title">{w.title}</span><span className="review-work-meta"><span className="review-id">{w.id}</span><span>{w.type} · {w.pts} pts</span></span></button>{w.id.endsWith('-8')&&<small className="warning">Blocked · awaiting cutover decision</small>}</th><td>{w.owner}</td><td><Status tone={w.stage==='Running'?'info':w.stage==='Needs review'?'warning':''}>{w.stage}</Status>{w.stage!=='Not started'&&<small>{w.note}</small>}</td><td className="num">{w.cost}<small>{w.basis}</small></td></tr>)}
      </Fragment>})}
      {rows.length===0&&<tr><td colSpan={4}>No work matches “{query}”.</td></tr>}
    </tbody></table></div><p className="review-footnote">4 open work items shown · 3 completed items omitted from this detail study.</p></>;
}
function Work() {
  const [item,setItem]=useState<string|null>(null);
  const selected=work.find(w=>w.id===item);
  return <div className="review-page"><Note />{selected?<><Button variant="ghost" size="sm" onClick={()=>setItem(null)}>← All work</Button><header className="review-heading"><div><p className="review-id">{selected.id}</p><h1>{selected.title}</h1><p>{selected.owner} · {selected.type} · {selected.pts} points</p></div></header><div className="review-summary"><Status>{selected.group}</Status><span>{selected.cost} {selected.basis.toLowerCase()}</span></div><section className="review-detail-section"><h2>Next action</h2><p>{selected.note}</p><p className="review-footnote">This preview demonstrates the list-to-record transition. No work item is modified.</p></section></>:<><div className="review-section-heading"><h2>Work <span className="muted">7</span></h2><span>2 next up · 1 in progress · 1 in review · 3 done</span></div><div className="review-summary compact"><span>Your envelope · Sprint 10</span><span><b>$12.28</b> remaining</span><span>$0.30 reserved</span></div><WorkTable onOpen={setItem}/></>}</div>;
}
function Sprints() {
  const [selected,setSelected]=useState('Session hygiene');
  const [tab,setTab]=useState('Envelopes');
  const [query,setQuery]=useState('');
  const rows=[['Sprint 5 — Inventory','Zero Trust Network','4 Nov','$8.00'],['Sprint 6 — Format decision','Data Lake Migration','1 Nov','$10.00'],['Sprint 11 — Span metrics + decom','Observability Platform','28 Oct','$30.00'],['Sprint 10 — Session hygiene','Auth Migration','3 Nov','$45.00'],['Sprint 9 — Judge + evals','LLM Application Platform','28 Oct','$35.00'],['Sprint 9 — Queue-depth scaling','Inference Platform','28 Oct','$15.00'],['Sprint 10 — Attribution','Cost Optimization','28 Oct','$20.00']];
  return <div className="review-page"><Note/><div className="review-section-heading"><h2>Active sprints</h2><span>7 shown in this study</span></div><div className="review-toolbar"><input placeholder="Search sprints…" aria-label="Search sprints" value={query} onChange={e=>setQuery(e.target.value)}/></div><div className="review-table-wrap"><table className="review-table" aria-label="Sprints"><colgroup><col style={{width:'42%'}}/><col style={{width:'30%'}}/><col style={{width:'14%'}}/><col style={{width:'14%'}}/></colgroup><thead><tr><th>Sprint</th><th>Initiative</th><th>Ends</th><th className="num">Granted</th></tr></thead><tbody>{rows.filter(r=>r.join(' ').toLowerCase().includes(query.toLowerCase())).map(([title,initiative,end,grant])=>{const open=title.includes(selected)&&!!selected;return <Fragment key={title}><tr className={open?'selected':''}><th scope="row"><button className="review-row-link" onClick={()=>setSelected(open?'':title.split(' — ')[1])} aria-expanded={open}><Chevron open={open}/><span>{title}</span></button></th><td>{initiative}</td><td>{end}</td><td className="num">{grant}</td></tr>{open&&<tr className="review-child-row"><td colSpan={4}><section className="review-child"><div className="review-section-heading"><div><h2>{title}</h2><p>{initiative} · {initiative==='Auth Migration'?'Nora DaSilva, steward · ':''}ends {end}</p></div><Status tone="info">Active</Status></div>{initiative==='Auth Migration'?<><Tabs items={['Work','Envelopes']} value={tab} onChange={setTab}/>{tab==='Envelopes'?<><div className="review-section-heading"><h3>Envelope balances</h3><span>3 holders</span></div><Envelopes/><p className="review-footnote">$2.24 spent outside envelopes this sprint. Unknown costs are excluded from the remaining balances.</p></>:<WorkTable onOpen={()=>{window.location.href='work.html'}}/>}</>:<p>Additional sprint records are outside this detail study.</p>}</section></td></tr>}</Fragment>})}</tbody></table></div></div>;
}
function Run() {
  const [tab,setTab]=useState('Timeline');
  const steps=[['Queued','07:47:41','Scheduled by inference-canary-nightly.'],['Computer ready','07:48:53','box-2 claimed the job; workspace prepared.'],['Run completed','07:52:00','Compared build 412 with build 411 across four models.'],['Result saved','07:52:00','Canary report and commit available.']];
  return <div className="review-page"><Note/><header className="review-heading"><div><h1>inference-canary-nightly</h1><p>Inference Platform · Scheduled run · 28 October 2026</p></div><Status tone="success">Completed</Status></header><div className="review-summary"><span><b>3m 7s</b> execution</span><span><b>$0.20</b> recorded cost</span><span><b>3</b> turns</span><span>Nova · box-2</span></div>
    <section className="review-outcome"><h2>Canary checks passed</h2><p>Build 412 stayed within 2% of build 411’s p95 latency. Error rate was 0.04% across the four tested models.</p><button onClick={()=>setTab('Outputs')}>View canary report →</button></section>
    <Tabs items={['Overview','Timeline','Outputs']} value={tab} onChange={setTab}/>
    {tab==='Timeline'?<section className="review-detail-section"><div className="review-section-heading"><h2>Execution timeline</h2><span>All stages complete</span></div><WorkflowStepper size="compact" steps={steps.map(([label],i)=>({step:i+1,label,done:true,active:false}))} aria-label="Completed run stages"/>
      <ol className="review-timeline" aria-label="Run events">{steps.map(([label,time,description],i)=><li key={label}><span className="review-complete" aria-label="Succeeded"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 8 3 3 5-6" fill="none" stroke="currentColor" strokeWidth="1.8"/></svg></span><div className="review-event"><div className="review-section-heading"><h3>{label}</h3><time>{time}</time></div><p>{description}</p>{i===2&&<details><summary>View 5 execution steps</summary><ol className="review-tool-events">{[['Read inputs','read_file × 3','07:49:04'],['Write canary report','edit_file · canary/report.md','07:49:21'],['Validate thresholds','run_tests · passed in 1m 12s','07:50:42'],['Commit report','git_commit · 1 file changed','07:51:38'],['Complete run','3 turns · $0.20 recorded','07:52:00']].map(([a,b,c])=><li key={a}><div><strong>{a}</strong><small>{b}</small></div><time>{c}</time></li>)}</ol></details>}{i===3&&<button className="review-text-button" onClick={()=>setTab('Outputs')}>Open outputs →</button>}</div></li>)}</ol>
    </section>:tab==='Overview'?<section className="review-detail-section"><h2>Run details</h2><dl className="review-facts"><div><dt>Trigger</dt><dd>Nightly schedule</dd></div><div><dt>Attempt</dt><dd>1 of 1</dd></div><div><dt>Funding</dt><dd>Inference Platform automation budget</dd></div><div><dt>Cost</dt><dd>$0.20 recorded · $0.20 forecast</dd></div></dl></section>:<section className="review-detail-section"><h2>Outputs</h2><details open><summary>canary/report.md</summary><p>Build 412 vs 411 · four models tested · all canary thresholds passed.</p><p className="review-footnote">Report preview is illustrative.</p></details><div className="review-reserved"><span>Commit · canary: build 412 vs 411</span><span>1 file changed</span></div></section>}
  </div>;
}
function Dispatch() {
  const [mode,setMode]=useState<'agent'|'chat'>('agent');
  const [step,setStep]=useState<'blocked'|'request'|'saved'|'model'|'cap'|'instruction'>('blocked');
  const [model,setModel]=useState('Haiku');
  const [cap,setCap]=useState('No cap');
  const [answer,setAnswer]=useState('');
  const [draft,setDraft]=useState<RichChatDraft>({html:'',files:[]});
  const [receipt,setReceipt]=useState('');
  const [instruction,setInstruction]=useState('Stop duplicate alerts during a dependency outage. Preserve the first alert and the recovery notification.');
  const choose=(id:string)=>{setReceipt('');setAnswer('');if(id==='request')setStep('request');else if(id==='save'){setStep('saved');setReceipt('Draft saved in this preview. No job was dispatched.');}else setStep(id as typeof step);};
  const prompt:ComposerPrompt={id:`dispatch-${step}`,eyebrow:'Agent response · ORG-OBS-11',title:step==='blocked'?'A sprint envelope is required':step==='request'?'Request an envelope from Sienna Garcia?':step==='model'?'Choose a model':step==='saved'?'Draft saved':step==='cap'?'Set a run cap':'Edit the job instruction',question:step==='blocked'?'Nora has no active envelope on Observability Platform. How would you like to proceed?':step==='request'?'The request will include this work item and its $0.03–$0.30 forecast.':step==='model'?'The estimate will need to be recalculated after changing the model.':step==='saved'?'You can return to this draft after an envelope is granted.':step==='cap'?'Enter the maximum cost in USD.':'Describe what the agent should change.',kind:step==='cap'?'number':step==='instruction'?'text':'choice',options:step==='blocked'?[{id:'request',label:'Request envelope',emphasis:'primary'},{id:'save',label:'Save draft'},{id:'model',label:'Change model'}]:step==='request'?[{id:'confirm',label:'Preview request',emphasis:'primary'},{id:'back',label:'Back'}]:step==='model'?[{id:'Haiku',label:'Haiku'},{id:'Nova',label:'Nova'},{id:'back',label:'Back'}]:step==='saved'?[{id:'back',label:'Return to preparation'}]:[],onAnswer:a=>{if(!('optionId'in a))return;const id=a.optionId;if(id==='back')setStep('blocked');else if(id==='confirm'){setReceipt('Request preview: Sienna, please grant Nora an envelope for ORG-OBS-11. Forecast $0.03–$0.30. Nothing has been sent.');setStep('saved');}else if(step==='model'){setModel(id!);setStep('blocked');}else choose(id!);}};
  const composer=<div className="review-composer" data-review-composer data-mode={mode}>
    <div className="review-composer-heading"><strong>{mode==='agent'?'Agent dialogue':'Initiative discussion'}</strong><button onClick={()=>setMode(mode==='agent'?'chat':'agent')}>{mode==='agent'?'Switch to discussion':'Return to agent response'}</button></div>
    {mode==='agent'?<><ComposerPromptDeck key={prompt.id} prompts={[prompt]} variant="inset" data-testid="review-prompt"/>{(step==='cap'||step==='instruction')&&<form className="review-answer" onSubmit={e=>{e.preventDefault();if(step==='cap'){if(!Number.isFinite(Number(answer))||Number(answer)<=0)return;setCap(money(Number(answer)));}else setInstruction(answer);setStep('blocked');}}><label htmlFor="agent-answer">{step==='cap'?'Run cap (USD)':'Job instruction'}</label><input id="agent-answer" value={answer} type={step==='cap'?'number':'text'} min="0.01" step="0.01" required onChange={e=>setAnswer(e.target.value)}/><Button type="submit" size="sm">Save answer</Button><Button variant="ghost" size="sm" onClick={()=>setStep('blocked')}>Cancel</Button></form>}{receipt&&<p className="review-receipt" role="status">{receipt}</p>}</>:<RichChatComposer draft={draft} onDraftChange={setDraft} onSend={()=>{setReceipt('Discussion message previewed locally. Nothing was sent.');return false;}} toolbar="basic" placeholder="Discuss this work with the initiative…" inputLabel="Initiative discussion message" allowAttachments={false} allowEmoji={false}/>}
    {mode==='chat'&&receipt&&<p className="review-receipt" role="status">{receipt}</p>}
  </div>;
  return <><div className="review-page"><Note/><header className="review-heading"><div><p className="review-id">ORG-OBS-11 · Bug · 2 points</p><h1>Stop duplicate alerts during a dependency outage</h1><p>Observability Platform · Eli Garcia</p></div></header><Tabs items={['Prepare job']} value="Prepare job" onChange={()=>{}}/><section className="review-detail-section"><div className="review-section-heading"><h2>Dispatch readiness</h2><Status tone="warning">Needs funding</Status></div><WorkflowStepper size="compact" steps={[{step:1,label:'Estimate',done:true,active:false},{step:2,label:'Funding',done:false,active:true},{step:3,label:'Confirm',done:false,active:false},{step:4,label:'Queue',done:false,active:false}]} aria-label="Dispatch readiness"/>
    <div className="review-warning"><strong>Missing sprint envelope</strong><p>Nora needs an active envelope on this initiative before the job can be queued.</p></div>
    <div className="review-section-heading"><h2>Job settings</h2><span>Ready for review</span></div><dl className="review-facts"><div><dt>Codebase</dt><dd>connorhoehnslalom/orgiq-observability</dd></div><div><dt>Model</dt><dd>{model} <button onClick={()=>{setMode('agent');setStep('model')}}>Change</button></dd></div><div><dt>Run cap</dt><dd>{cap} <button onClick={()=>{setMode('agent');setStep('cap');setAnswer('')}}>Change</button></dd></div><div><dt>Forecast</dt><dd>{model==='Haiku'?'$0.03–$0.30 · 1–6 minutes':'Recalculation required'}<small>{model==='Haiku'?'Wide prior · limited history on this codebase':''}</small></dd></div></dl><details><summary>Job instruction <button onClick={e=>{e.preventDefault();setMode('agent');setStep('instruction');setAnswer(instruction)}}>Edit</button></summary><p>{instruction}</p></details></section></div>{document.getElementById('review-composer')&&createPortal(composer,document.getElementById('review-composer')!)}</>;
}

export { Budget, Work, Sprints, Run, Dispatch, Envelopes, Status, Note, Chevron, money, envelopes, budgetRows, work };
