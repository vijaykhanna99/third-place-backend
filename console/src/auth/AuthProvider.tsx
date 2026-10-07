import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiClient } from "../api/client";
import { ApiContext } from "../api/ApiContext";
import { createApi } from "../api/endpoints";
import type { ConsoleConfig } from "../config";
import { BrowserTokenStore, type Identity } from "./tokenStore";

export type AuthStatus = "restoring" | "anonymous" | "authenticated";

export interface AuthState {
  status: AuthStatus;
  identity: Identity | null;
  signIn: (identifier: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}

interface Props {
  config: ConsoleConfig;
  children: ReactNode;
  /** Test hook: a prepared token store. */
  tokenStore?: BrowserTokenStore;
}

/**
 * Owns the token store and the API client. On start-up a persisted refresh
 * token is exchanged for a fresh access token (`restoring`); when that fails
 * the console is simply signed out.
 */
export function AuthProvider({ config, children, tokenStore }: Props) {
  const [store] = useState<BrowserTokenStore>(() => tokenStore ?? new BrowserTokenStore());
  const [identity, setIdentity] = useState<Identity | null>(() => store.getIdentity());
  const [status, setStatus] = useState<AuthStatus>(() => (store.getRefreshToken() ? "restoring" : "anonymous"));

  const client = useMemo(
    () =>
      new ApiClient({
        baseURL: config.apiBaseURL,
        appKey: config.appKey,
        tokens: store,
        onSignedOut: () => {
          setIdentity(null);
          setStatus("anonymous");
        },
      }),
    [config.apiBaseURL, config.appKey, store],
  );
  const api = useMemo(() => createApi(client), [client]);

  useEffect(() => {
    if (status !== "restoring") return;
    let cancelled = false;
    void client.refreshOnce().then((ok) => {
      if (cancelled) return;
      if (ok) {
        setIdentity(store.getIdentity());
        setStatus("authenticated");
      } else if (store.getRefreshToken()) {
        // The refresh endpoint was unreachable (network or 5xx). Keep the
        // session: the next authenticated request will refresh again.
        setStatus("authenticated");
      } else {
        setStatus("anonymous");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client, status, store]);

  const signIn = useCallback(
    async (identifier: string, password: string) => {
      const tokens = await api.auth.login({ identifier, password });
      store.setTokens(tokens);
      setIdentity({ did: tokens.did, handle: tokens.handle });
      setStatus("authenticated");
    },
    [api, store],
  );

  const signOut = useCallback(async () => {
    const refreshToken = store.getRefreshToken();
    store.clear();
    setIdentity(null);
    setStatus("anonymous");
    if (refreshToken) {
      try {
        await api.auth.logout(refreshToken);
      } catch {
        // Local state is already cleared; the server-side session expires on its own.
      }
    }
  }, [api, store]);

  const auth = useMemo<AuthState>(() => ({ status, identity, signIn, signOut }), [status, identity, signIn, signOut]);
  const apiValue = useMemo(() => ({ api, client }), [api, client]);

  return (
    <ApiContext.Provider value={apiValue}>
      <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
    </ApiContext.Provider>
  );
}
