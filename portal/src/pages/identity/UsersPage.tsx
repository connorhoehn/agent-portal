// Users & Tenants provisioning — the UI over /api/identity/users, /tenants and
// PUT /users/:id/grants. Grants are a tenant × role matrix; a user with no
// grant in a tenant cannot switch into it (enforced server-side in the
// session routes), so this page is where tenant isolation is administered.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Chip, PageSection } from '@connorhoehnslalom/ui-components/shared';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { toastError } from '../../lib/toastStore';

interface TenantInfo { id: string; displayName: string; status: string }
interface RoleInfo { id: string; tenant: string | null; label: string; summary: string; capabilities: string[] }
interface UserInfo {
  id: string;
  displayName: string;
  email: string | null;
  personId: string | null;
  grants: Record<string, string[]>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

function UsersPage() {
  const { session, refresh, login, ssoRequired } = useSession();
  // Tenant/user creation and grant edits ride /api/identity (ManageUsers).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageUsers');
  const [tenants, setTenants] = useState<TenantInfo[]>([]);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);      // user id with open grants editor
  const [draftGrants, setDraftGrants] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [showNewUser, setShowNewUser] = useState(false);
  const [showNewTenant, setShowNewTenant] = useState(false);

  const load = useCallback(async () => {
    try {
      const [t, r, u] = await Promise.all([
        api<TenantInfo[]>('/api/identity/tenants'),
        api<RoleInfo[]>('/api/identity/roles'),
        api<UserInfo[]>('/api/identity/users'),
      ]);
      setTenants(t); setRoles(r); setUsers(u); setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Roles selectable for a tenant = that tenant's roles + cross-tenant roles.
  const rolesForTenant = useMemo(() => {
    const map = new Map<string, RoleInfo[]>();
    for (const t of tenants) {
      map.set(t.id, roles.filter(r => r.tenant === t.id || r.tenant === null));
    }
    return map;
  }, [tenants, roles]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const openEditor = (u: UserInfo) => {
    setEditing(u.id);
    setDraftGrants(JSON.parse(JSON.stringify(u.grants)) as Record<string, string[]>);
  };

  const toggleGrant = (tenant: string, role: string) => {
    setDraftGrants(prev => {
      const held = new Set(prev[tenant] ?? []);
      if (held.has(role)) held.delete(role); else held.add(role);
      const next = { ...prev };
      if (held.size === 0) delete next[tenant]; else next[tenant] = [...held];
      return next;
    });
  };

  const saveGrants = (userId: string) => run(async () => {
    await api(`/api/identity/users/${userId}/grants`, {
      method: 'PUT',
      body: JSON.stringify({ grants: draftGrants }),
    });
    setEditing(null);
    await load();
    // If we just edited the signed-in user, their session grants are stale
    // until the next login — refresh so the switcher reflects reality.
    if (session?.sub === userId) await refresh();
  });

  // Link (or clear) the org-graph person behind an already-provisioned user —
  // the create form only sets this at creation, so this is the only route an
  // operator with an unlinked account (or anyone else's) can use to fix it.
  const linkPerson = (userId: string, personId: string | null) => run(async () => {
    await api(`/api/identity/users/${userId}/person`, {
      method: 'PUT',
      body: JSON.stringify({ personId }),
    });
    await load();
  });

  if (loading) return <div style={{ color: 'var(--color-text-tertiary)' }}>Loading users…</div>;

  return (
    <PageSection
      title="Users & Tenants"
      description="Login-able identities and their per-tenant role grants. A user with no grant in a tenant cannot switch into it."
      actions={canManage ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btnSecondary} onClick={() => setShowNewTenant(s => !s)}>+ Tenant</button>
          <button style={btnPrimary} onClick={() => setShowNewUser(s => !s)}>+ User</button>
        </div>
      ) : undefined}
    >
      {error && (
        <div role="alert" style={{
          padding: '8px 12px', fontSize: 12, borderRadius: 'var(--radius-sm, 4px)',
          background: 'var(--color-danger-bg, rgba(220,38,38,0.12))', color: 'var(--color-danger, #dc2626)',
        }}>
          {error}
        </div>
      )}

      {/* Tenants strip */}
      <section style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {tenants.map(t => {
          const userCount = users.filter(u => (u.grants[t.id] ?? []).length > 0).length;
          return (
            <div key={t.id} style={{
              background: 'var(--color-surface)', border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)', padding: '10px 14px', minWidth: 160,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t.displayName}</span>
                <Chip tone={t.status === 'ACTIVE' ? 'success' : 'warning'} size="xs">{t.status}</Chip>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
                {t.id} · {userCount} user{userCount === 1 ? '' : 's'} · roles: {(rolesForTenant.get(t.id) ?? []).filter(r => r.tenant === t.id).map(r => r.id).join(', ') || '—'}
              </div>
            </div>
          );
        })}
      </section>

      {showNewTenant && <NewTenantForm busy={busy} onSubmit={(id, name) => run(async () => {
        await api('/api/identity/tenants', { method: 'POST', body: JSON.stringify({ id, displayName: name }) });
        setShowNewTenant(false);
        await load();
      })} />}

      {showNewUser && (
        <NewUserForm
          busy={busy}
          tenants={tenants}
          rolesForTenant={rolesForTenant}
          onSubmit={(input) => run(async () => {
            await api('/api/identity/users', { method: 'POST', body: JSON.stringify(input) });
            setShowNewUser(false);
            await load();
          })}
        />
      )}

      {/* Users table */}
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--color-surface-hover)' }}>
              <th style={th}>User</th>
              <th style={th}>Email</th>
              <th style={th}>Persona</th>
              <th style={th}>Grants</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <UserRow
                key={u.id}
                user={u}
                isSelf={session?.sub === u.id}
                isEditing={editing === u.id}
                draftGrants={draftGrants}
                tenants={tenants}
                rolesForTenant={rolesForTenant}
                busy={busy}
                canEdit={canManage}
                // Dev-only identity switch — see the note on the button.
                canSignInAs={!ssoRequired}
                // Not a bare `void login(...)`: login hard-navigates on
                // success, so the ONLY observable outcome of a failure is
                // nothing happening — a button that sometimes silently does
                // nothing reads as broken twice over.
                onSignInAs={() => {
                  login(u.id).catch((err: unknown) =>
                    toastError(null, `Could not sign in as ${u.displayName}`, (err as Error).message));
                }}
                onEdit={() => openEditor(u)}
                onCancel={() => setEditing(null)}
                onToggle={toggleGrant}
                onSave={() => void saveGrants(u.id)}
                onLinkPerson={personId => void linkPerson(u.id, personId)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </PageSection>
  );
}

function UserRow({ user, isSelf, isEditing, draftGrants, tenants, rolesForTenant, busy, canEdit, canSignInAs, onSignInAs, onEdit, onCancel, onToggle, onSave, onLinkPerson }: {
  user: UserInfo;
  isSelf: boolean;
  isEditing: boolean;
  draftGrants: Record<string, string[]>;
  tenants: TenantInfo[];
  rolesForTenant: Map<string, RoleInfo[]>;
  busy: boolean;
  /** ManageUsers — grant edits hide without it. */
  canEdit: boolean;
  /** Dev builds only (no SSO requirement) — see the button. */
  canSignInAs: boolean;
  onSignInAs: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onToggle: (tenant: string, role: string) => void;
  onSave: () => void;
  /** Link/relink/clear the org-graph person (null clears it). */
  onLinkPerson: (personId: string | null) => void;
}) {
  const [editingPerson, setEditingPerson] = useState(false);
  const [personDraft, setPersonDraft] = useState(user.personId ?? '');
  return (
    <>
      <tr style={{ borderTop: '1px solid var(--color-border)' }}>
        <td style={td}>
          <div style={{ fontWeight: 500 }}>{user.displayName}{isSelf && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--color-text-tertiary)' }}>you</span>}</div>
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'ui-monospace, monospace' }}>{user.id}</div>
        </td>
        <td style={{ ...td, color: 'var(--color-text-secondary)' }}>{user.email ?? '—'}</td>
        <td style={{ ...td, fontFamily: 'ui-monospace, monospace', color: 'var(--color-text-secondary)' }}>
          {editingPerson ? (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                style={{ ...inputStyle, width: 90 }}
                placeholder="person id"
                value={personDraft}
                onChange={e => setPersonDraft(e.target.value)}
                disabled={busy}
                autoFocus
              />
              <button
                style={btnPrimary}
                disabled={busy}
                onClick={() => { onLinkPerson(personDraft.trim() || null); setEditingPerson(false); }}
              >
                Save
              </button>
              <button
                style={btnSecondary}
                disabled={busy}
                onClick={() => { setPersonDraft(user.personId ?? ''); setEditingPerson(false); }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span>{user.personId ?? '—'}</span>
              {canEdit && (
                <button style={btnSecondary} disabled={busy} onClick={() => { setPersonDraft(user.personId ?? ''); setEditingPerson(true); }}>
                  {user.personId ? 'Relink' : 'Link'}
                </button>
              )}
            </div>
          )}
        </td>
        <td style={td}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {Object.entries(user.grants).flatMap(([tenant, roleIds]) =>
              roleIds.map(r => (
                <span key={`${tenant}-${r}`} style={{
                  fontSize: 11, padding: '1px 8px', borderRadius: 999,
                  background: 'var(--color-surface-hover)', border: '1px solid var(--color-border)',
                }}>
                  {tenant}/{r}
                </span>
              )))}
            {Object.keys(user.grants).length === 0 && <span style={{ color: 'var(--color-text-tertiary)' }}>none</span>}
          </div>
        </td>
        <td style={{ ...td, textAlign: 'right' }}>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            {/* Become this user. Deliberately here and not in the header menu:
                it is a rare administrative act, not a thing to trip over while
                working. Hidden when a real sign-in is required, where the
                underlying POST would 403 anyway. */}
            {canSignInAs && !isSelf && (
              <button style={btnSecondary} disabled={busy} onClick={onSignInAs} title="Reload the app as this user (dev only)">
                Sign in as
              </button>
            )}
            {canEdit && (
              <button style={btnSecondary} disabled={busy} onClick={isEditing ? onCancel : onEdit}>
                {isEditing ? 'Cancel' : 'Edit grants'}
              </button>
            )}
          </div>
        </td>
      </tr>
      {isEditing && (
        <tr>
          <td colSpan={5} style={{ padding: '4px 12px 14px', background: 'var(--color-surface-hover)' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, padding: '8px 0' }}>
              {tenants.map(t => (
                <fieldset key={t.id} style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm, 4px)', padding: '8px 12px', minWidth: 180 }}>
                  <legend style={{ fontSize: 11, fontWeight: 600, padding: '0 4px' }}>{t.displayName}</legend>
                  {(rolesForTenant.get(t.id) ?? []).map(r => (
                    <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '2px 0', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={(draftGrants[t.id] ?? []).includes(r.id)}
                        onChange={() => onToggle(t.id, r.id)}
                      />
                      {r.label}
                      {r.tenant === null && <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>cross-tenant</span>}
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
            <button style={btnPrimary} disabled={busy} onClick={onSave}>Save grants</button>
          </td>
        </tr>
      )}
    </>
  );
}

function NewTenantForm({ busy, onSubmit }: { busy: boolean; onSubmit: (id: string, name: string) => void }) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  return (
    <form
      onSubmit={e => { e.preventDefault(); onSubmit(id.trim(), name.trim() || id.trim()); }}
      style={formCard}
    >
      <strong style={{ fontSize: 12 }}>New tenant</strong>
      <input style={inputStyle} placeholder="id (kebab-case)" value={id} onChange={e => setId(e.target.value)} pattern="[a-z][a-z0-9-]{1,30}" required />
      <input style={inputStyle} placeholder="Display name" value={name} onChange={e => setName(e.target.value)} />
      <button type="submit" style={btnPrimary} disabled={busy || !id.trim()}>Create</button>
      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
        Creates the tenant row. Add role seeds under middleware/seeds/roles/&lt;id&gt;/ for its Cedar roles.
      </span>
    </form>
  );
}

function NewUserForm({ busy, tenants, rolesForTenant, onSubmit }: {
  busy: boolean;
  tenants: TenantInfo[];
  rolesForTenant: Map<string, RoleInfo[]>;
  onSubmit: (input: { id: string; displayName: string; email?: string; personId?: string; grants: Record<string, string[]> }) => void;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [personId, setPersonId] = useState('');
  const [grants, setGrants] = useState<Record<string, string[]>>({});

  const toggle = (tenant: string, role: string) => {
    setGrants(prev => {
      const held = new Set(prev[tenant] ?? []);
      if (held.has(role)) held.delete(role); else held.add(role);
      const next = { ...prev };
      if (held.size === 0) delete next[tenant]; else next[tenant] = [...held];
      return next;
    });
  };

  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        onSubmit({
          id: id.trim(), displayName: name.trim(),
          ...(email.trim() && { email: email.trim() }),
          ...(personId.trim() && { personId: personId.trim() }),
          grants,
        });
      }}
      style={{ ...formCard, flexDirection: 'column', alignItems: 'stretch' }}
    >
      <strong style={{ fontSize: 12 }}>New user</strong>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <input style={inputStyle} placeholder="id (e.g. u-jane)" value={id} onChange={e => setId(e.target.value)} required />
        <input style={inputStyle} placeholder="Display name" value={name} onChange={e => setName(e.target.value)} required />
        <input style={inputStyle} placeholder="email (optional)" value={email} onChange={e => setEmail(e.target.value)} />
        <input style={inputStyle} placeholder="person_id link (optional)" value={personId} onChange={e => setPersonId(e.target.value)} />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {tenants.map(t => (
          <fieldset key={t.id} style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm, 4px)', padding: '8px 12px' }}>
            <legend style={{ fontSize: 11, fontWeight: 600, padding: '0 4px' }}>{t.displayName}</legend>
            {(rolesForTenant.get(t.id) ?? []).map(r => (
              <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '2px 0', cursor: 'pointer' }}>
                <input type="checkbox" checked={(grants[t.id] ?? []).includes(r.id)} onChange={() => toggle(t.id, r.id)} />
                {r.label}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <div>
        <button type="submit" style={btnPrimary} disabled={busy || !id.trim() || !name.trim()}>Create user</button>
      </div>
    </form>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left', padding: '8px 12px', fontWeight: 600, fontSize: 11,
  color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5,
};
const td: React.CSSProperties = { padding: '8px 12px', verticalAlign: 'top' };
const inputStyle: React.CSSProperties = {
  padding: '5px 8px', fontSize: 12, border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)', background: 'var(--color-surface)', color: 'var(--color-text-primary)',
};
const btnPrimary: React.CSSProperties = {
  padding: '5px 12px', fontSize: 12, background: 'var(--color-primary)', color: 'white',
  border: 'none', borderRadius: 'var(--radius-sm, 4px)', cursor: 'pointer',
};
const btnSecondary: React.CSSProperties = {
  padding: '4px 10px', fontSize: 12, background: 'var(--color-surface-hover)', color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm, 4px)', cursor: 'pointer',
};
const formCard: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  background: 'var(--color-surface)', border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)', padding: 12,
};

export default UsersPage;
