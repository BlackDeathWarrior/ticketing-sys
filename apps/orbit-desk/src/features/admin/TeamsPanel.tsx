import { isTeamAdmin } from '@tms/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Dialog, Input, Textarea } from '../../components/ui';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import settings from '../settings/Settings.module.css';
import styles from './Admin.module.css';
import { type AdminTeam, toggle } from './logic';

type Person = { id: string; name: string };

/**
 * Settings → Teams (ADR 0031): every team, its members and its admins. A
 * ticket that belongs to a team is worked by that team; everyone else can
 * read it and add notes. A team's admins change who is on it; super admins
 * also add, rename and delete teams.
 */
export function TeamsPanel() {
  const { can, user } = useSession();
  const teams = useGet<AdminTeam[]>('/teams');
  const people = useGet<Person[]>('/users/directory');
  const [editing, setEditing] = useState<AdminTeam | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manager = can('team:manage');

  const remove = async (team: AdminTeam) => {
    if (!window.confirm(`Delete the team “${team.name}”? Its members stay as users.`)) return;
    setError(null);
    try {
      await api('DELETE', `/teams/${team.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
    void teams.reload();
  };

  return (
    <div className={settings.stack}>
      <Card padding="md" aria-labelledby="teams-title">
        <CardHeader
          id="teams-title"
          title="Teams"
          subtitle="Routing sends a ticket to a team, and only that team acts on it: others can read it and add notes. A team can have several admins, who manage its members."
          actions={manager ? <Button onClick={() => setEditing('new')}>Add team</Button> : null}
        />
        {error && (
          <p className={settings.error} role="alert">
            {error}
          </p>
        )}
        {teams.error && <p className={settings.error}>{teams.error}</p>}
        <ul className={settings.ruleList}>
          {(teams.data ?? []).map((t) => {
            const admins = t.members.filter((m) => m.role === 'admin');
            const mine = user.teams?.find((x) => x.id === t.id);
            return (
              <li key={t.id} className={settings.ruleRow} data-team={t.name}>
                <div>
                  <p className={settings.ruleName}>
                    {t.name}
                    {mine && (
                      <span className={settings.muted}>
                        {' '}
                        · you are {mine.role === 'admin' ? 'an admin' : 'a member'}
                      </span>
                    )}
                  </p>
                  <p className={settings.muted}>
                    {t.description ? `${t.description} · ` : ''}
                    {t.members.length
                      ? t.members
                          .map((m) => (m.role === 'admin' ? `${m.name} (admin)` : m.name))
                          .join(', ')
                      : 'No members yet'}
                  </p>
                  {t.members.length > 0 && !admins.length && (
                    <p className={settings.note}>No admin yet: only a super admin can change it.</p>
                  )}
                </div>
                <div className={settings.actions}>
                  {isTeamAdmin(user, t.id) && (
                    <Button size="sm" onClick={() => setEditing(t)}>
                      Edit
                    </Button>
                  )}
                  {manager && (
                    <Button size="sm" variant="ghost" onClick={() => void remove(t)}>
                      Delete
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <TeamDialog
        team={editing}
        people={people.data ?? []}
        canRename={manager}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void teams.reload();
        }}
      />
    </div>
  );
}

function TeamDialog({
  team,
  people,
  canRename,
  onClose,
  onSaved,
}: {
  team: AdminTeam | 'new' | null;
  people: Person[];
  canRename: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = team && team !== 'new' ? team : undefined;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [adminIds, setAdminIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(existing?.name ?? '');
    setDescription(existing?.description ?? '');
    setMemberIds(existing?.members.map((m) => m.id) ?? []);
    setAdminIds(existing?.members.filter((m) => m.role === 'admin').map((m) => m.id) ?? []);
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
      await api('PATCH', `/teams/${id}`, {
        ...(existing && canRename
          ? { name: name.trim(), description: description.trim() || null }
          : {}),
        memberIds,
        adminIds: adminIds.filter((a) => memberIds.includes(a)),
      });
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
          disabled={!!existing && !canRename}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Textarea
          id="team-description"
          label="What the team handles (optional)"
          rows={2}
          maxLength={500}
          disabled={!!existing && !canRename}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <fieldset className={styles.checks}>
          <legend>Members, and which of them are admins</legend>
          {people.map((p) => {
            const member = memberIds.includes(p.id);
            return (
              <div key={p.id} className={styles.memberRow}>
                <label className={settings.check}>
                  <input
                    type="checkbox"
                    checked={member}
                    onChange={() => setMemberIds(toggle(memberIds, p.id))}
                  />
                  {p.name}
                </label>
                <label className={settings.check}>
                  <input
                    type="checkbox"
                    checked={member && adminIds.includes(p.id)}
                    disabled={!member}
                    onChange={() => setAdminIds(toggle(adminIds, p.id))}
                  />
                  Admin
                </label>
              </div>
            );
          })}
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
