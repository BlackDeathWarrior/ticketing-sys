import type { RoleView } from '@tms/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Dialog, Input, Select, Textarea } from '../../components/ui';
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

/** Settings → People: who can sign in, what they may do, and the teams they belong to. */
export function PeoplePanel() {
  const { can, user: me } = useSession();
  const users = useGet<AdminUser[]>('/users');
  const roles = useGet<RoleView[]>('/roles');
  const teams = useGet<AdminTeam[]>('/teams');
  const [editingUser, setEditingUser] = useState<AdminUser | 'new' | null>(null);
  const [editingTeam, setEditingTeam] = useState<AdminTeam | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    void users.reload();
    void teams.reload();
  };
  const roleName = (key: string) => roles.data?.find((r) => r.key === key)?.name ?? key;

  const removeTeam = async (team: AdminTeam) => {
    if (!window.confirm(`Delete the team “${team.name}”? Its members stay as users.`)) return;
    setError(null);
    try {
      await api('DELETE', `/teams/${team.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
    reload();
  };

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

      <Card padding="md" aria-labelledby="teams-title">
        <CardHeader
          id="teams-title"
          title="Teams"
          subtitle="Routing rules send tickets to a team; its members share the queue."
          actions={
            can('team:manage') ? (
              <Button onClick={() => setEditingTeam('new')}>Add team</Button>
            ) : null
          }
        />
        {error && (
          <p className={settings.error} role="alert">
            {error}
          </p>
        )}
        <ul className={settings.ruleList}>
          {(teams.data ?? []).map((t) => (
            <li key={t.id} className={settings.ruleRow} data-team={t.name}>
              <div>
                <p className={settings.ruleName}>{t.name}</p>
                <p className={settings.muted}>
                  {t.description ? `${t.description} · ` : ''}
                  {t.members.length ? t.members.map((m) => m.name).join(', ') : 'No members yet'}
                </p>
              </div>
              {can('team:manage') && (
                <div className={settings.actions}>
                  <Button size="sm" onClick={() => setEditingTeam(t)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void removeTeam(t)}>
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>

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
      <TeamDialog
        team={editingTeam}
        users={(users.data ?? []).filter((u) => u.isActive)}
        onClose={() => setEditingTeam(null)}
        onSaved={() => {
          setEditingTeam(null);
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

function TeamDialog({
  team,
  users,
  onClose,
  onSaved,
}: {
  team: AdminTeam | 'new' | null;
  users: AdminUser[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = team && team !== 'new' ? team : undefined;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(existing?.name ?? '');
    setDescription(existing?.description ?? '');
    setMemberIds(existing?.members.map((m) => m.id) ?? []);
    setError(null);
  }, [team]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const id =
        existing?.id ??
        (
          await api<{ id: string }>('POST', '/teams', {
            name: name.trim(),
            ...(description.trim() ? { description: description.trim() } : {}),
          })
        ).id;
      if (existing || memberIds.length) {
        await api('PATCH', `/teams/${id}`, {
          ...(existing ? { name: name.trim(), description: description.trim() || null } : {}),
          memberIds,
        });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={team !== null} onClose={onClose} labelledBy="team-dialog-title">
      <form
        className={settings.form}
        onSubmit={save}
        aria-label={existing ? 'Edit team' : 'Add team'}
      >
        <h2 id="team-dialog-title" className={settings.dialogTitle}>
          {existing ? `Edit ${existing.name}` : 'Add a team'}
        </h2>
        <Input
          id="team-name"
          label="Team name"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Textarea
          id="team-description"
          label="What the team handles (optional)"
          rows={2}
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <fieldset className={styles.checks}>
          <legend>Members</legend>
          {users.map((u) => (
            <label key={u.id} className={settings.check}>
              <input
                type="checkbox"
                checked={memberIds.includes(u.id)}
                onChange={() => setMemberIds(toggle(memberIds, u.id))}
              />
              {u.name}
            </label>
          ))}
        </fieldset>
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
            {existing ? 'Save team' : 'Add team'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
