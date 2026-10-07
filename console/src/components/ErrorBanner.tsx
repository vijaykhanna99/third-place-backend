import { describeError } from "../api/client";

interface Props {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}

/** Shows an error with its API code so operators can quote it when asking for help. */
export function ErrorBanner({ error, title, onRetry, onDismiss }: Props) {
  if (error === null || error === undefined) return null;
  return (
    <div className="banner banner--error" role="alert">
      <div className="banner__body">
        {title && <strong>{title}</strong>}
        <span className="banner__message">{describeError(error)}</span>
      </div>
      <div className="banner__actions">
        {onRetry && (
          <button type="button" className="btn btn--small" onClick={onRetry}>
            Retry
          </button>
        )}
        {onDismiss && (
          <button type="button" className="btn btn--small btn--ghost" onClick={onDismiss} aria-label="Dismiss">
            ×
          </button>
        )}
      </div>
    </div>
  );
}

export function SuccessBanner({ children, onDismiss }: { children: React.ReactNode; onDismiss?: () => void }) {
  return (
    <div className="banner banner--success" role="status">
      <div className="banner__body">{children}</div>
      {onDismiss && (
        <button type="button" className="btn btn--small btn--ghost" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}
