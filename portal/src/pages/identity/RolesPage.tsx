import { useMemo, useState } from 'react';
import {
  T,
  Card,
  CardHeader,
  Chip,
  CollectionToolbar,
  DetailSection,
  Inline,
  InlineAlert,
  LoadingState,
  PageSection,
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
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { matchesAction, roleActionsAdapter } from './identityCommands';

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
  const { data, isLoading, error, refresh } = useFetch<RoleInfo[]>('/api/identity/roles');
  // The matrix rows come from the SAME live schema the Schema tab edits — a
  // hardcoded action list here silently drifted from it the first time anyone
  // added an action.
  const { data: schemaData, error: schemaError } = useFetch<SchemaResponse>('/api/identity/schema', undefined, { share: true });

  const actions = useMemo(
    () => matrixActions(Object.keys(schemaData?.schema?.OrgIQ?.actions ?? {}), data ?? []),
    [schemaData, data],
  );
  const [query, setQuery] = useState('');
  const shownActions = actions.filter((action) => matchesAction(action, query));
  const adapter = roleActionsAdapter({ setQuery, refresh: () => void refresh() });

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
        <UnavailableNotice
          error={error}
          what="roles"
          source="Roles and their capabilities come from the role registry"
          onRetry={() => void refresh()}
        />
      </PageSection>
    );
  }
  if (!data) return null;

  return (
    <PageSection
      title="Roles"
      description="Cedar policies enforced by Verified Permissions on every middleware request."
    >
      <Stack gap="md" className="min-w-0">
      <CollectionToolbar label="Permission matrix filters"
        search={{ value: query, onChange: setQuery, placeholder: 'Search actions', 'aria-label': 'Search actions' }}
        summary={`${shownActions.length} of ${actions.length} actions`}
        onRefresh={() => void refresh()} refreshing={isLoading} />
      <DetailSection title="Permission matrix" first>
        {schemaError && (
          <InlineAlert tone="error" data-testid="roles-schema-error">
            The action list could not be read from the policy schema ({schemaError}), so the matrix shows only the actions the roles themselves grant.
          </InlineAlert>
        )}
        <Table>
          <TableHead>
            <TableRow>
              <TableTh>Action</TableTh>
              {data.map(r => <TableTh key={r.id} className="text-center">{r.label}</TableTh>)}
            </TableRow>
          </TableHead>
          <TableBody>
            {shownActions.length === 0 && actions.length > 0 && (
              <TableRow>
                <TableTd colSpan={data.length + 1}><T size="sm" tone="tertiary">No action matches this search.</T></TableTd>
              </TableRow>
            )}
            {shownActions.map(action => (
              <TableRow key={action}>
                {/* System-ui cell, mono identifier inside it (docs/layout-cascade.md "Tables"). */}
                <TableTd><T className="font-mono">{action}</T></TableTd>
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
      </DetailSection>
      <CollectionCommandHost adapter={adapter} />
      </Stack>

      {/* Role cards — kept below the matrix (table-density audit, matches
          KnowledgeHomePage's "right now" strip): the capability chips repeat
          the matrix's own ✓ marks, but each role's prose summary isn't in the
          matrix anywhere, so the cards stay rather than being dropped. */}
      <Inline gap="md" wrap className="mt-4">
        {data.map(role => (
          <Card key={role.id} className="w-[280px]">
            <CardHeader title={role.label} {...(role.id.replace(/-/g, ' ').toLowerCase() === role.label.toLowerCase() ? {} : { subtitle: role.id })} />
            <Stack gap="sm" className="mt-2">
              <T as="p" size="xs" tone="secondary" className="m-0">{role.summary}</T>
              <Inline gap="xs" wrap>
                {role.capabilities.map(c => (
                  <Chip key={c} size="xs">{c}</Chip>
                ))}
              </Inline>
            </Stack>
          </Card>
        ))}
      </Inline>
    </PageSection>
  );
}

export default RolesPage;
