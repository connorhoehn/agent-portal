import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Avatar, Button, DensityProvider, RailNavList } from '@connorhoehn/ui-components/shared';
import { Work, WorkRows, ItemDetail, Rail, setRoute } from './v4-pages';
import { DispatchV5 } from './dispatch-v5';
import { money, envelopes, budgetRows, work, Status } from './revision3';
import './revision5.css';

function FundingTable() {
  const lastUsed=['Last used 2h ago','Last used 12m ago','Not used yet'];
  return <div className="review-table-wrap"><table className="review-table v5-funding-table" aria-label="Sprint envelopes"><colgroup><col style={{width:'36%'}}/>{[1,2,3,4].map(i=><col key={i} style={{width:'16%'}}/>)}</colgroup><thead><tr><th>Person</th><th className="num">Granted</th><th className="num">Reserved</th><th className="num">Spent</th><th className="num">Remaining</th></tr></thead><tbody>{envelopes.map((e,i)=><tr key={e.name}><th scope="row"><div className="v5-person"><Avatar name={e.name} size={30}/><div><strong>{e.name}</strong><em className="v5-last-used">{lastUsed[i]}</em></div></div></th><td className="num">{money(e.grant)}</td><td className="num">{money(e.reserved)}</td><td className="num">{money(e.spent)}</td><td className="num strong">{money(e.grant-e.reserved-e.spent)}</td></tr>)}</tbody><tfoot><tr><th>Total</th>{['grant','reserved','spent','remaining'].map(k=><td key={k} className="num">{money(envelopes.reduce((n,e)=>n+(k==='remaining'?e.grant-e.reserved-e.spent:e[k as 'grant'|'reserved'|'spent']),0))}</td>)}</tr></tfoot></table></div>;
}
function BudgetV5() {
  const [selected,setSelected]=useState('Auth Migration');
  const [query,setQuery]=useState('');
  const current=budgetRows.find(r=>r[0]===selected);
  const choose=(name:string)=>{setSelected(name);setRoute(`budget/${name.toLowerCase().replaceAll(' ','-')}`);};
  return <><Rail><div className="refine-rail-heading"><span>Budgets · October 2026</span><strong>Initiative funding</strong></div>
    <div className="v5-rail-section"><div className="v5-program-total"><strong>{money(budgetRows.reduce((n,r)=>n+r[1],0))}</strong><span>allocated across 14 initiatives</span></div></div>
    <RailNavList currentStyle="tint" aria-label="Budget views" items={[{id:'overview',label:'All initiatives',current:!current,onSelect:()=>choose('')}]} />
    <div className="v5-rail-search"><input aria-label="Find initiative" placeholder="Find initiative…" value={query} onChange={e=>setQuery(e.target.value)}/></div>
    <RailNavList currentStyle="tint" aria-label="Initiative budgets" items={budgetRows.filter(r=>r[0].toLowerCase().includes(query.toLowerCase())).map(r=>({id:r[0],label:r[0],current:r[0]===selected,onSelect:()=>choose(r[0])}))}/>
    <details className="refine-rail-about"><summary>Balance definitions</summary><p>Unassigned = allocation − automation reserve − envelope grants.</p><p>Envelope remaining = granted − reserved − recorded spend. Unknown costs are excluded.</p></details>
  </Rail><div className="review-page v5-budget">
    {current?<><header className="review-heading"><div><p className="v5-eyebrow">Budget · October 2026</p><h1>{current[0]}</h1></div></header>
      <dl className="v5-balances">{[['Allocation',current[1]],['Automation reserve',current[2]],['Envelope grants',current[3]],['Unassigned',current[1]?Math.max(0,current[1]-current[2]-current[3]):null]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value===null?'—':money(Number(value))}</dd></div>)}</dl>
      <section className="v5-funding-section"><header><div><h2>People & envelopes</h2><p>{selected==='Auth Migration'?'Sprint 10 · Session hygiene · ends 3 Nov':'Sprint funding'}</p></div>{selected==='Auth Migration'&&<span>3 people</span>}</header>
        {selected==='Auth Migration'?<><FundingTable/><div className="v5-funding-meta"><span>Granted by Sienna Garcia</span><span className="warning">Nora · 1 run has no recorded cost</span></div></>:<p className="review-footnote">{current[3]?`${money(current[3])} granted. This preview includes person-level detail for Auth Migration.`:'No envelopes in this example.'}</p>}
      </section>
      <section className="v5-automation"><div><h2>Scheduled automations</h2><p>{selected==='Auth Migration'?'3 bots · always reserved':'Automation reserve'}</p></div><strong>{money(current[2])}</strong>{selected==='Auth Migration'&&<details><summary>View automations</summary><ul><li>auth-dep-watch</li><li>api-contract-watch</li><li>compliance-evidence-cron</li></ul></details>}</section>
      <div className="v5-budget-footer"><span><strong>{money(current[4])}</strong> recorded spend across this initiative</span>{current[5]>0&&<span>{current[5]} {current[5]===1?'run':'runs'} with unknown cost</span>}</div>
    </>:<><header className="review-heading"><div><p className="v5-eyebrow">Budget · October 2026</p><h1>All initiatives</h1></div></header><div className="review-table-wrap"><table className="review-table" aria-label="Budget overview"><colgroup><col style={{width:'43%'}}/>{[1,2,3].map(i=><col key={i} style={{width:'19%'}}/>)}</colgroup><thead><tr><th>Initiative</th><th className="num">Allocated</th><th className="num">Unassigned</th><th className="num">Spent</th></tr></thead><tbody>{budgetRows.map(r=><tr key={r[0]}><th scope="row"><button className="review-row-link" onClick={()=>choose(r[0])}>{r[0]}</button></th><td className="num">{money(r[1])}</td><td className="num">{r[1]?money(Math.max(0,r[1]-r[2]-r[3])):'—'}</td><td className="num">{money(r[4])}</td></tr>)}</tbody></table></div></>}
    <p className="v5-preview-note">Design preview · sample balances and activity.</p>
  </div></>;
}
function InitiativeWork() {
  const [view,setView]=useState('Active sprint');
  const [item,setItem]=useState<typeof work[number]|null>(null);
  const navigate=(v:string)=>{setView(v);setItem(null);setRoute(`initiatives/auth/work/${v.toLowerCase().replaceAll(' ','-')}`);};
  return <><Rail><div className="refine-rail-heading"><span>Initiative</span><strong>Auth Migration</strong></div><div className="refine-rail-section"><h2>Work</h2><RailNavList currentStyle="tint" aria-label="Initiative work views" items={['All open work','Active sprint'].map(v=>({id:v,label:v,current:view===v,count:4,onSelect:()=>navigate(v)}))}/><div className="v5-active-sprint"><strong>Sprint 10 · Session hygiene</strong><span>Ends 3 Nov · Nora DaSilva</span></div></div><div className="refine-rail-section"><h2>Status</h2><RailNavList currentStyle="tint" aria-label="Work status" items={['Next up','In progress','In review'].map(v=>({id:v,label:v,current:view===v,count:work.filter(w=>w.group===v).length,onSelect:()=>navigate(v)}))}/></div><div className="refine-rail-section"><h2>Budget</h2><RailNavList currentStyle="tint" aria-label="Work budget" items={[{id:'envelopes',label:'Sprint envelopes',current:view==='Sprint envelopes',count:3,onSelect:()=>navigate('Sprint envelopes')}]} /></div><details className="refine-rail-about"><summary>About this initiative</summary><p>Consolidate login on Cognito and retire the legacy SAML shim.</p><p>Owner · Vera Green</p></details></Rail>
    <div className="review-page v5-initiative-work"><header className="review-heading"><div><p className="v5-eyebrow">Auth Migration</p><h1>{view}</h1><p>{view==='Active sprint'?'Sprint 10 — Session hygiene':'Work across this initiative'}</p></div>{view==='Active sprint'&&<Status tone="info">Ends 3 Nov</Status>}</header>
    {item?<ItemDetail item={item} back={()=>setItem(null)}/>:view==='Sprint envelopes'?<FundingTable/>:<WorkRows key={view} filter={view==='Active sprint'||view==='All open work'?'Open work':view} onOpen={w=>{setItem(w);setRoute(`initiatives/auth/work/${w.id}`);}}/>}
    {view==='All open work'&&!item&&<p className="review-footnote">This preview’s four open items are all in the active sprint.</p>}
    </div>
  </>;
}
const page=document.getElementById('review-content')!.dataset.page;
createRoot(document.getElementById('review-content')!).render(<DensityProvider density="compact">{page==='work'?<Work/>:page==='sprints'?<InitiativeWork/>:page==='budget'?<BudgetV5/>:<DispatchV5/>}</DensityProvider>);
