import { type FormEvent, useState } from 'react';
import type { CurrentUser } from '@tms/shared';
import { login } from '../../api/client';
import { Logo } from '../../components/layout/Logo';
import { Button, Card, GradientText, Input, StarField } from '../../components/ui';
import styles from './LoginPage.module.css';

export function LoginPage({ onSignedIn }: { onSignedIn: (user: CurrentUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onSignedIn(await login(email.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.page}>
      <StarField className={styles.stars} />
      <Card tone="raised" padding="lg" className={styles.card}>
        <form onSubmit={submit} className={styles.form} aria-labelledby="login-title">
          <div className={styles.brand}>
            <Logo />
            <span>Orbit Desk</span>
          </div>
          <h1 id="login-title" className={styles.title}>
            <GradientText>Sign in to your queue</GradientText>
          </h1>
          <Input
            id="login-email"
            label="Email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
          <Input
            id="login-password"
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
