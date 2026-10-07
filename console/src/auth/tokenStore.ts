import type { TokenStore } from "../api/client";
import type { TokenResponse } from "../api/types";

export const REFRESH_TOKEN_KEY = "tp.console.refreshToken";
export const IDENTITY_KEY = "tp.console.identity";

export interface Identity {
  did: string;
  handle: string;
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Access token lives in memory only (it is a 15-minute JWT and is re-obtained
 * through the refresh token after a reload). The refresh token and the
 * signed-in identity persist in localStorage.
 */
export class BrowserTokenStore implements TokenStore {
  private accessToken: string | null = null;
  private readonly storage = safeStorage();

  getAccessToken(): string | null {
    return this.accessToken;
  }

  getRefreshToken(): string | null {
    return this.storage?.getItem(REFRESH_TOKEN_KEY) ?? null;
  }

  getIdentity(): Identity | null {
    const raw = this.storage?.getItem(IDENTITY_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<Identity>;
      if (typeof parsed.did === "string" && typeof parsed.handle === "string") {
        return { did: parsed.did, handle: parsed.handle };
      }
    } catch {
      // corrupt entry — treat as signed out
    }
    return null;
  }

  setTokens(tokens: TokenResponse): void {
    this.accessToken = tokens.accessToken;
    this.storage?.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
    this.storage?.setItem(IDENTITY_KEY, JSON.stringify({ did: tokens.did, handle: tokens.handle } satisfies Identity));
  }

  clear(): void {
    this.accessToken = null;
    this.storage?.removeItem(REFRESH_TOKEN_KEY);
    this.storage?.removeItem(IDENTITY_KEY);
  }
}
