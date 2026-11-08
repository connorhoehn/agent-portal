import React, { useEffect, useRef, useState } from 'react';
import { Avatar, Button, WorkflowStepper } from '@connorhoehn/ui-components/shared';
import { ComposerPromptDeck, RichChatComposer, type ComposerPrompt, type RichChatDraft } from '@connorhoehn/ui-components/social/rich-composer';
import { Rail } from './v4-pages';
import { money } from './revision3';

type Step = 'funding'|'request'|'preview'|'model'|'cap'|'instruction'|'saved'|'ready'|'queued';
export function DispatchV5() {
  const [mode,setMode]=useState<'agent'|'chat'>('agent');
  const [step,setStep]=useState<Step>('funding');
  const [funded,setFunded]=useState(false);
  const [model,setModel]=useState('Haiku');
  const [cap,setCap]=useState('No cap');
  const [instruction,setInstruction]=useState('Stop duplicate alerts during a dependency outage. Preserve the first alert and the recovery notification.');
  const [answer,setAnswer]=useState('');
  const [draft,setDraft]=useState<RichChatDraft>({html:'',files:[]});
  const [receipt,setReceipt]=useState('');
  const surface=useRef<HTMLDivElement>(null);
  const typed=step==='cap'||step==='instruction';
  const next=()=>{setStep(funded?'ready':'funding');setAnswer('');};
  const edit=(s:Step)=>{setMode('agent');setStep(s);setAnswer(s==='instruction'?instruction:s==='cap'&&cap!=='No cap'?cap.slice(1):'');};
  useEffect(()=>{
    if(mode!=='agent')return;
    if(typed)document.getElementById('agent-answer')?.focus();
    else surface.current?.focus({preventScroll:true});
  },[step,mode,typed]);
  // The dialogue surface owns its shortcuts, including initial body focus.
  // Editable fields and unrelated controls retain their normal keyboard behavior.
  const input={
    isEmpty:()=>!typed,
    contains:(node:Node|null)=>node instanceof HTMLElement &&
      (node===document.body||!!surface.current?.contains(node)) &&
      !node.closest('input,textarea,select,[contenteditable="true"],button,a,summary'),
    focus:()=>surface.current?.focus({preventScroll:true}),
  };
  const titles:Record<Step,string>={funding:'This job needs a sprint envelope',request:'Request funding from Sienna?',preview:'Your request is ready to review',model:'Choose a model',cap:'Set a run cap',instruction:'Edit the job instruction',saved:'Saved for later',ready:'Ready to queue this job?',queued:'Job queued in this preview'};
  const options:ComposerPrompt['options']=step==='funding'?[{id:'request',label:'Request envelope',emphasis:'primary'},{id:'save',label:'Save for later'}]:step==='request'?[{id:'preview',label:'Preview request',emphasis:'primary'},{id:'back',label:'Back'}]:step==='model'?[{id:'Haiku',label:'Haiku'},{id:'Nova',label:'Nova'},{id:'back',label:'Cancel'}]:step==='ready'?[{id:'queue',label:'Queue job',emphasis:'primary',disabledReason:model!=='Haiku'?'Update the forecast before queueing.':undefined},{id:'save',label:'Save for later'}]:['saved','preview','queued'].includes(step)?[{id:'back',label:'Back to preparation'}]:[];
  const prompt:ComposerPrompt={id:`dispatch-${step}`,title:titles[step],question:step==='funding'?'Nora has no envelope on Observability Platform. Request funding to continue.':step==='request'?'Include ORG-OBS-11, Nora as the holder, and the current forecast.':step==='preview'?'Sienna, please grant Nora a sprint envelope for ORG-OBS-11 on Observability Platform.':step==='model'?'A different model needs a new forecast.':step==='cap'?'Maximum spend for this run, in USD.':step==='instruction'?'Describe the change and what must be preserved.':step==='ready'?`${model} · ${cap==='No cap'?'no run cap':cap+' cap'} · Nora’s sprint envelope`:step==='queued'?'The run handoff is illustrated here. No real job was created.':'Your settings are retained in this preview.',kind:step==='cap'?'number':step==='instruction'?'text':'choice',options,defaultOptionId:step==='funding'?'request':step==='request'?'preview':undefined,onAnswer:a=>{
    if(!('optionId'in a))return;
    const id=a.optionId;
    if(id==='back')next();else if(id==='save')setStep('saved');else if(id==='queue')setStep('queued');else if(step==='model'){setModel(id!);next();}else setStep(id as Step);
  }};
  return <>
    <Rail><div className="refine-rail-heading"><span>Initiative</span><strong>Observability Platform</strong></div>
      <section className="v5-rail-section"><h2>Job settings</h2><dl className="v5-job-settings">
        <div><dt>Model</dt><dd><strong>{model}</strong><button onClick={()=>edit('model')}>Change model</button></dd></div>
        <div><dt>Run cap</dt><dd><strong>{cap}</strong><button onClick={()=>edit('cap')}>Change cap</button></dd></div>
        <div><dt>Forecast</dt><dd><strong>{model==='Haiku'?'$0.03–$0.30':'Needs updating'}</strong>{model==='Haiku'&&<small>1–6 min · limited history</small>}</dd></div>
      </dl></section>
      <section className="v5-rail-section"><h2>Funding</h2><div className="v5-person"><Avatar name="Nora DaSilva" size={28}/><div><strong>Nora DaSilva</strong><span>{funded?'$12.00 available':'No active envelope'}</span></div></div><p className="v5-rail-note">{funded?'Illustrative funded state':'Sprint envelope required'}</p></section>
      <section className="v5-rail-section"><h2>Codebase</h2><p className="v5-repo">orgiq-observability</p><span className="v5-rail-note">connorhoehn</span></section>
      <div className="v5-preview-state"><label htmlFor="funding-preview">Preview funding state</label><select id="funding-preview" value={funded?'funded':'blocked'} onChange={e=>{const yes=e.target.value==='funded';setFunded(yes);setMode('agent');setStep(yes?'ready':'funding');}}><option value="blocked">Missing funding</option><option value="funded">Funding available</option></select></div>
    </Rail>
    <div className="review-page v5-dispatch">
      <header className="v5-dispatch-heading"><p className="review-id">ORG-OBS-11 <span>· Bug · 2 points</span></p><h1>Stop duplicate alerts during a dependency outage</h1><div className="v5-person v5-assignee"><Avatar name="Eli Garcia" size={22}/><span>Eli Garcia</span><span>· Observability Platform</span></div></header>
      <div className="v5-progress"><h2>Prepare job</h2><WorkflowStepper size="compact" steps={[{step:1,label:'Settings',done:true,active:false},{step:2,label:'Funding',done:funded,active:!funded},{step:3,label:'Queue',done:step==='queued',active:funded&&step!=='queued'}]} aria-label="Dispatch readiness"/></div>
      <section className="v5-instruction"><div><h2>Instruction</h2><button onClick={()=>edit('instruction')}>Edit instruction</button></div><p>{instruction}</p></section>
      <div id="review-composer" className="v5-dialogue" data-mode={mode}>
        <header><div><Avatar name={mode==='agent'?'Agent':'Nora DaSilva'} initials={mode==='agent'?'AI':undefined} size={26}/><strong>{mode==='agent'?'Agent':'Discussion'}</strong></div><button onClick={()=>setMode(mode==='agent'?'chat':'agent')}>{mode==='agent'?'Switch to discussion':'Return to agent response'}</button></header>
        <div ref={surface} tabIndex={-1} className="v5-response-surface" aria-label="Agent response">
        {mode==='agent'?<><ComposerPromptDeck key={step} prompts={[prompt]} input={input} variant="inset" data-testid="review-prompt"/>
          {typed&&<form className="review-answer" onSubmit={e=>{e.preventDefault();if(step==='cap')setCap(money(Number(answer)));else setInstruction(answer);next();}}><label htmlFor="agent-answer">{step==='cap'?'Run cap (USD)':'Job instruction'}</label>{step==='cap'?<input id="agent-answer" type="number" min="0.01" step="0.01" required value={answer} onChange={e=>setAnswer(e.target.value)}/>:<textarea id="agent-answer" rows={2} required value={answer} onChange={e=>setAnswer(e.target.value)}/>}<Button size="sm" type="submit">Save answer</Button><Button size="sm" variant="ghost" onClick={next}>Cancel</Button></form>}
          {step==='preview'&&<p className="review-receipt" role="status">{model==='Haiku'?'Forecast $0.03–$0.30.':'Forecast needs updating.'} Preview only; nothing sent.</p>}
        </>:<RichChatComposer draft={draft} onDraftChange={setDraft} onSend={()=>{setReceipt('Discussion draft preview only. Nothing sent.');return false;}} toolbar="basic" placeholder="Discuss this work…" inputLabel="Initiative discussion message" allowAttachments={false} allowEmoji={false}/>}
        </div>
        {receipt&&mode==='chat'&&<p className="review-receipt" role="status">{receipt}</p>}
      </div>
      <p className="v5-preview-note">Interactive preview · no jobs or messages are sent.</p>
    </div>
  </>;
}
