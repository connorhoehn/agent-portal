// Users & Tenants provisioning — the UI over /api/identity/users, /tenants and
// PUT /users/:id/grants. Grants are a tenant × role matrix; a user with no
// grant in a tenant cannot switch into it (enforced server-side in the
// session routes), so this page is where tenant isolation is administered.
//
// A row opens the user as a page, `/admin/identity/users/:userId` (the users as
// the list rail beside it, docs/layout-cascade.md "Records open as pages"): the
// facts, the person link and the grant matrix, each with an explicit Save; a
// grant change still confirms. Creating a user or tenant stays a header form.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Button,
  Card,
  Checkbox,
  Chip,
  CollectionToolbar,
  ConfirmDialog,
  DataTable,
  DetailHeader,
  DetailSection,
  Drawer,
  FormField,
  Inline,
  InlineAlert,
  Input,
  KeyValue,
  LoadingState,
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
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { matchesUser, usersAdapter } from './identityCommands';
import { RecordNotFound, UnavailableNotice, orUnknown } from '../../components/UnavailableNotice';
import { CollectionRecordFrame } from '../../components/collections/CollectionRecordFrame';
import { useCrumbLabel } from '../../lib/crumbLabels';
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

  // The open user is the URL (`/admin/identity/users/:userId`).
  const { userId: openId = null } = useParams<{ userId?: string }>();
  const navigate = useNavigate();
  const openUser = (id: string | null) => navigate(id ? `/admin/identity/users/${encodeURIComponent(id)}` : '/admin/identity/users');
  const [busy, setBusy] = useState(false);
  const [showNewUser, setShowNewUser] = useState(false);
  const [showNewTenant, setShowNewTenant] = useState(false);

  /** Re-fire all three reads — the replacement for the old `load()`'s single
   *  Promise.all, used after a mutation and by the UnavailableNotice retry. */
  const load = () => { refreshTenants(); refreshRoles(); refreshUsers(); };

  // The table's search, shared by the toolbar and the command composer.
  const [query, setQuery] = useState('');
  const shownUsers = useMemo(() => users.filter((u) => matchesUser(u, query)), [users, query]);
  const adapter = usersAdapter({ setQuery, refresh: load });

  // Roles selectable for a tenant = that tenant's roles + cross-tenant roles.
  const rolesForTenant = useMemo(() => rolesForTenantMap(tenants, roles), [tenants, roles]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMutationError(null);
    try { await fn(); } catch (e) { setMutationError((e as Error).message); } finally { setBusy(false); }
  };

  const saveGrants = (userId: string, grants: Record<string, string[]>) => run(async () => {
    await sendJson(`/api/identity/users/${userId}/grants`, 'PUT', { grants });
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
      render: (u) => <T as="span" size="sm" tone="secondary" className="font-mono">{u.personId ?? '—'}</T>,
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

  const open = users.find((u) => u.id === openId) ?? null;
  useCrumbLabel(openId ?? undefined, open?.displayName ?? null);
  if (openId) {
    return (
      <CollectionRecordFrame
        title="Users & Tenants"
        listTitle="Users"
        listLabel="users"
        {...(usersData ? { count: shownUsers.length } : {})}
        search={{ value: query, onChange: setQuery, placeholder: 'Find a user' }}
        groups={[
          { id: 'granted', title: 'With grants', count: shownUsers.filter((u) => grantChipLabels(u.grants).length > 0).length },
          { id: 'none', title: 'No grants', count: shownUsers.filter((u) => grantChipLabels(u.grants).length === 0).length },
        ]}
        rows={shownUsers.map((u) => ({
          id: u.id,
          groupId: grantChipLabels(u.grants).length > 0 ? 'granted' : 'none',
          title: u.displayName,
          subline: u.email ?? u.id,
        }))}
        currentId={openId}
        onOpen={openUser}
        loading={loadingFirst}
        error={error ?? degraded ?? null}
        onRetry={load}
        footer={<CollectionCommandHost adapter={adapter} />}
        data-testid="identity-user-explorer"
      >
        {open ? (
          <UserRecord
            key={open.id}
            user={open}
            isSelf={session?.sub === open.id}
            tenants={tenants}
            rolesForTenant={rolesForTenant}
            canManage={canManage}
            busy={busy}
            error={mutationError}
            canSignInAs={canSignInAs && session?.sub !== open.id}
            onSignIn={() => signInAs(open)}
            onLinkPerson={(personId) => void linkPerson(open.id, personId)}
            onSaveGrants={(grants) => void saveGrants(open.id, grants)}
          />
        ) : loadingFirst || !usersData ? (
          <LoadingState label="Loading user…" />
        ) : (
          <RecordNotFound heading="User" title="User not found" body={`No provisioned user has the id "${openId}".`}
            backLabel="Users & Tenants" onBack={() => openUser(null)} />
        )}
      </CollectionRecordFrame>
    );
  }

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
        <Stack gap="md" className="min-w-0">
        <CollectionToolbar label="User filters"
          search={{ value: query, onChange: setQuery, placeholder: 'Search users…', 'aria-label': 'Search users' }}
          summary={usersData ? `${shownUsers.length} of ${users.length} users` : undefined}
          onRefresh={load} refreshing={usersLoading} />
        <DataTable
          data={shownUsers}
          keyField={u => u.id}
          columns={columns}
          loading={loadingFirst}
          emptyMessage={users.length > 0 ? 'No user matches this search.' : 'No users provisioned yet.'}
          onRowClick={(u) => openUser(u.id)}
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
            </Inline>
          )}
        />
        <CollectionCommandHost adapter={adapter} />
        </Stack>
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

    </PageSection>
  );
}

