import { Link } from 'react-router';
import { DetailSection, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';

export function AssetRelationships({ kind, id }: { kind: 'knowledge' | 'promotion' | 'library'; id: string }) {
  const { data, error, refresh } = useFetch<{ links: Array<{ id: string; kind: string; label: string; href: string; relation: string }> }>(
    `/api/distillation/relationships/${kind}/${encodeURIComponent(id)}`, 0,
  );
  if (error) return <UnavailableNotice error={error} what="linked records" source="Links are resolved from the distillation, promotion and library records" onRetry={refresh} />;
  if (!data) return null;
  const links = data.links.filter((link) => kind === 'promotion' || (kind === 'library' ? ['review', 'promotion'].includes(link.kind) : link.kind !== 'observation'));
  if (!links.length) return kind === 'promotion'
    ? <T className="text-[12px] text-text-tertiary">No linked guide or Agent library asset recorded.</T> : null;
  return <DetailSection title="Linked records">
    <Stack gap="none">
      {links.map((link) => <Link key={`${link.kind}:${link.id}`} to={link.href}
        className="border-b border-border py-2 last:border-b-0 text-[13px] text-primary hover:underline">
        <T className="inline-flex text-text-tertiary">{link.relation} ·</T>{' '}{link.label}
      </Link>)}
    </Stack>
  </DetailSection>;
}
