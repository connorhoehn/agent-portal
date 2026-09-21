import React,{useState,useRef} from 'react';
import {ConversationRail,ActivePeopleGrid,RailSectionHeader,SearchInput,IconButton,PlusIcon,ActivityIcon,AtIcon,Button} from './shared';

const at=(hours:number,minutes:number)=>{const date=new Date();date.setHours(hours,minutes,0,0);return date.toISOString()};
export const conversations=[
 {channel:'connor',kind:'dm' as const,name:'Connor Hoehn',peers:[{userId:'connor',displayName:'Connor Hoehn',online:true}],lastMessagePreview:'Yes — I’m adding that while v3 regenerates.',lastMessageAt:at(9,41)},
 {channel:'nora',kind:'dm' as const,name:'dev-nora',peers:[{userId:'nora',displayName:'dev-nora',online:false,color:'#14b8a6'}],lastMessagePreview:'perfect, that unblocks the inbox work',lastMessageAt:at(9,26)},
 {channel:'eve',kind:'dm' as const,name:'Eve Thompson',peers:[{userId:'eve',displayName:'Eve Thompson',online:false,color:'#10b981'}],lastMessagePreview:'can you review the recordings copy?',lastMessageAt:at(9,19)},
 {channel:'hank',kind:'dm' as const,name:'Hank Anderson',peers:[{userId:'hank',displayName:'Hank Anderson',online:false,color:'#14b8a6'}],lastMessagePreview:'it does, metadata rides the message',lastMessageAt:at(9,19)},
 {channel:'carol',kind:'dm' as const,name:'Carol Johnson',peers:[{userId:'carol',displayName:'Carol Johnson',online:true,color:'#f97316'}],lastMessagePreview:'appreciated',lastMessageAt:at(9,19)},
 {channel:'general',kind:'channel' as const,name:'general',peers:[],lastMessagePreview:'Carol Johnson: Shared the release notes',lastMessageAt:at(9,25)},
];
export function SocialRail({selected,onSelect,onOpenActivity,working,collapsed,setCollapsed}:any){
 const [search,setSearch]=useState('');
 const [folded,setFolded]=useState<Record<string,boolean>>({});
 const [creating,setCreating]=useState('');
 const [newName,setNewName]=useState('');
 const [teams,setTeams]=useState<string[]>([]);
 const [extra,setExtra]=useState<any[]>([]);
 const root=useRef<HTMLDivElement>(null);
 const toggle=(label:string,next:boolean)=>setFolded(current=>({...current,[label]:next}));
 const focusSearch=()=>{setCollapsed(false);requestAnimationFrame(()=>root.current?.querySelector<HTMLInputElement>('input[aria-label="Find a chat"]')?.focus())};
 const create=(e:React.FormEvent)=>{e.preventDefault();if(!newName.trim())return;if(creating==='team')setTeams([...teams,newName.trim()]);else setExtra([...extra,{channel:newName.trim(),kind:'channel',name:newName.trim(),peers:[],lastMessagePreview:'New channel · local preview',lastMessageAt:at(9,45)}]);setNewName('');setCreating('')};
 return <div ref={root} className={'social-rail-shell '+(collapsed?'is-collapsed':'')}>
  <ConversationRail title="Chat" className="social-conversation-rail" data-testid="social-rail" selected={selected} onSelect={onSelect}
   conversations={[...conversations,...extra].filter(c=>(c.name+' '+c.lastMessagePreview).toLowerCase().includes(search.toLowerCase()))}
   sectionOrder="dms-first" maxVisible={7} collapsedSections={folded} onToggleSection={toggle}
   collapsible collapsed={collapsed} onToggleCollapse={setCollapsed}
   actions={<IconButton size="sm" aria-label="New chat" onClick={focusSearch}><PlusIcon size={14}/></IconButton>}
   header={<SearchInput value={search} onChange={setSearch} placeholder="Find a chat" className="social-search"/>}
   shelf={[{id:'activity',label:'Activity',icon:<ActivityIcon size={15}/>},{id:'mentions',label:'Mentions',icon:<AtIcon size={15}/>}]}
   sectionActions={{'Direct messages':[{label:'New direct message',onClick:focusSearch}],Channels:[{label:'Create a channel',onClick:()=>setCreating('channel')}]}}
   beforeList={<>
    <RailSectionHeader label="Active now" collapsed={!!folded.active} onToggleCollapse={next=>toggle('active',next)}/>
    {!folded.active&&<ActivePeopleGrid people={[{userId:'connor',displayName:'Connor Hoehn',status:'online',activity:'Working on Sprint review',workSharing:{state:working?'active':'historical',fresh:working}}]} onSelectPerson={onOpenActivity} className="social-active-people" data-testid="rail-active-now"/>}
    <RailSectionHeader label="Teams" collapsed={!!folded.teams} onToggleCollapse={next=>toggle('teams',next)} actions={[{label:'Create a team',onClick:()=>setCreating('team')}]}/>
    {!folded.teams&&teams.map(name=><div className="local-team" key={name}>{name}</div>)}
    {creating&&<form className="rail-create-form" onSubmit={create}><label>{creating==='team'?'Team name':'Channel name'}<input autoFocus value={newName} onChange={e=>setNewName(e.target.value)}/></label><div><Button size="sm" type="submit">Create</Button><Button size="sm" variant="ghost" onClick={()=>setCreating('')}>Cancel</Button></div></form>}
   </>}/>
 </div>
}
