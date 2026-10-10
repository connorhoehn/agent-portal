import { Button, Inline, T } from '@connorhoehnslalom/ui-components/shared';
import { socialReadLabel, socialReadState, type SocialListRead } from './socialReadState';

/** A scoped rail status: one stable line, retry for the affected read, no toast. */
export function SocialReadStatus({ source, read, retry, testId }: {
  source: string; read: SocialListRead; retry(): void; testId: string;
}) {
  const label = socialReadLabel(source, read);
  if (!label) return null;
  return <Inline gap="xs" align="center" wrap={false} className="min-w-0" data-testid={testId} data-read-state={socialReadState(read)}>
    <T size="xs" tone="secondary" className="min-w-0 flex-1" title={read.error ?? undefined}>{label}</T>
    {read.error && <Button variant="link" size="sm" aria-label={`Retry ${source.toLocaleLowerCase()}`} onClick={retry}>Retry</Button>}
  </Inline>;
}