function UserRecord({ user, isSelf, tenants, rolesForTenant, canManage, busy, error, canSignInAs, onSignIn, onLinkPerson, onSaveGrants }: {
  user: UserInfo;
  isSelf: boolean;
  tenants: TenantInfo[];
  rolesForTenant: Map<string, RoleInfo[]>;
  canManage: boolean;
  busy: boolean;
  error: string | null;
  canSignInAs: boolean;
  onSignIn: () => void;
  onLinkPerson: (personId: string | null) => void;
  onSaveGrants: (grants: Record<string, string[]>) => void;
}) {
  const savedGrants = JSON.stringify(user.grants);
  const [draftGrants, setDraftGrants] = useState<Record<string, string[]>>(() => JSON.parse(savedGrants) as Record<string, string[]>);
  const [personDraft, setPersonDraft] = useState(user.personId ?? '');
  const [confirmingGrants, setConfirmingGrants] = useState(false);
  // The drafts follow the stored user after a save (or another admin's change).
  useEffect(() => { setDraftGrants(JSON.parse(savedGrants) as Record<string, string[]>); }, [savedGrants]);
  useEffect(() => { setPersonDraft(user.personId ?? ''); }, [user.personId]);

  const grantDiff = describeGrantDiff(user.grants, draftGrants);
  const grantsDirty = grantDiff.added.length > 0 || grantDiff.removed.length > 0;
  const personDirty = (personDraft.trim() || null) !== user.personId;
  const labels = grantChipLabels(user.grants);

  return (
    <Stack gap="md" data-testid="identity-user-record">
      <DetailHeader
        title={user.displayName}
        badge={isSelf ? <Chip size="xs">you</Chip> : undefined}
        description={user.id}
        aside={canSignInAs ? (
          <Inline justify="end">
            {/* Become this user — a rare administrative act, hidden when a
                real sign-in is required (the POST would 403 anyway). */}
            <Button size="sm" variant="secondary" disabled={busy} onClick={onSignIn} title="Reload the app as this user (dev only)">
              Sign in as
            </Button>
          </Inline>
        ) : undefined}
      />
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      <KeyValue layout="row" items={[
        { label: 'User id', value: <T as="span" size="sm" className="font-mono">{user.id}</T> },
        { label: 'Email', value: user.email ?? '—' },
        { label: 'Person', value: <T as="span" size="sm" className="font-mono">{user.personId ?? '—'}</T> },
        { label: 'Grants', value: labels.length > 0
          ? <Inline gap="xs" wrap>{labels.map((l) => <Chip key={l} size="xs">{l}</Chip>)}</Inline>
          : <T as="span" size="sm" tone="tertiary">none</T> },
      ]} />

      {canManage && (
        <DetailSection title="Person link" variant="heading"
          description="Links this login to an org-graph person; leave blank to clear the link.">
          <Stack gap="sm">
            <FormField label="Person id" hint="e.g. p-012">
              {(wiring) => <Input {...inputWiring(wiring)} value={personDraft} disabled={busy} onChange={(e) => setPersonDraft(e.target.value)} />}
            </FormField>
            <Inline gap="sm" justify="end">
              <Button size="sm" variant="ghost" disabled={!personDirty} onClick={() => setPersonDraft(user.personId ?? '')}>Discard changes</Button>
              <Button size="sm" disabled={busy || !personDirty} onClick={() => onLinkPerson(personDraft.trim() || null)} data-testid="identity-user-person-save">
                Save link
              </Button>
            </Inline>
          </Stack>
        </DetailSection>
      )}

      {canManage && (
        <DetailSection title="Grants" variant="heading"
          description="A user with no grant in a tenant cannot switch into it. Takes effect immediately on save.">
          <Stack gap="sm">
            <Inline gap="md" wrap align="start">
              {tenants.map((t) => (
                <TenantGrantsCard
                  key={t.id}
                  tenant={t}
                  roles={rolesForTenant.get(t.id) ?? []}
                  checked={draftGrants[t.id] ?? []}
                  onToggle={(role) => setDraftGrants((prev) => toggleGrantSet(prev, t.id, role))}
                />
              ))}
            </Inline>
            <Inline gap="sm" justify="end">
              <Button size="sm" variant="ghost" disabled={!grantsDirty} onClick={() => setDraftGrants(JSON.parse(savedGrants) as Record<string, string[]>)}>Discard changes</Button>
              <Button size="sm" disabled={busy || !grantsDirty} onClick={() => setConfirmingGrants(true)} data-testid="identity-user-grants-save">
                Save grants
              </Button>
            </Inline>
          </Stack>
        </DetailSection>
      )}

      {/* Grants gate what a user can reach — a save with no stated effect
          is the wrong click-weight for a privilege change. */}
      <ConfirmDialog
        open={confirmingGrants}
        onConfirm={() => { setConfirmingGrants(false); onSaveGrants(draftGrants); }}
        onCancel={() => setConfirmingGrants(false)}
        tone={grantDiff.removed.length > 0 ? 'destructive' : 'caution'}
        title={`Change access for ${user.displayName}?`}
        body={
          [
            grantDiff.added.length > 0 ? `Grants: ${grantDiff.added.join(', ')}.` : null,
            grantDiff.removed.length > 0 ? `Revokes: ${grantDiff.removed.join(', ')}.` : null,
            'Takes effect immediately.',
          ].filter(Boolean).join(' ')
        }
      />
    </Stack>
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
