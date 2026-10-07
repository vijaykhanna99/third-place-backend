import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

export const TEST_API = "http://api.test";
export const TEST_APP_KEY = "test-app-key";

/**
 * Shared msw server; tests add handlers with `server.use(...)`. The provider
 * restores a persisted session on mount, so a default refresh handler keeps
 * signed-in renders quiet.
 */
export const server = setupServer(
  http.post(`${TEST_API}/api/v1/auth/refresh`, () =>
    HttpResponse.json({ did: "did:tplace:test", handle: "ops", accessToken: "access-restored", refreshToken: "refresh-restored", expiresIn: 900 }),
  ),
);
