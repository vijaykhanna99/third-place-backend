import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../api/ApiContext";
import { ErrorBanner, SuccessBanner } from "../components/ErrorBanner";
import { Loading } from "../components/Loading";

type State = { kind: "missing" } | { kind: "verifying" } | { kind: "verified" } | { kind: "failed"; error: unknown };

/** Public page linked from the verification email: /account/verify-email?token=… */
export function VerifyEmailPage() {
  const api = useApi();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<State>(() => (token ? { kind: "verifying" } : { kind: "missing" }));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setState({ kind: "verifying" });
    api.auth
      .verifyEmail(token)
      .then((res) => {
        if (!cancelled) setState(res.verified ? { kind: "verified" } : { kind: "failed", error: new Error("The server did not confirm the address.") });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: "failed", error: err });
      });
    return () => {
      cancelled = true;
    };
  }, [api, token, attempt]);

  return (
    <div className="card">
      <h1>Email verification</h1>
      {state.kind === "missing" && (
        <ErrorBanner error={new Error("This link is missing its token. Open the link from the email again or request a new one from the app.")} />
      )}
      {state.kind === "verifying" && <Loading label="Verifying your email address…" />}
      {state.kind === "verified" && (
        <SuccessBanner>
          <strong>Your email address is verified.</strong> You can close this page and return to the Third Place app.
        </SuccessBanner>
      )}
      {state.kind === "failed" && (
        <>
          <ErrorBanner error={state.error} title="Verification failed" onRetry={() => setAttempt((n) => n + 1)} />
          <p className="muted">Verification links expire after 24 hours and work once. Request a new link from the app if this one has expired.</p>
        </>
      )}
    </div>
  );
}
