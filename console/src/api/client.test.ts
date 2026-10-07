import { http, HttpResponse } from "msw";
import { ApiClient, ApiError, NetworkError, describeError, type TokenStore } from "./client";
import type { TokenResponse } from "./types";
import { server, TEST_API, TEST_APP_KEY } from "../test/server";

class MemoryTokens implements TokenStore {
  access: string | null;
  refresh: string | null;
  constructor(access: string | null = "access-1", refresh: string | null = "refresh-1") {
    this.access = access;
    this.refresh = refresh;
  }
  getAccessToken() {
    return this.access;
  }
  getRefreshToken() {
    return this.refresh;
  }
  setTokens(tokens: TokenResponse) {
    this.access = tokens.accessToken;
    this.refresh = tokens.refreshToken;
  }
  clear() {
    this.access = null;
    this.refresh = null;
  }
}

const tokenResponse = (n: number): TokenResponse => ({
  did: "did:tplace:x",
  handle: "ops",
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
  expiresIn: 900,
});

function makeClient(tokens = new MemoryTokens(), onSignedOut = vi.fn()) {
  const client = new ApiClient({ baseURL: TEST_API, appKey: TEST_APP_KEY, tokens, onSignedOut });
  return { client, tokens, onSignedOut };
}

describe("ApiClient", () => {
  it("sends the bearer token on operator calls and the app key on public reads", async () => {
    const seen: Record<string, string | null>[] = [];
    server.use(
      http.get(`${TEST_API}/api/v1/account`, ({ request }) => {
        seen.push({ auth: request.headers.get("authorization"), key: request.headers.get("x-app-key") });
        return HttpResponse.json({ did: "d" });
      }),
      http.get(`${TEST_API}/api/v1/genres`, ({ request }) => {
        seen.push({ auth: request.headers.get("authorization"), key: request.headers.get("x-app-key") });
        return HttpResponse.json({ genres: [] });
      }),
    );
    const { client } = makeClient();
    await client.request("/api/v1/account");
    await client.request("/api/v1/genres", { auth: "appKey" });
    expect(seen).toEqual([
      { auth: "Bearer access-1", key: null },
      { auth: null, key: TEST_APP_KEY },
    ]);
  });

  it("serialises query parameters and drops empty ones", async () => {
    let url = "";
    server.use(
      http.get(`${TEST_API}/api/v1/search`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ programs: [] });
      }),
    );
    const { client } = makeClient();
    await client.request("/api/v1/search", { auth: "appKey", query: { query: "neon lights", limit: 20, cursor: null } });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("query")).toBe("neon lights");
    expect(parsed.searchParams.get("limit")).toBe("20");
    expect(parsed.searchParams.has("cursor")).toBe(false);
  });

  it("turns the error envelope into an ApiError with the code", async () => {
    server.use(
      http.get(`${TEST_API}/api/v1/programs/missing`, () =>
        HttpResponse.json({ error: { code: "not_found", message: "Resource not found" } }, { status: 404 }),
      ),
    );
    const { client } = makeClient();
    const err = await client.request("/api/v1/programs/missing", { auth: "appKey" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err as ApiError).toMatchObject({ status: 404, code: "not_found", message: "Resource not found" });
    expect(describeError(err)).toBe("not_found: Resource not found");
  });

  it("reports Retry-After on 429", async () => {
    server.use(
      http.get(`${TEST_API}/api/v1/genres`, () =>
        HttpResponse.json({ error: { code: "rate_limited", message: "Too many requests" } }, { status: 429, headers: { "Retry-After": "7" } }),
      ),
    );
    const { client } = makeClient();
    const err = await client.request("/api/v1/genres", { auth: "appKey" }).catch((e: unknown) => e);
    expect((err as ApiError).retryAfterSec).toBe(7);
    expect(describeError(err)).toContain("Retry in 7s");
  });

  it("refreshes once on 401 and retries the original request with the new token", async () => {
    const authHeaders: (string | null)[] = [];
    let refreshCalls = 0;
    server.use(
      http.get(`${TEST_API}/api/v1/account`, ({ request }) => {
        const auth = request.headers.get("authorization");
        authHeaders.push(auth);
        if (auth !== "Bearer access-2") {
          return HttpResponse.json({ error: { code: "unauthenticated", message: "Authentication required" } }, { status: 401 });
        }
        return HttpResponse.json({ handle: "ops" });
      }),
      http.post(`${TEST_API}/api/v1/auth/refresh`, async ({ request }) => {
        refreshCalls += 1;
        const body = (await request.json()) as { refreshToken: string };
        expect(body.refreshToken).toBe("refresh-1");
        return HttpResponse.json(tokenResponse(2));
      }),
    );
    const { client, tokens, onSignedOut } = makeClient();
    const result = await client.request<{ handle: string }>("/api/v1/account");
    expect(result).toEqual({ handle: "ops" });
    expect(authHeaders).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(refreshCalls).toBe(1);
    expect(tokens.refresh).toBe("refresh-2");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("shares a single in-flight refresh between concurrent 401s", async () => {
    let refreshCalls = 0;
    server.use(
      http.get(`${TEST_API}/api/v1/:resource`, ({ request, params }) => {
        if (request.headers.get("authorization") !== "Bearer access-2") {
          return HttpResponse.json({ error: { code: "unauthenticated", message: "Authentication required" } }, { status: 401 });
        }
        return HttpResponse.json({ resource: params.resource });
      }),
      http.post(`${TEST_API}/api/v1/auth/refresh`, async () => {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return HttpResponse.json(tokenResponse(2));
      }),
    );
    const { client } = makeClient();
    const results = await Promise.all([
      client.request<{ resource: string }>("/api/v1/account"),
      client.request<{ resource: string }>("/api/v1/sessions"),
      client.request<{ resource: string }>("/api/v1/uploads"),
    ]);
    expect(results.map((r) => r.resource)).toEqual(["account", "sessions", "uploads"]);
    expect(refreshCalls).toBe(1);
  });

  it("signs out and rethrows the original error when the refresh is rejected", async () => {
    let accountCalls = 0;
    server.use(
      http.get(`${TEST_API}/api/v1/account`, () => {
        accountCalls += 1;
        return HttpResponse.json({ error: { code: "unauthenticated", message: "Authentication required" } }, { status: 401 });
      }),
      http.post(`${TEST_API}/api/v1/auth/refresh`, () =>
        HttpResponse.json({ error: { code: "invalid_token", message: "Invalid or expired token" } }, { status: 401 }),
      ),
    );
    const { client, tokens, onSignedOut } = makeClient();
    const err = await client.request("/api/v1/account").catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("unauthenticated");
    expect(accountCalls).toBe(1);
    expect(tokens.access).toBeNull();
    expect(tokens.refresh).toBeNull();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("keeps the stored session when the refresh endpoint is unreachable", async () => {
    server.use(
      http.get(`${TEST_API}/api/v1/account`, () =>
        HttpResponse.json({ error: { code: "unauthenticated", message: "Authentication required" } }, { status: 401 }),
      ),
      http.post(`${TEST_API}/api/v1/auth/refresh`, () => HttpResponse.error()),
    );
    const { client, tokens, onSignedOut } = makeClient();
    await expect(client.request("/api/v1/account")).rejects.toBeInstanceOf(ApiError);
    expect(tokens.refresh).toBe("refresh-1");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("does not try to refresh when there is no refresh token", async () => {
    let refreshCalls = 0;
    server.use(
      http.get(`${TEST_API}/api/v1/account`, () =>
        HttpResponse.json({ error: { code: "unauthenticated", message: "Authentication required" } }, { status: 401 }),
      ),
      http.post(`${TEST_API}/api/v1/auth/refresh`, () => {
        refreshCalls += 1;
        return HttpResponse.json(tokenResponse(2));
      }),
    );
    const { client, onSignedOut } = makeClient(new MemoryTokens(null, null));
    await expect(client.request("/api/v1/account")).rejects.toBeInstanceOf(ApiError);
    expect(refreshCalls).toBe(0);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("does not refresh for public or unauthenticated calls that answer 401", async () => {
    let refreshCalls = 0;
    server.use(
      http.post(`${TEST_API}/api/v1/auth/login`, () =>
        HttpResponse.json({ error: { code: "unauthenticated", message: "Invalid credentials" } }, { status: 401 }),
      ),
      http.post(`${TEST_API}/api/v1/auth/refresh`, () => {
        refreshCalls += 1;
        return HttpResponse.json(tokenResponse(2));
      }),
    );
    const { client } = makeClient();
    const err = await client.request("/api/v1/auth/login", { body: { identifier: "x", password: "y" }, auth: "none" }).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("unauthenticated");
    expect(refreshCalls).toBe(0);
  });

  it("wraps transport failures in NetworkError", async () => {
    server.use(http.get(`${TEST_API}/api/v1/genres`, () => HttpResponse.error()));
    const { client } = makeClient();
    await expect(client.request("/api/v1/genres", { auth: "appKey" })).rejects.toBeInstanceOf(NetworkError);
  });
});
