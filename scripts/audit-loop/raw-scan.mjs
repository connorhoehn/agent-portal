import fs from 'fs'; import path from 'path';
const root='portal/src'; const files=[];
(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory()){if(e.name!=='__tests__'&&e.name!=='node_modules')w(p)}else if(/\.tsx$/.test(e.name)&&!/\.test\./.test(e.name))files.push(p)}})(root);
const TAGS=new Set('div span p h1 h2 h3 h4 h5 h6 ul ol li section nav article aside header footer main table thead tbody tr td th button a label input textarea select form code pre img svg canvas dl dt dd details summary video audio'.split(' '));
const res={};
// Blank whole-line // comments and /* */ blocks so commented-out JSX is not
// counted. Quotes are deliberately not tracked: an apostrophe in JSX text
// ("don't") would otherwise hide every tag after it.
const stripComments=src=>src.replace(/\/\*[\s\S]*?\*\//g,m=>m.replace(/[^\n]/g,' ')).replace(/^[ \t]*\/\/.*$/gm,'');
for(const f of files){const s=stripComments(fs.readFileSync(f,'utf8'));let i=0;const c={};let tot=0,cls=0;
 while((i=s.indexOf('<',i))>=0){const m=/^<([a-z][a-z0-9]*)(?=[\s>\/])/.exec(s.slice(i,i+20));if(!m){i++;continue}
  // brace-aware tag end
  let j=i+m[0].length,d=0,q=null;for(;j<s.length;j++){const ch=s[j];if(q){if(ch===q)q=null;continue}if(d===0&&(ch==='"'||ch==="'")){q=ch;continue}if(ch==='{')d++;else if(ch==='}')d--;else if(ch==='>'&&d===0)break}
  const tag=s.slice(i,j+1);const t=m[1];
  if(TAGS.has(t)){tot++;c[t]=(c[t]||0)+1;if(/className=/.test(tag))cls++}
  i=j+1}
 if(tot)res[f]={tot,cls,c}}
const rows=Object.entries(res).sort((a,b)=>b[1].tot-a[1].tot);
const agg={};for(const [f,r] of rows){for(const [t,n] of Object.entries(r.c))agg[t]=(agg[t]||0)+n}
console.log('files with raw:',rows.length,'of',files.length,'total raw tags',rows.reduce((a,[,r])=>a+r.tot,0));
console.log(JSON.stringify(agg));
const areas={};for(const [f,r] of rows){const a=f.split('/').slice(2,4).join('/');areas[a]=(areas[a]||0)+r.tot}
console.log(Object.entries(areas).sort((a,b)=>b[1]-a[1]).slice(0,25).map(x=>x.join(' ')).join('\n'));
console.log('--top files');for(const [f,r] of rows.slice(0,40))console.log(r.tot,r.cls,f.replace('portal/src/',''),JSON.stringify(r.c));
