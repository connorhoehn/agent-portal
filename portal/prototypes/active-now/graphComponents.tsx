import React from 'react';
import {Handle, Position} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '@connorhoehn/ui-components/styles.css';
import {BaseNode,AgentNode,ServerStepNode,AnimatedEdge,PipelineNodeRuntimeProvider,portCls,Button,IconButton,ChatIcon,TitledFrame,Chip} from './shared';
import {FailureRain} from './FailureRain';
import './node-content.css';

export const slideTitles=['Executive summary','Delivery progress','Scope and milestones','Release readiness','Test coverage','Risks and mitigations','Ownership','Rollback plan','Customer impact','Open questions','Next steps','Appendix'];
function Slide({version=2,small=false,slide=4}:{version?:number,small?:boolean,slide?:number}) {return <div className={'slide '+(small?'small':'')}><div className="slide-eyebrow">SPRINT REVIEW · V{version}</div><strong>{slideTitles[slide-1]??'Release readiness'}</strong><div className="slide-rule"/><div className="slide-columns"><div><span>{slide===4?'Delivery progress':slide===6?'Mitigation status':'Project update'}</span><i/><i/><i/></div><div className="bars"><b/><b/><b/><b/></div></div><div className="slide-bottom">PRODUCT & ENGINEERING <span>{String(slide).padStart(2,'0')} / 12</span></div></div>}
export function ResourceNode({id,data,selected}:any){
 const transcript=id==='transcript';
 const meeting=id==='meeting';
 return <div className={"resource-node "+(transcript?'transcript-resource ':'')+(meeting?'meeting-resource ':'')+(data.condensed?"condensed-node":"")}>
  <BaseNode icon={data.icon} subtitle={data.title} category={data.category} state={data.state??'idle'} selected={selected} ariaLabel={transcript?'Transcript from Planning sync, two speakers, one action item':meeting?'Planning sync meeting, recorded, Connor, Frank, and Grace attended':data.title}
   body={<>{meeting?<div className="meeting-node-detail"><div className="meeting-time">08:30–09:00 · 30 min</div><div className="meeting-people" aria-label="Attendees: Connor, Frank, Grace"><span className="attendee-avatar">CH</span><span className="attendee-avatar frank">FD</span><span className="attendee-avatar grace">GW</span><span className="attendee-count">Connor, Frank +1</span></div><div className="meeting-recorded"><span className="recording-icon"><span/></span>Recorded · transcript available</div></div>:transcript?<div className="transcript-node-detail"><div className="transcript-node-meta"><span>Planning sync · 08:30–09:00</span><span>Ready</span></div><p>“Review release risks before noon”</p><div className="transcript-node-summary"><span>2 speakers</span><span>1 action item</span></div></div>:<p className={'node-description '+(data.compact?'compact-description':'')}>{data.text}</p>}
    {data.slide&&<><Slide version={data.slide} small/><div className="node-versions">{(data.availableVersions??[1,2]).map((version:number)=><span key={version} className={data.slide===version?'current-version':''}>v{version}</span>)}{data.generatingVersion&&<span className="current-version">v{data.generatingVersion} generating</span>}</div></>}
    {!data.compact&&data.tag&&<span className={'node-tag '+(data.state==='running'?'is-live':'')}>{data.tag}</span>}
   </>}
   footer={!data.compact&&data.time?<div className="node-footer"><span>{data.time}</span><span>Shared</span></div>:undefined}>
   <Handle type="target" position={Position.Left} id="in" className={portCls('data')}/>
   <Handle type="source" position={Position.Right} id="out" className={portCls('data')}/>
   <Handle type="source" position={Position.Bottom} id="down" className={portCls('data')}/>
   <Handle type="target" position={Position.Top} id="up" className={portCls('data')}/>
  </BaseNode>
  {data.feedbackCount>0&&<IconButton size="sm" className="node-feedback nodrag nopan" aria-label={`Open ${data.feedbackCount} feedback messages in chat`} title="Feedback · Open in left chat" onClick={e=>{e.stopPropagation();data.onFeedback?.()}}><ChatIcon size={14}/><span className="feedback-count">{data.feedbackCount}</span></IconButton>}
 </div>
}
function AgentWithTools(props:any){
 if(!props.data.showTools)return <AgentNode {...props}/>;
 return <div className={'generation-node '+(props.data._state==='failed'?'failed-generation-node':'')}><AgentNode {...props}/>{props.data._state==='failed'&&<FailureRain/>}<div className="generation-tools"><span>Tools</span>{props.data.allowedTools.map((tool:string)=><Chip key={tool} size="xs" tone="neutral">{tool}</Chip>)}</div><Handle type="target" position={Position.Top} id="notes" className={portCls('data')}/></div>
}
function ActivityFrame({data}:any){return <TitledFrame tone="surface" className={'effort-frame '+(data.live?'live-effort':'')} style={{width:data.width,height:data.height}}
 title={<span className="effort-title">{data.live&&<i/>}{data.title}</span>}
 titleAction={<>{data.sourceCount>0&&<Button size="sm" variant="ghost" className="effort-action nodrag nopan" aria-label={`${data.collapsed?'Show':'Hide'} ${data.sourceCount} sources for ${data.title}`} onClick={e=>{e.stopPropagation();data.onToggleSources?.()}}>{data.collapsed?`+ ${data.sourceCount} sources`:'Sources'}</Button>}<Button size="sm" variant="ghost" className="effort-action nodrag nopan" aria-label={`${data.focused?'Show all activities':'Focus on '+data.title}`} onClick={e=>{e.stopPropagation();data.onFocus?.()}}>{data.focused?'All activities':'Focus'}</Button></>}
 data-testid={`effort-${data.group}`}><div className="effort-detail">{data.sub}</div></TitledFrame>}
const nodeTypes={resource:ResourceNode,agent:AgentWithTools,server:ServerStepNode,activityFrame:ActivityFrame};
const edgeTypes={existing:AnimatedEdge};
export {nodes,edges} from './graphData.mjs';
export {nodeTypes,edgeTypes,Slide};
