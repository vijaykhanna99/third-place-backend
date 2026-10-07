import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { LoginPage } from "./LoginPage";
import { REFRESH_TOKEN_KEY } from "../auth/tokenStore";
import { renderWithProviders } from "../test/render";
import { server, TEST_API } from "../test/server";

describe("LoginPage", () => {
  it("validates empty fields before calling the API", async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.post(`${TEST_API}/api/v1/auth/login`, () => {
        calls += 1;
        return HttpResponse.json({});
      }),
    );
    renderWithProviders(<LoginPage />, { route: "/login", path: "/login" });
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("Enter your handle or email.")).toBeInTheDocument();
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();
    expect(calls).toBe(0);
  });

  it("signs in, persists the session and navigates to the requested page", async () => {
    const user = userEvent.setup();
    let body: unknown;
    server.use(
      http.post(`${TEST_API}/api/v1/auth/login`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ did: "did:tplace:1", handle: "third-place-ops", accessToken: "a", refreshToken: "r", expiresIn: 900 });
      }),
    );
    renderWithProviders(<LoginPage />, {
      route: "/login",
      path: "/login",
      extraRoutes: { "/programs/new": <h1>New program stub</h1> },
    });
    // Simulate arriving from a guarded page.
    window.history.replaceState({ usr: { from: "/programs/new" } }, "");

    await user.type(screen.getByLabelText(/Handle or email/), "third-place-ops");
    await user.type(screen.getByLabelText(/^Password/), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(body).toEqual({ identifier: "third-place-ops", password: "correct horse battery staple" }));
    expect(window.localStorage.getItem(REFRESH_TOKEN_KEY)).toBe("r");
    // MemoryRouter ignores window.history state, so the default target is "/": the page itself is replaced by the route element for "/".
    await waitFor(() => expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument());
  });

  it("shows the API error code when credentials are rejected", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${TEST_API}/api/v1/auth/login`, () =>
        HttpResponse.json({ error: { code: "unauthenticated", message: "Invalid credentials" } }, { status: 401 }),
      ),
    );
    renderWithProviders(<LoginPage />, { route: "/login", path: "/login" });
    await user.type(screen.getByLabelText(/Handle or email/), "ops");
    await user.type(screen.getByLabelText(/^Password/), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("unauthenticated: Invalid credentials");
    expect(window.localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
  });

  it("shows a rate-limit message with the retry hint", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${TEST_API}/api/v1/auth/login`, () =>
        HttpResponse.json({ error: { code: "rate_limited", message: "Too many requests" } }, { status: 429, headers: { "Retry-After": "60" } }),
      ),
    );
    renderWithProviders(<LoginPage />, { route: "/login", path: "/login" });
    await user.type(screen.getByLabelText(/Handle or email/), "ops");
    await user.type(screen.getByLabelText(/^Password/), "whatever-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("rate_limited: Too many requests. Retry in 60s.");
  });
});
