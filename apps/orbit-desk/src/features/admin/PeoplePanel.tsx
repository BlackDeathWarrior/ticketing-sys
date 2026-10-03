import {
  DELEGABLE_LABELS,
  DELEGABLE_PERMISSIONS,
  type DelegablePermission,
  type RoleView,
} from '@tms/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Dialog, Input, Select } from '../../components/ui';
import { cx } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import settings from '../settings/Settings.module.css';
import styles from './Admin.module.css';
import {
  type AdminTeam,
  type AdminUser,
  emptyUser,
  formFromUser,
  toggle,
  userBody,
  type UserForm,
} from './logic';

/**
 * Settings → People: who can sign in, what they may do, and the teams they
 * belong to. Teams themselves, with their admins, are under Settings → Teams.
 */
export function PeoplePanel() {
  const { user: me } = useSession();
  const users = useGet<AdminUser[]>('/users');
  const roles = useGet<RoleView[]>('/roles');
  const teams = useGet<AdminTeam[]>('/teams');
  const [editingUser, setEditingUser] = useState<AdminUser | 'new' | null>(null);

  const reload = () => {
    void users.reload();
    void teams.reload();
  };
  const roleName = (key: string) => roles.data?.find((r) => r.key === key)?.name ?? key;

  return (
    <div className={settings.stack}>
      <Card padding="md" aria-labelledby="users-title">
        <CardHeader
          id="users-title"
          title="Users"
          subtitle="People who sign in to Orbit Desk. Switch someone off instead of deleting them: their history stays."
          actions={<Button onClick={() => setEditingUser('new')}>Add user</Button>}
        />
        {users.error && <p className={settings.error}>{users.error}</p>}
        <div className={settings.scroller}>
          <table className={settings.table}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Teams</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(users.data ?? []).map((u) => (
                <tr
                  key={u.id}
                  data-user={u.email}
                  className={u.isActive ? undefined : settings.dim}
                >
                  <td>
                    {u.name}
                    {u.id === me.id && <span className={settings.muted}> (you)</span>}
                    <span className={styles.sub}>{u.email}</span>
                  </td>
                  <td>{u.roles.map(roleName).join(', ')}</td>
                  <td>{u.teams.map((t) => t.name).join(', ') || '—'}</td>
                  <td>{u.isActive ? 'Active' : 'Switched off'}</td>
                  <td>
                    <div className={settings.actions}>
                      <Button size="sm" onClick={() => setEditingUser(u)}>
                        Edit
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <RolesCard roles={roles.data ?? []} onChanged={() => void roles.reload()} />

      <UserDialog
        user={editingUser}
        roles={roles.data ?? []}
        teams={teams.data ?? []}
        isMe={editingUser !== 'new' && editingUser?.id === me.id}
        onClose={() => setEditingUser(null)}
        onSaved={() => {
          setEditingUser(null);
          reload();
        }}
      />
    </div>
  );
}

function UserDialog({
  user,
  roles,
  teams,
  isMe,
  onClose,
  onSaved,
}: {
  user: AdminUser | 'new' | null;
  roles: RoleView[];
  teams: AdminTeam[];
  isMe: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = user && user !== 'new' ? user : undefined;
  const [form, setForm] = useState<UserForm>(emptyUser);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(existing ? formFromUser(existing) : emptyUser());
    setError(null);
  }, [user]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = userBody(form, existing);
    if (existing && !Object.keys(body).length) return onClose();
    setSaving(true);
    setError(null);
    try {
      await api(existing ? 'PATCH' : 'POST', existing ? `/users/${existing.id}` : '/users', body);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={user !== null} onClose={onClose} labelledBy="user-dialog-title">
      <form
        className={settings.form}
        onSubmit={save}
        aria-label={existing ? 'Edit user' : 'Add user'}
      >
        <h2 id="user-dialog-title" className={settings.dialogTitle}>
          {existing ? `Edit ${existing.name}` : 'Add a user'}
        </h2>
        <div className={settings.formRow}>
          <Input
            id="user-name"
            label="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <Input
            id="user-email"
            label="Email"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            disabled={!!existing}
            required
          />
          <Select
            id="user-role"
            label="Role"
            value={form.role}
            options={roles.map((r) => ({ value: r.key, label: r.name }))}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
            disabled={isMe}
          />
          <Input
            id="user-password"
            label={existing ? 'New password (leave empty to keep)' : 'Password'}
            type="password"
            autoComplete="new-password"
            minLength={existing && !form.password ? undefined : 10}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required={!existing}
          />
        </div>
        <p className={settings.note}>
          {roles.find((r) => r.key === form.role)?.description ?? ''}
          {isMe ? ' You can’t change your own role or switch yourself off.' : ''}
        </p>
        <fieldset className={styles.checks}>
          <legend>Teams</legend>
          {teams.length === 0 && <p className={settings.note}>No teams yet.</p>}
          {teams.map((t) => (
            <label key={t.id} className={settings.check}>
              <input
                type="checkbox"
                checked={form.teamIds.includes(t.id)}
                onChange={() => setForm({ ...form, teamIds: toggle(form.teamIds, t.id) })}
              />
              {t.name}
            </label>
          ))}
        </fieldset>
        {existing && (
          <label className={settings.check}>
            <input
              type="checkbox"
              checked={form.isActive}
              disabled={isMe}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            />
            Can sign in
          </label>
        )}
        {error && (
          <p className={settings.error} role="alert">
            {error}
          </p>
        )}
        <div className={settings.formActions}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {existing ? 'Save user' : 'Add user'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * What each role may do beyond its built-in permissions (ADR 0031). A role
 * keeps what it was built with; these can be added on top. Super admins have
 * everything, and keys, people, teams, integrations and the system stay
 * theirs alone.
 */
function RolesCard({ roles, onChanged }: { roles: RoleView[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = roles.filter((r) => r.key !== 'admin');

  const flip = async (role: RoleView, permission: DelegablePermission, on: boolean) => {
    setBusy(`${role.key}:${permission}`);
    setError(null);
    try {
      await api(on ? 'PUT' : 'DELETE', `/roles/${role.key}/permissions/${permission}`);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card padding="md" aria-labelledby="roles-title">
      <CardHeader
        id="roles-title"
        title="Roles"
        subtitle="What each role may do. A ticked box that cannot be changed is part of the role; the others can be granted. Super admins can do everything."
      />
      {error && (
        <p className={settings.error} role="alert">
          {error}
        </p>
      )}
      <div className={settings.scroller}>
        <table className={cx(settings.table, styles.matrix)}>
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {shown.map((r) => (
                <th key={r.key} scope="col">
                  {r.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DELEGABLE_PERMISSIONS.map((perm) => (
              <tr key={perm}>
                <th scope="row">{DELEGABLE_LABELS[perm]}</th>
                {shown.map((r) => {
                  const has = r.permissions.includes(perm);
                  const builtIn = has && !(r.grants ?? []).includes(perm);
                  return (
                    <td key={r.key}>
                      <input
                        type="checkbox"
                        aria-label={`${r.name}: ${DELEGABLE_LABELS[perm]}`}
                        checked={has}
                        disabled={builtIn || busy === `${r.key}:${perm}`}
                        onChange={(e) => void flip(r, perm, e.target.checked)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
