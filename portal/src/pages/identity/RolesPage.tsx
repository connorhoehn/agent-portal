import { useMemo } from 'react';
import {
  Card,
  CardHeader,
  Chip,
  ErrorState,
  Inline,
  LoadingState,
  PageSection,
  SectionLabel,
  Stack,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { matrixActions } from './identityFormat';

interface RoleInfo {
  id: string;
  label: string;
  summary: string;
  capabilities: string[];
}

// Matches SchemaPage's read of GET /api/identity/schema.
interface SchemaResponse {
  schema: {
    OrgIQ?: {
      actions?: Record<string, unknown>;
    };
  };
}

function RolesPage() {
  const { data, isLoading, error } = useFetch<RoleInfo[]>('/api/identity/roles');
  // The matrix rows come from the SAME live schema the Schema tab edits — a
  // hardcoded action list here silently drifted from it the first time anyone
  // added an action.
  const { data: schemaData } = useFetch<SchemaResponse>('/api/identity/schema');

  const actions = useMemo(
    () => matrixActions(Object.keys(schemaData?.schema?.OrgIQ?.actions ?? {}), data ?? []),
    [schemaData, data],
  );

  if (isLoading) {
    return (
      <PageSection title="Roles">
        <LoadingState label="Loading roles…" />
      </PageSection>
    );
  }
  if (error) {
    return (
      <PageSection title="Roles">
        <ErrorState title="Could not load roles" body={error} />
      </PageSection>
    );
  }
  if (!data) return null;

  return (
    <PageSection
      title="Roles"
      description="Cedar policies enforced by Verified Permissions on every middleware request."
    >
      <Inline gap="md" wrap>
        {data.map(role => (
          <Card key={role.id} className="w-[280px]">
            <CardHeader title={role.label} subtitle={role.id} />
            <Stack gap="sm" className="mt-2">
              <Stack as="p" gap="none" className="m-0 text-[12px] text-text-secondary">{role.summary}</Stack>
              <Inline gap="xs" wrap>
                {role.capabilities.map(c => (
                  <Chip key={c} size="xs">{c}</Chip>
                ))}
              </Inline>
            </Stack>
          </Card>
        ))}
      </Inline>

      <Stack gap="sm">
        <SectionLabel as="h3" className="text-[14px] normal-case tracking-normal text-text-primary">
          Permission matrix
        </SectionLabel>
        <Table>
          <TableHead>
            <TableRow>
              <TableTh>Action</TableTh>
              {data.map(r => <TableTh key={r.id} className="text-center">{r.label}</TableTh>)}
            </TableRow>
          </TableHead>
          <TableBody>
            {actions.map(action => (
              <TableRow key={action}>
                <TableTd className="font-mono text-[12px]">{action}</TableTd>
                {data.map(r => (
                  <TableTd key={r.id} className="text-center">
                    <Chip size="xs" tone={r.capabilities.includes(action) ? 'success' : 'neutral'}>
                      {r.capabilities.includes(action) ? '✓' : '—'}
                    </Chip>
                  </TableTd>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Stack>
    </PageSection>
  );
}

export default RolesPage;
