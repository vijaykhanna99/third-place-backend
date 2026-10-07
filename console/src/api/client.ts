import type { ApiErrorBody, TokenResponse } from "./types";

/** A non-2xx answer from the API, carrying the contract's `{error:{code,message}}`. */
export class ApiError extends Error {
  override name = "ApiError";
  readonly status: number;
  readonly code: string;
  readonly retryAfterSec: number | null;

  constructor(status: number, code: string, message: string, retryAfterSec: number | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }

  /** Short operator-facing form, e.g. `not_found: Resource not found`. */
  describe(): string {
    return `${this.code}: ${this.message}`;
  }
}

/** The request never reached the API or the response could not be read (offline, CORS, DNS…). */
export class NetworkError extends Error {
  override name = "NetworkError";
}

export type AuthMode = "bearer" | "appKey" | "none";

export interface TokenStore {
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
  setTokens(tokens: TokenResponse): void;
  clear(): void;
}

export interface ApiClientOptions {
  baseURL: string;
  appKey: string;
  tokens: TokenStore;
  /** Called once when a refresh fails and the stored session has been discarded. */
  onSignedOut?: () => void;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  /** JSON body; ignored when `formData` is set. */
  body?: unknown;
  formData?: FormData;
  query?: Record<string, string | number | undefined | null>;
  auth?: AuthMode;
  signal?: AbortSignal;
}

const REFRESH_PATH = "/api/v1/auth/refresh";

/**
 * Thin fetch wrapper around the Third Place API.
 *
 * - Adds `Authorization: Bearer` (operator routes) and `X-App-Key` (public reads).
 * - Parses the contract's error envelope into `ApiError`.
 * - On a 401 from a bearer-authenticated request it refreshes the session once
 *   (one in-flight refresh shared by concurrent callers) and retries the
 *   request a single time; if the refresh itself fails, the stored session is
 *   cleared and `onSignedOut` fires.
 */
export class ApiClient {
  private readonly baseURL: string;
  private readonly appKey: string;
  private readonly tokens: TokenStore;
  private readonly onSignedOut: (() => void) | undefined;
  private readonly fetchImpl: typeof fetch;
  private refreshing: Promise<boolean> | null = null;

  constructor(options: ApiClientOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, "");
    this.appKey = options.appKey;
    this.tokens = options.tokens;
    this.onSignedOut = options.onSignedOut;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const auth = options.auth ?? "bearer";
    const response = await this.send(path, options, auth);
    if (response.status === 401 && auth === "bearer" && path !== REFRESH_PATH) {
      const refreshed = await this.refreshOnce();
      if (refreshed) {
        const retried = await this.send(path, options, auth);
        return this.parse<T>(retried);
      }
    }
    return this.parse<T>(response);
  }

  /** Refreshes the session; concurrent callers share one refresh request. */
  refreshOnce(): Promise<boolean> {
    this.refreshing ??= this.performRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async performRefresh(): Promise<boolean> {
    const refreshToken = this.tokens.getRefreshToken();
    if (!refreshToken) {
      this.signOut();
      return false;
    }
    try {
      const response = await this.send(REFRESH_PATH, { method: "POST", body: { refreshToken } }, "none");
      if (!response.ok) {
        // Any 4xx means the chain is dead (rotated away, revoked, expired). A 5xx
        // or network failure leaves the stored token alone — it may still be valid.
        if (response.status >= 400 && response.status < 500) this.signOut();
        return false;
      }
      const tokens = (await response.json()) as TokenResponse;
      this.tokens.setTokens(tokens);
      return true;
    } catch {
      return false;
    }
  }

  private signOut(): void {
    this.tokens.clear();
    this.onSignedOut?.();
  }

  private async send(path: string, options: RequestOptions, auth: AuthMode): Promise<Response> {
    const url = new URL(this.baseURL + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const headers = new Headers({ Accept: "application/json" });
    if (auth === "bearer") {
      const token = this.tokens.getAccessToken();
      if (token) headers.set("Authorization", `Bearer ${token}`);
    }
    if (auth === "appKey") headers.set("X-App-Key", this.appKey);

    let body: BodyInit | undefined;
    if (options.formData) {
      body = options.formData;
    } else if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }
    const init: RequestInit = {
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers,
    };
    if (body !== undefined) init.body = body;
    if (options.signal) init.signal = options.signal;
    try {
      return await this.fetchImpl(url.toString(), init);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new NetworkError(`Could not reach ${url.origin}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async parse<T>(response: Response): Promise<T> {
    if (response.ok) {
      if (response.status === 204 || response.headers.get("content-length") === "0") return undefined as T;
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    throw await ApiClient.errorFrom(response);
  }

  static async errorFrom(response: Response): Promise<ApiError> {
    const retryAfter = response.headers.get("Retry-After");
    const retryAfterSec = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
    try {
      const body = (await response.json()) as Partial<ApiErrorBody>;
      if (body.error && typeof body.error.code === "string" && typeof body.error.message === "string") {
        return new ApiError(response.status, body.error.code, body.error.message, retryAfterSec);
      }
    } catch {
      // not JSON — fall through
    }
    return new ApiError(response.status, `http_${response.status}`, response.statusText || "Request failed", retryAfterSec);
  }
}

/** Turns any thrown value into a short operator-facing message, keeping API error codes visible. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      const wait = err.retryAfterSec ? ` Retry in ${err.retryAfterSec}s.` : "";
      return `${err.describe()}.${wait}`;
    }
    return err.describe();
  }
  if (err instanceof NetworkError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
