import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ConfigError, getConfig } from "./config";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

try {
  const config = getConfig();
  root.render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  );
} catch (err) {
  const message = err instanceof ConfigError ? err.message : `Unexpected start-up error: ${err instanceof Error ? err.message : String(err)}`;
  root.render(
    <div className="app app--public">
      <main className="page page--narrow">
        <div className="card">
          <h1>Console not configured</h1>
          <div className="banner banner--error" role="alert">
            <div className="banner__body">{message}</div>
          </div>
          <p className="muted">
            Provide <code>public/config.js</code> (see <code>config.example.js</code>) or, in the container, set <code>API_BASE_URL</code> and <code>APP_KEY</code>.
          </p>
        </div>
      </main>
    </div>,
  );
}
