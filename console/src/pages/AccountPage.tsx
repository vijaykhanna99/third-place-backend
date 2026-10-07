import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "../api/ApiContext";
import type { Account, Session } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner, SuccessBanner } from "../components/ErrorBanner";
import { Field } from "../components/Field";
import { Loading } from "../components/Loading";
import { formatDateTime } from "../lib/format";
import { PASSWORD_MIN, passwordIssues } from "./ResetPasswordPage";

export function AccountPage() {
  return (
    <>
      <div className="page__head">
        <h1>Account</h1>
      </div>
      <div className="stack">
        <ProfileSection />
        <PasswordSection />
        <SessionsSection />
      </div>
    </>
  );
}

function ProfileSection() {
  const api = useApi();
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.account
      .get()
      .then((acc) => {
        if (cancelled) return;
        setAccount(acc);
        setDisplayName(acc.displayName);
        setDescription(acc.description);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [api, reload]);

  const dirty = account !== null && (displayName !== account.displayName || description !== account.description);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const next = await api.account.update({ displayName, description });
      setAccount(next);
      setSaved(true);
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card" aria-labelledby="profile-title">
      <h2 id="profile-title">Profile</h2>
      {error !== null && <ErrorBanner error={error} title="Could not load the account" onRetry={() => setReload((n) => n + 1)} />}
      {account === null && error === null && <Loading />}
      {account && (
        <form onSubmit={(e) => void onSubmit(e)} className="stack stack--tight">
          <dl className="kv">
            <dt>Handle</dt>
            <dd>@{account.handle}</dd>
            <dt>DID</dt>
            <dd>
              <code>{account.did}</code>
            </dd>
            <dt>Email</dt>
            <dd>
              {account.email}
              {account.emailVerifiedAt ? <span className="tag tag--ok">verified</span> : <span className="tag">unverified</span>}
            </dd>
            <dt>Created</dt>
            <dd>{formatDateTime(account.createdAt)}</dd>
          </dl>
          <Field label="Display name">
            {(id) => <input id={id} className="input" maxLength={64} value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={saving} />}
          </Field>
          <Field label="Description">
            {(id) => <textarea id={id} className="input" rows={3} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} disabled={saving} />}
          </Field>
          {saveError !== null && <ErrorBanner error={saveError} onDismiss={() => setSaveError(null)} />}
          {saved && <SuccessBanner onDismiss={() => setSaved(false)}>Profile saved.</SuccessBanner>}
          <div>
            <button type="submit" className="btn btn--primary" disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save profile"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function PasswordSection() {
  const api = useApi();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const issues = passwordIssues(next, confirm);
  const currentIssue = current === "" ? "Enter your current password." : null;
  const invalid = currentIssue !== null || issues.password !== null || issues.confirm !== null;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setDone(false);
    setError(null);
    try {
      await api.account.update({ password: { current, next } });
      setDone(true);
      setCurrent("");
      setNext("");
      setConfirm("");
      setTouched(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="password-title">
      <h2 id="password-title">Change password</h2>
      <form onSubmit={(e) => void onSubmit(e)} className="stack stack--tight" noValidate>
        <Field label="Current password" required error={touched ? currentIssue : null}>
          {(id, describedBy) => (
            <input id={id} type="password" className="input" autoComplete="current-password" value={current} aria-describedby={describedBy} disabled={busy} onChange={(e) => setCurrent(e.target.value)} />
          )}
        </Field>
        <Field label="New password" required hint={`At least ${PASSWORD_MIN} characters.`} error={touched ? issues.password : null}>
          {(id, describedBy) => (
            <input id={id} type="password" className="input" autoComplete="new-password" value={next} aria-describedby={describedBy} disabled={busy} onChange={(e) => setNext(e.target.value)} />
          )}
        </Field>
        <Field label="Confirm new password" required error={touched ? issues.confirm : null}>
          {(id, describedBy) => (
            <input id={id} type="password" className="input" autoComplete="new-password" value={confirm} aria-describedby={describedBy} disabled={busy} onChange={(e) => setConfirm(e.target.value)} />
          )}
        </Field>
        {error !== null && <ErrorBanner error={error} title="Password not changed" onDismiss={() => setError(null)} />}
        {done && <SuccessBanner onDismiss={() => setDone(false)}>Password changed.</SuccessBanner>}
        <div>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? "Changing…" : "Change password"}
          </button>
        </div>
      </form>
    </section>
  );
}

function SessionsSection() {
  const api = useApi();
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.auth.listSessions();
      setSessions(res.sessions);
    } catch (err) {
      setError(err);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (session: Session) => {
    setRevoking(session.sessionID);
    setRevokeError(null);
    try {
      await api.auth.revokeSession(session.sessionID);
      if (session.isCurrent) {
        await signOut();
        navigate("/login", { replace: true });
        return;
      }
      setSessions((prev) => prev?.filter((s) => s.sessionID !== session.sessionID) ?? null);
    } catch (err) {
      setRevokeError(err);
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section className="card" aria-labelledby="sessions-title">
      <div className="card__head">
        <h2 id="sessions-title">Sessions</h2>
        <button type="button" className="btn btn--small" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error !== null && <ErrorBanner error={error} title="Could not load sessions" onRetry={() => void load()} />}
      {revokeError !== null && <ErrorBanner error={revokeError} title="Could not revoke" onDismiss={() => setRevokeError(null)} />}
      {sessions === null && error === null && <Loading />}
      {sessions?.length === 0 && <EmptyState title="No active sessions" />}
      {sessions && sessions.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Device</th>
                <th>Issued</th>
                <th>Last used</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.sessionID}>
                  <td>
                    {session.deviceInfo ?? "Unknown device"}
                    {session.isCurrent && <span className="tag tag--ok">this session</span>}
                  </td>
                  <td>{formatDateTime(session.issuedAt)}</td>
                  <td>{formatDateTime(session.lastUsedAt)}</td>
                  <td className="table__actions">
                    <button type="button" className="btn btn--small btn--danger-ghost" disabled={revoking !== null} onClick={() => void revoke(session)}>
                      {revoking === session.sessionID ? "Revoking…" : session.isCurrent ? "Sign out" : "Revoke"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
