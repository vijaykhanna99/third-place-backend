import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../api/ApiContext";
import { ErrorBanner, SuccessBanner } from "../components/ErrorBanner";
import { Field } from "../components/Field";

export const PASSWORD_MIN = 10;

export function passwordIssues(password: string, confirm: string): { password: string | null; confirm: string | null } {
  return {
    password: password.length < PASSWORD_MIN ? `Use at least ${PASSWORD_MIN} characters.` : null,
    confirm: confirm !== password ? "Passwords do not match." : null,
  };
}

/** Public page linked from the reset email: /account/reset-password?token=… */
export function ResetPasswordPage() {
  const api = useApi();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const issues = passwordIssues(password, confirm);
  const invalid = issues.password !== null || issues.confirm !== null;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.auth.resetPassword(token, password);
      if (res.reset) setDone(true);
      else setError(new Error("The server did not confirm the reset."));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <div className="card">
        <h1>Reset password</h1>
        <ErrorBanner error={new Error("This link is missing its token. Open the link from the email again or request a new reset from the app.")} />
      </div>
    );
  }

  if (done) {
    return (
      <div className="card">
        <h1>Reset password</h1>
        <SuccessBanner>
          <strong>Your password has been changed.</strong> Every existing session was signed out; sign in again in the Third Place app with the new password.
        </SuccessBanner>
      </div>
    );
  }

  return (
    <form className="card" onSubmit={(e) => void onSubmit(e)} noValidate>
      <h1>Reset password</h1>
      <p className="muted">Choose a new password for your Third Place account. Reset links expire after 30 minutes.</p>
      <ErrorBanner error={error} title="Reset failed" onDismiss={() => setError(null)} />
      <Field label="New password" required error={touched ? issues.password : null} hint={`At least ${PASSWORD_MIN} characters.`}>
        {(id, describedBy) => (
          <input
            id={id}
            type="password"
            className="input"
            autoComplete="new-password"
            value={password}
            aria-describedby={describedBy}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
      </Field>
      <Field label="Confirm new password" required error={touched ? issues.confirm : null}>
        {(id, describedBy) => (
          <input
            id={id}
            type="password"
            className="input"
            autoComplete="new-password"
            value={confirm}
            aria-describedby={describedBy}
            disabled={busy}
            onChange={(e) => setConfirm(e.target.value)}
          />
        )}
      </Field>
      <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
        {busy ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}
