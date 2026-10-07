import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end suite: the production bundle served by `vite preview` on 4173,
 * talking to the in-memory mock API from e2e/mock-api.mjs on 4100. The tests
 * intercept /config.js so the bundle points at the mock without touching
 * public/config.js.
 *
 * Browsers: run `pnpm exec playwright install chromium` once (CI does this),
 * or point PLAYWRIGHT_BROWSERS_PATH at an existing browser cache. Set
 * PLAYWRIGHT_CHROMIUM_PATH to launch a specific Chromium binary instead.
 */
const MOCK_PORT = 4100;
const APP_PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  },
  webServer: [
    {
      command: `node e2e/mock-api.mjs`,
      port: MOCK_PORT,
      env: { MOCK_API_PORT: String(MOCK_PORT) },
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "pnpm build && pnpm preview",
      port: APP_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
