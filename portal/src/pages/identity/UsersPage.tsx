// Users & Tenants provisioning — the UI over /api/identity/users, /tenants and
// PUT /users/:id/grants. Grants are a tenant × role matrix; a user with no
// grant in a tenant cannot switch into it (enforced server-side in the
// session routes), so this page is where tenant isolation is administered.

import { useMemo, useState } from 'react';
import {
  Button,
  Card,
  Checkbox,
  Chip,
  ConfirmDialog,
  DataTable,
  Drawer,
  FormField,
  Inline,
  InlineAlert,
  Input,
  PageSection,
  SectionLabel,
  Stack,
  StatStrip,
  T,
} from '@connorhoehnslalom/ui-components/shared';
import type { DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { toastError } from '../../lib/toastStore';
import { sendJson } from '../../lib/writeJson';
import { UnavailableNotice, orUnknown } from '../../components/UnavailableNotice';
import {
  describeGrantDiff,
  grantChipLabels,
  inputWiring,
  rolesForTenantMap,
  tenantIdProblem,
  tenantUserCount,
  toggleGrantSet,
} from './identityFormat';

interface TenantInfo { id: string; displayName: string; status: string }
interface RoleInfo { id: string; tenant: string | null; label: string; summary: string; capabilities: string[] }
interface UserInfo {
  id: string;
  displayName: string;
  email: string | null;
  personId: string | null;
  grants: Record<string, string[]>;
}

function UsersPage() {
  const { session, refresh, login, ssoRequired } = useSession();
  // Tenant/user creation and grant edits ride /api/identity (ManageUsers).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageUsers');

  // Three independent reads — no combined endpoint exists — each on
  // useFetch instead of a hand-rolled Promise.all, so retry/degraded/loading
  // all come from the one shared implementation instead of a bespoke
  // try/catch/finally that reimplemented it.
  const {
    data: tenantsData, isLoading: tenantsLoading, error: tenantsError, degraded: tenantsDegraded,
    refresh: refreshTenants,
  } = useFetch<TenantInfo[]>('/api/identity/tenants');
  const {
    data: rolesData, isLoading: rolesLoading, error: rolesError, degraded: rolesDegraded,
    refresh: refreshRoles,
  } = useFetch<RoleInfo[]>('/api/identity/roles');
  const {
    data: usersData, isLoading: usersLoading, error: usersError, degraded: usersDegraded,
    refresh: refreshUsers,
  } = useFetch<UserInfo[]>('/api/identity/users');

  const tenants = tenantsData ?? [];
  const roles = rolesData ?? [];
  const users = usersData ?? [];
  // See the shared list-page loading pattern comment in QueuePage.tsx: only
  // the first read counts for skeleton purposes — a bare `||` of the three
  // isLoading flags goes true again after every mutation's refresh() (grant
  // save, create user/tenant) even though data is still populated, which
  // would flash a full-height loader over the table after every save.
  const loadingFirst = (tenantsLoading && !tenantsData) || (rolesLoading && !rolesData) || (usersLoading && !usersData);
  // A mutation (grant save, create user/tenant) surfaces its OWN failure
  // here; a read failure comes straight off the three fetches above — same
  // "first one that has something to say" order the old firstDegraded(t, r,
  // u) call made.
  const [mutationError, setMutationError] = useState<string | null>(null);
  const error = mutationError ?? tenantsError ?? rolesError ?? usersError;
  const degraded = tenantsDegraded ?? rolesDegraded ?? usersDegraded;

  const [grantsUser, setGrantsUser] = useState<UserInfo | null>(null); // user with the "Edit grants" drawer open
  const [draftGrants, setDraftGrants] = useState<Record<string, string[]>>({});
  const [confirmingGrants, setConfirmingGrants] = useState(false); // "Save grants" clicked, awaiting confirm
  const [busy, setBusy] = useState(false);
  const [showNewUser, setShowNewUser] = useState(false);
  const [showNewTenant, setShowNewTenant] = useState(false);

  /** Re-fire all three reads — the replacement for the old `load()`'s single
   *  Promise.all, used after a mutation and by the UnavailableNotice retry. */
  const load = () => { refreshTenants(); refreshRoles(); refreshUsers(); };

  // Roles selectable for a tenant = that tenant's roles + cross-tenant roles.
  const rolesForTenant = useMemo(() => rolesForTenantMap(tenants, roles), [tenants, roles]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMutationError(null);
    try { await fn(); } catch (e) { setMutationError((e as Error).message); } finally { setBusy(false); }
  };

  const openGrantsEditor = (u: UserInfo) => {
    setGrantsUser(u);
    setDraftGrants(JSON.parse(JSON.stringify(u.grants)) as Record<string, string[]>);
  };

  const toggleGrant = (tenant: string, role: string) => {
    setDraftGrants(prev => toggleGrantSet(prev, tenant, role));
  };

  const grantDiff = grantsUser ? describeGrantDiff(grantsUser.grants, draftGrants) : { added: [], removed: [] };
  const grantsDirty = grantDiff.added.length > 0 || grantDiff.removed.length > 0;

  const saveGrants = () => run(async () => {
    if (!grantsUser) return;
    const userId = grantsUser.id;
    await sendJson(`/api/identity/users/${userId}/grants`, 'PUT', { grants: draftGrants });
    setGrantsUser(null);
    load();
    // If we just edited the signed-in user, their session grants are stale
    // until the next login — refresh so the switcher reflects reality.
    if (session?.sub === userId) await refresh();
  });

  // Link (or clear) the org-graph person behind an already-provisioned user —
  // the create form only sets this at creation, so this is the only route an
  // operator with an unlinked account (or anyone else's) can use to fix it.
  const linkPerson = (userId: string, personId: string | null) => run(async () => {
    await sendJson(`/api/identity/users/${userId}/person`, 'PUT', { personId });
    load();
  });

  const canSignInAs = !ssoRequired;
  const signInAs = (u: UserInfo) => {
    // Not a bare `void login(...)`: login hard-navigates on success, so the
    // ONLY observable outcome of a failure is nothing happening — a button
    // that sometimes silently does nothing reads as broken twice over.
    login(u.id).catch((err: unknown) =>
      toastError(null, `Could not sign in as ${u.displayName}`, (err as Error).message));
  };

  const columns: DataTableColumn<UserInfo>[] = [
    {
      key: 'user',
      header: 'User',
      render: (u) => (
        <Inline gap="sm" align="center" wrap={false}>
          <T as="span" size="sm" weight="semibold">{u.displayName}</T>
          {session?.sub === u.id && <Chip size="xs">you</Chip>}
          <T as="span" size="xs" tone="tertiary" className="font-mono">{u.id}</T>
        </Inline>
      ),
    },
    {
      key: 'email',
      header: 'Email',
      render: (u) => <T as="span" size="sm" tone="secondary">{u.email ?? '—'}</T>,
    },
    {
      key: 'persona',
      header: 'Persona',
      render: (u) => (
        <PersonaCell
          user={u}
          busy={busy}
          canEdit={canManage}
          onLink={(personId) => void linkPerson(u.id, personId)}
        />
      ),
    },
    {
      key: 'grants',
      header: 'Grants',
      render: (u) => {
        const labels = grantChipLabels(u.grants);
        return labels.length > 0
          ? <Inline gap="xs" wrap={false}>{labels.map(l => <Chip key={l} size="xs">{l}</Chip>)}</Inline>
          : <T as="span" size="sm" tone="tertiary">none</T>;
      },
    },
  ];

  return (
    <PageSection
      title="Users & Tenants"
      description="Login-able identities and their per-tenant role grants. A user with no grant in a tenant cannot switch into it."
      actions={canManage ? (
        <Inline gap="xs">
          <Button size="sm" variant="secondary" onClick={() => setShowNewTenant(true)}>+ Tenant</Button>
          <Button size="sm" onClick={() => setShowNewUser(true)}>+ User</Button>
        </Inline>
      ) : undefined}
    >
      {(error ?? degraded) && (
        <UnavailableNotice
          error={(error ?? degraded)!}
          what="users and tenants"
          source="Identities are read from Aurora"
          onRetry={() => void load()}
          className="mb-4"
        />
      )}

      {/* Tenants strip — gated on a good read; a failed read must not draw a
          zeroed strip that reads as "no users provisioned". */}
      {!(error ?? degraded) && (
        <StatStrip
          aria-label="Tenants"
          variant="line"
          size="sm"
          items={tenants.map(t => {
            const userCount = tenantUserCount(t.id, users);
            const tenantRoles = (rolesForTenant.get(t.id) ?? []).filter(r => r.tenant === t.id);
            const hint = `${t.id} · ${t.status} · roles: ${tenantRoles.map(r => r.id).join(', ') || '—'}`;
            return {
              label: `${t.displayName.toLowerCase()} users`,
              value: orUnknown(userCount, Boolean(error ?? degraded)),
              title: hint,
            };
          })}
        />
      )}

      {(error ?? degraded) ? null : (
        <DataTable
          size="sm"
          data={users}
          keyField={u => u.id}
          columns={columns}
          searchable
          searchPlaceholder="Search users…"
          loading={loadingFirst}
          rowActions={(u) => (
            <Inline gap="md" justify="end" wrap={false}>
              {/* Become this user. Deliberately here and not in the header
                  menu: it is a rare administrative act, not a thing to trip
                  over while working. Hidden when a real sign-in is required,
                  where the underlying POST would 403 anyway. */}
              {canSignInAs && session?.sub !== u.id && (
                <Button size="sm" variant="link" disabled={busy} onClick={() => signInAs(u)} title="Reload the app as this user (dev only)">
                  Sign in as
                </Button>
              )}
              {canManage && (
                <Button size="sm" variant="link" disabled={busy} onClick={() => openGrantsEditor(u)}>
                  Edit grants
                </Button>
              )}
            </Inline>
          )}
        />
      )}

      <Drawer
        open={showNewTenant}
        onClose={() => setShowNewTenant(false)}
        title="New tenant"
      >
        <NewTenantForm
          busy={busy}
          error={error}
          onCancel={() => setShowNewTenant(false)}
          onSubmit={(id, name) => run(async () => {
            await sendJson('/api/identity/tenants', 'POST', { id, displayName: name });
            setShowNewTenant(false);
            load();
          })}
        />
      </Drawer>

      <Drawer
        open={showNewUser}
        onClose={() => setShowNewUser(false)}
        title="New user"
        width={560}
      >
        <NewUserForm
          busy={busy}
          tenants={tenants}
          rolesForTenant={rolesForTenant}
          onCancel={() => setShowNewUser(false)}
          onSubmit={(input) => run(async () => {
            await sendJson('/api/identity/users', 'POST', input);
            setShowNewUser(false);
            load();
          })}
        />
      </Drawer>

      <Drawer
        open={!!grantsUser}
        onClose={() => setGrantsUser(null)}
        title={grantsUser ? `Edit grants — ${grantsUser.displayName}` : 'Edit grants'}
        footer={
          <Inline gap="xs" justify="end">
            <Button variant="secondary" onClick={() => setGrantsUser(null)} disabled={busy}>Cancel</Button>
            <Button onClick={() => setConfirmingGrants(true)} disabled={busy || !grantsDirty}>Save grants</Button>
          </Inline>
        }
      >
        {grantsUser && (
          <Inline gap="md" wrap align="start">
            {tenants.map(t => (
              <TenantGrantsCard
                key={t.id}
                tenant={t}
                roles={rolesForTenant.get(t.id) ?? []}
                checked={draftGrants[t.id] ?? []}
                onToggle={(role) => toggleGrant(t.id, role)}
              />
            ))}
          </Inline>
        )}
      </Drawer>

      {/* Grants gate what a user can reach — a save with no stated effect
          is the wrong click-weight for a privilege change. Named here, not
          just implied by the checkbox state the drawer already closed on. */}
      <ConfirmDialog
        open={confirmingGrants}
        onConfirm={() => { setConfirmingGrants(false); void saveGrants(); }}
        onCancel={() => setConfirmingGrants(false)}
        tone={grantDiff.removed.length > 0 ? 'destructive' : 'caution'}
        title={grantsUser ? `Change access for ${grantsUser.displayName}?` : 'Change access?'}
        body={
          [
            grantDiff.added.length > 0 ? `Grants: ${grantDiff.added.join(', ')}.` : null,
            grantDiff.removed.length > 0 ? `Revokes: ${grantDiff.removed.join(', ')}.` : null,
            'Takes effect immediately.',
          ].filter(Boolean).join(' ')
        }
      />
    </PageSection>
  );
}

function PersonaCell({ user, busy, canEdit, onLink }: {
  user: UserInfo;
  busy: boolean;
  canEdit: boolean;
  onLink: (personId: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(user.personId ?? '');

  if (editing) {
    return (
      <Inline gap="xs" align="center">
        <Input
          placeholder="person id"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          disabled={busy}
          autoFocus
          aria-label="Person id"
        />
        <Button size="sm" disabled={busy} onClick={() => { onLink(draft.trim() || null); setEditing(false); }}>
          Save
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setDraft(user.personId ?? ''); setEditing(false); }}>
          Cancel
        </Button>
      </Inline>
    );
  }
  return (
    <Inline gap="sm" align="center" wrap={false}>
      <T as="span" size="sm" tone="secondary" className="font-mono">{user.personId ?? '—'}</T>
      {canEdit && (
        <Button size="sm" variant="link" disabled={busy} onClick={() => { setDraft(user.personId ?? ''); setEditing(true); }}>
          {user.personId ? 'Relink' : 'Link'}
        </Button>
      )}
    </Inline>
  );
}

function TenantGrantsCard({ tenant, roles, checked, onToggle }: {
  tenant: TenantInfo;
  roles: RoleInfo[];
  checked: string[];
  onToggle: (role: string) => void;
}) {
  return (
    <Card padding="sm" className="min-w-[180px]">
      <Stack gap="xs">
        <SectionLabel>{tenant.displayName}</SectionLabel>
        {roles.map(r => (
          <Inline as="label" key={r.id} gap="xs" align="center" className="text-xs cursor-pointer">
            <Checkbox checked={checked.includes(r.id)} onChange={() => onToggle(r.id)} aria-label={r.label} />
            <T as="span" size="sm">{r.label}</T>
            {r.tenant === null && <T as="span" size="xs" tone="tertiary">cross-tenant</T>}
          </Inline>
        ))}
      </Stack>
    </Card>
  );
}

function NewTenantForm({ busy, error, onCancel, onSubmit }: {
  busy: boolean;
  /** The server's own refusal, shown INSIDE the drawer — a page-level alert
   *  sits behind it where the reader cannot see it. */
  error: string | null;
  onCancel: () => void;
  onSubmit: (id: string, name: string) => void;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  // Say what is wrong while it is being typed, in the same terms the field's
  // label promises, rather than enabling Create and letting the server 400.
  const problem = id.trim() ? tenantIdProblem(id) : null;
  return (
    <Stack gap="lg">
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      <Stack gap="md">
        <FormField label="ID (kebab-case)" hint={problem ?? 'e.g. assessment'}>
          {(wiring) => (
            <Input
              {...inputWiring(wiring)}
              value={id}
              invalid={problem != null}
              aria-invalid={problem != null || undefined}
              onChange={e => setId(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Display name" hint="Defaults to the id when left blank.">
          {(wiring) => <Input {...inputWiring(wiring)} value={name} onChange={e => setName(e.target.value)} />}
        </FormField>
        <T as="span" size="xs" tone="tertiary">
          Creates the tenant row. Add role seeds under <code>middleware/seeds/roles/&lt;id&gt;/</code> for its Cedar roles.
        </T>
      </Stack>
      <Inline gap="xs" justify="end">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button
          onClick={() => onSubmit(id.trim(), name.trim() || id.trim())}
          disabled={busy || tenantIdProblem(id) != null}
        >
          Create
        </Button>
      </Inline>
    </Stack>
  );
}

function NewUserForm({ busy, tenants, rolesForTenant, onCancel, onSubmit }: {
  busy: boolean;
  tenants: TenantInfo[];
  rolesForTenant: Map<string, RoleInfo[]>;
  onCancel: () => void;
  onSubmit: (input: { id: string; displayName: string; email?: string; personId?: string; grants: Record<string, string[]> }) => void;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [personId, setPersonId] = useState('');
  const [grants, setGrants] = useState<Record<string, string[]>>({});

  const toggle = (tenant: string, role: string) => {
    setGrants(prev => toggleGrantSet(prev, tenant, role));
  };

  return (
    <Stack gap="lg">
      <Stack gap="md">
        <FormField label="ID" hint="e.g. u-jane">
          {(wiring) => <Input {...inputWiring(wiring)} value={id} onChange={e => setId(e.target.value)} />}
        </FormField>
        <FormField label="Display name">
          {(wiring) => <Input {...inputWiring(wiring)} value={name} onChange={e => setName(e.target.value)} />}
        </FormField>
        <FormField label="Email" hint="Optional">
          {(wiring) => <Input {...inputWiring(wiring)} type="email" value={email} onChange={e => setEmail(e.target.value)} />}
        </FormField>
        <FormField label="Person id link" hint="Optional — links this login to an org-graph person">
          {(wiring) => <Input {...inputWiring(wiring)} value={personId} onChange={e => setPersonId(e.target.value)} />}
        </FormField>
      </Stack>

      <Stack gap="sm">
        <SectionLabel>Grants</SectionLabel>
        <Inline gap="md" wrap align="start">
          {tenants.map(t => (
            <TenantGrantsCard
              key={t.id}
              tenant={t}
              roles={rolesForTenant.get(t.id) ?? []}
              checked={grants[t.id] ?? []}
              onToggle={(role) => toggle(t.id, role)}
            />
          ))}
        </Inline>
      </Stack>

      <Inline gap="xs" justify="end">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button
          disabled={busy || !id.trim() || !name.trim()}
          onClick={() => onSubmit({
            id: id.trim(), displayName: name.trim(),
            ...(email.trim() && { email: email.trim() }),
            ...(personId.trim() && { personId: personId.trim() }),
            grants,
          })}
        >
          Create user
        </Button>
      </Inline>
    </Stack>
  );
}

export default UsersPage;
