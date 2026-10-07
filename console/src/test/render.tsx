import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../auth/AuthProvider";
import { BrowserTokenStore } from "../auth/tokenStore";
import type { ConsoleConfig } from "../config";
import { TEST_API, TEST_APP_KEY } from "./server";

export const testConfig: ConsoleConfig = { apiBaseURL: TEST_API, appKey: TEST_APP_KEY };

interface Options extends Omit<RenderOptions, "wrapper"> {
  route?: string;
  /** Pre-seeded token store (e.g. an already signed-in operator). */
  tokenStore?: BrowserTokenStore;
  /** Extra routes rendered next to the element, keyed by path. */
  extraRoutes?: Record<string, ReactElement>;
  path?: string;
}

export function signedInStore(): BrowserTokenStore {
  const store = new BrowserTokenStore();
  store.setTokens({ did: "did:tplace:test", handle: "ops", accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 900 });
  return store;
}

export function renderWithProviders(ui: ReactElement, { route = "/", path = "*", tokenStore, extraRoutes = {}, ...options }: Options = {}) {
  return render(
    <AuthProvider config={testConfig} {...(tokenStore ? { tokenStore } : {})}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={path} element={ui} />
          {Object.entries(extraRoutes).map(([p, element]) => (
            <Route key={p} path={p} element={element} />
          ))}
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
    options,
  );
}
