import React, { useEffect, useRef, useState } from 'react';
import { Button, Textarea } from '@connorhoehn/ui-components/shared';
import './budget-request-flow.css';

export function DecisionPath({ stage }: { stage:'choose'|'draft'|'confirm'|'done'|'saved' }) {
  const steps=stage==='saved'?['Choose','Saved']:['Choose','Draft request','Confirm','Done'];
  const current=stage==='saved'?1:['choose','draft','confirm','done'].indexOf(stage);
  return <ol className="request-flow-path" aria-label="Decision path">{steps.map((label,i)=><li key={label} aria-current={i===current?'step':undefined} data-complete={i<current}><span aria-hidden="true" className="request-flow-node">{i<current?'✓':i+1}</span><span>{label}</span>{i<steps.length-1&&<span className="request-flow-edge" aria-hidden="true">→</span>}</li>)}</ol>;
}

export function BudgetRequestFlow({message,onMessageChange,onBack}:{message:string;onMessageChange:(value:string)=>void;onBack:()=>void}) {
  const [stage,setStage]=useState<'draft'|'confirm'|'done'>('draft');
  const editor=useRef<HTMLTextAreaElement>(null);
  const confirmation=useRef<HTMLElement>(null);
  const result=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(stage==='draft')editor.current?.focus({preventScroll:true});
    else if(stage==='confirm')confirmation.current?.focus({preventScroll:true});
    else result.current?.focus({preventScroll:true});
  },[stage]);
  const review=()=>{if(message.trim())setStage('confirm');};
  return <div className="request-flow">
    <DecisionPath stage={stage}/>
    {stage==='done'?<div className="request-flow-result" ref={result} tabIndex={-1} role="status"><strong>Request confirmed</strong><p>To Sienna Garcia · ORG-OBS-11</p><p>Preview only. No request was sent.</p><Button variant="ghost" size="sm" onClick={onBack}>Back to preparation</Button></div>:stage==='confirm'?<section className="request-flow-confirm" ref={confirmation} tabIndex={-1} aria-labelledby="request-confirm-title" onKeyDownCapture={e=>{
      // Hold/repeat cannot skip review; keyboard handling stays inside this box.
      if(e.key==='Enter'&&(e.repeat||e.nativeEvent.isComposing)){e.preventDefault();e.stopPropagation();}
    }} onKeyDown={e=>{
      if(e.defaultPrevented)return;
      if(e.key==='Escape'){e.preventDefault();setStage('draft');}
      else if(e.key==='Enter'&&e.target===e.currentTarget&&!e.shiftKey&&!e.metaKey&&!e.ctrlKey&&!e.altKey){e.preventDefault();setStage('done');}
    }}>
      <div className="request-flow-title"><strong id="request-confirm-title">Confirm budget request</strong><span>To Sienna Garcia · ORG-OBS-11</span></div>
      <p>{message}</p>
      <div className="request-flow-actions"><Button size="sm" onClick={()=>setStage('done')}>Confirm request</Button><Button size="sm" variant="ghost" onClick={()=>setStage('draft')}>Back to message</Button><span>Enter to confirm · Esc to edit</span></div>
      <small>Local preview — no request will be sent.</small>
    </section>:<form className="request-flow-draft" onSubmit={e=>{e.preventDefault();review();}}>
      <div className="request-flow-title"><strong>Request more budget</strong><span>To Sienna Garcia · ORG-OBS-11</span></div>
      <label htmlFor="budget-request-message">Message</label>
      <Textarea ref={editor} id="budget-request-message" rows={2} required value={message} onChange={e=>onMessageChange(e.target.value)} placeholder="Add context for your budget request…" onKeyDown={e=>{
        if(e.key==='Enter'&&!e.shiftKey&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!e.nativeEvent.isComposing){e.preventDefault();e.stopPropagation();if(!e.repeat)review();}
      }}/>
      <div className="request-flow-actions"><Button size="sm" type="submit" disabled={!message.trim()}>Continue</Button><Button size="sm" type="button" variant="ghost" onClick={onBack}>Back</Button><span>Enter to continue · Shift+Enter for a new line</span></div>
    </form>}
  </div>;
}
