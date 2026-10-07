import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { ErrorBanner } from "../components/ErrorBanner";
import { Field } from "../components/Field";

interface LocationState {
  from?: string;
}

export function LoginPage() {
  const { status, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as LocationState | null)?.from ?? "/";
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);

  if (status === "authenticated") return <Navigate to={from} replace />;

  const identifierError = touched && identifier.trim() === "" ? "Enter your handle or email." : null;
  const passwordError = touched && password === "" ? "Enter your password." : null;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (identifier.trim() === "" || password === "") return;
    setBusy(true);
    setError(null);
    try {
      await signIn(identifier.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app app--public">
      <main className="page page--narrow">
        <form className="card login" onSubmit={(e) => void onSubmit(e)} noValidate>
          <h1 className="login__title">
            <span className="brand__mark" aria-hidden="true" /> Third Place Console
          </h1>
          <p className="muted">Sign in with your operator account.</p>
          <ErrorBanner error={error} onDismiss={() => setError(null)} />
          <Field label="Handle or email" required error={identifierError}>
            {(id, describedBy) => (
              <input
                id={id}
                className="input"
                autoComplete="username"
                autoFocus
                value={identifier}
                aria-describedby={describedBy}
                onChange={(e) => setIdentifier(e.target.value)}
                disabled={busy}
              />
            )}
          </Field>
          <Field label="Password" required error={passwordError}>
            {(id, describedBy) => (
              <input
                id={id}
                type="password"
                className="input"
                autoComplete="current-password"
                value={password}
                aria-describedby={describedBy}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
            )}
          </Field>
          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </main>
    </div>
  );
}
