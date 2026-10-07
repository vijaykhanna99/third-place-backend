/**
 * Runtime configuration. `public/config.js` (or the file the container
 * entrypoint writes) assigns `window.__TP_CONFIG__` before the bundle loads,
 * so one build can be pointed at any backend.
 */
export interface ConsoleConfig {
  /** Backend origin, e.g. http://127.0.0.1:3000 — no trailing slash, no /api/v1. */
  apiBaseURL: string;
  /** One of the backend's APP_KEYS; sent as X-App-Key on public reads. */
  appKey: string;
}

declare global {
  interface Window {
    __TP_CONFIG__?: unknown;
  }
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function parseConfig(raw: unknown): ConsoleConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError("window.__TP_CONFIG__ is missing. Create public/config.js from config.example.js.");
  }
  const record = raw as Record<string, unknown>;
  const apiBaseURL = record.apiBaseURL;
  const appKey = record.appKey;
  if (typeof apiBaseURL !== "string" || apiBaseURL.trim() === "") {
    throw new ConfigError("config.apiBaseURL must be a non-empty string.");
  }
  let origin: URL;
  try {
    origin = new URL(apiBaseURL);
  } catch {
    throw new ConfigError(`config.apiBaseURL is not a valid URL: ${apiBaseURL}`);
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new ConfigError("config.apiBaseURL must use http or https.");
  }
  if (typeof appKey !== "string" || appKey.trim() === "") {
    throw new ConfigError("config.appKey must be a non-empty string.");
  }
  return {
    apiBaseURL: apiBaseURL.replace(/\/+$/, ""),
    appKey,
  };
}

let cached: ConsoleConfig | null = null;

/** Reads and validates the runtime configuration once; throws ConfigError when it is unusable. */
export function getConfig(): ConsoleConfig {
  cached ??= parseConfig(window.__TP_CONFIG__);
  return cached;
}

/** Test hook: forget the cached configuration. */
export function resetConfigCache(): void {
  cached = null;
}
