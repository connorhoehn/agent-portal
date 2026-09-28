import { Link, useNavigate } from 'react-router';
import { Button, Inline, Stack } from '@connorhoehnslalom/ui-components/shared';
import { readSearchEvidence } from './searchModel';
import { recordKey, SEARCH_LABELS } from './searchTypes';
export function SearchEvidence({ toolCalls }: {toolCalls?: Array<{name:string;result?:string}>}) {
  const records = readSearchEvidence(toolCalls);
  const navigate = useNavigate();
  if (!records.length) return null;
  return <Stack gap="sm" className="ml-0 sm:ml-11" data-testid="search-evidence">
    {(['person','work'] as const).map(type => {
      const rows = records.filter(r=>r.type===type);
      if (!rows.length) return null;
      return <Stack key={type} gap="none">
        <span className="text-sm font-semibold py-2">{type==='person'?'People in context':'Work to coordinate'}</span>
        <div className="border border-border rounded-md overflow-hidden">
          {rows.map(r=><Link key={recordKey(r)} to={r.href} className="flex items-center gap-3 px-3 py-2 border-b last:border-b-0 border-border hover:bg-surface-hover text-sm">
            <span className="rounded-full bg-primary/10 text-primary w-8 h-8 flex items-center justify-center shrink-0 text-xs">{type==='person'?r.title.split(' ').map(w=>w[0]).slice(0,2).join(''):'▤'}</span>
            <span className="min-w-0 flex-1"><span className="block truncate">{r.title}</span><span className="block text-xs text-text-tertiary truncate">{r.subtitle ?? r.description}</span></span>
            {r.status && <span className="text-xs text-text-secondary">{r.status.replaceAll('_',' ')}</span>}
            <span className="text-primary text-xs">[{r.n}]</span>
          </Link>)}
        </div>
      </Stack>;
    })}
    <Inline gap="xs" wrap>
      <span className="text-xs text-text-secondary">Sources</span>
      {records.map(r=><Link key={recordKey(r)} to={r.href} title={SEARCH_LABELS[r.type]} className="border border-border rounded px-2 py-1 text-xs text-primary">[{r.n}] {r.title}</Link>)}
      <Button size="sm" variant="ghost" className="ml-auto" onClick={()=>{
        const params=new URLSearchParams(window.location.search);params.set('tab','connections');params.set('selection',records.map(recordKey).join(','));navigate(`/iq/search?${params}`);
      }}>View these connections →</Button>
    </Inline>
    <span className="text-xs text-text-tertiary">Records supplied as context for this answer.</span>
  </Stack>;
}
