import { expect, test } from "@playwright/test";
import { brokenBundle, configureConsole, hlsBundle, login, OPERATOR } from "./helpers";

test.beforeEach(async ({ page }) => {
  await configureConsole(page);
});

test("redirects anonymous visitors to the login page and back after signing in", async ({ page }) => {
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel(/Handle or email/).fill(OPERATOR.handle);
  await page.getByLabel(/^Password/).fill(OPERATOR.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
});

test("rejects bad credentials with the API error code", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/Handle or email/).fill(OPERATOR.handle);
  await page.getByLabel(/^Password/).fill("definitely-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("unauthenticated: Invalid credentials");
});

test("operator creates a two-angle program from ZIP uploads, edits it and deletes it", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "Music" })).toBeVisible();
  await expect(page.getByText("Neon Nights — Immersive Live")).toBeVisible();

  // Step 1: details.
  await page.getByRole("link", { name: "New program" }).first().click();
  await expect(page.getByRole("heading", { name: "Program details" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Title is required.")).toBeVisible();

  const title = `Courtside Sessions ${Date.now()}`;
  await page.getByLabel(/^Title/).fill(title);
  await page.getByLabel(/^Description/).fill("Two camera angles from the baseline.");
  await page.getByLabel("Sports").check();
  await page.getByRole("textbox", { name: /^Thumbnail/ }).fill("https://cdn.example/courtside.jpg");
  await page.getByRole("button", { name: "Next" }).click();

  // Step 2: one episode, two angles via ZIP upload.
  const episode = page.getByTestId("episode").first();
  await episode.getByLabel(/Episode title/).fill("Game one");
  await episode.getByLabel(/Publish date/).fill("2026-07-01T12:00");
  await episode.getByLabel("Season 1 episode 1 angle 1 archive").setInputFiles({ name: "main.zip", mimeType: "application/zip", buffer: hlsBundle("main") });
  await episode.getByRole("button", { name: /Add angle/ }).click();
  const angles = episode.getByTestId("angle");
  await angles.nth(1).getByLabel(/Angle name/).fill("Side");
  await episode.getByLabel("Season 1 episode 1 angle 2 archive").setInputFiles({ name: "side.zip", mimeType: "application/zip", buffer: hlsBundle("side") });

  await expect(angles.nth(0).locator(".upload-card")).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
  await expect(angles.nth(1).locator(".upload-card")).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
  await expect(angles.nth(0)).toContainText("Ready");
  await page.getByRole("button", { name: "Next" }).click();

  // Step 3: review and create.
  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  const create = page.getByRole("button", { name: "Create program" });
  await expect(create).toBeEnabled();
  await create.click();

  await expect(page).toHaveURL(/\/programs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("Program created.")).toBeVisible();
  await expect(page.getByTestId("episode-editor")).toContainText("2 angles");
  await expect(page.getByTestId("episode-editor").locator(".angle-list")).toContainText("Main");
  await expect(page.getByTestId("episode-editor").locator(".angle-list")).toContainText("Side");

  // Dashboard lists it under Sports.
  await page.getByRole("link", { name: "Dashboard" }).click();
  const sports = page.locator("section.genre", { has: page.getByRole("heading", { name: "Sports" }) });
  await expect(sports.getByRole("link", { name: new RegExp(title) })).toBeVisible();
  await sports.getByRole("link", { name: new RegExp(title) }).click();

  // Edit the title.
  const renamed = `${title} (Remastered)`;
  const details = page.locator("form", { has: page.getByRole("heading", { name: "Details" }) });
  await details.getByLabel(/^Title/).fill(renamed);
  await details.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByRole("heading", { name: renamed })).toBeVisible();
  await expect(page.getByText("Program saved.")).toBeVisible();

  // Edit the episode title.
  const editor = page.getByTestId("episode-editor");
  await editor.getByLabel(/^Title/).fill("Game one — remaster");
  await editor.getByRole("button", { name: "Save episode" }).click();
  await expect(editor.getByText("Episode saved.")).toBeVisible();
  await expect(editor.getByRole("heading", { name: /Episode 1: Game one — remaster/ })).toBeVisible();

  // Delete with confirmation.
  await page.getByRole("button", { name: "Delete program" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Delete this program?");
  await dialog.getByRole("button", { name: "Delete program" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Catalog" })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(renamed) })).toHaveCount(0);
});

test("a rejected archive shows the extraction error code and blocks creation", async ({ page }) => {
  await login(page);
  await page.goto("/programs/new");
  await page.getByLabel(/^Title/).fill("Broken upload");
  await page.getByLabel("Music").check();
  await page.getByRole("textbox", { name: /^Thumbnail/ }).fill("https://cdn.example/x.jpg");
  await page.getByRole("button", { name: "Next" }).click();
  const episode = page.getByTestId("episode").first();
  await episode.getByLabel(/Episode title/).fill("Bad");
  await episode.getByLabel(/Publish date/).fill("2026-07-01T12:00");
  await episode.getByLabel("Season 1 episode 1 angle 1 archive").setInputFiles({ name: "broken.zip", mimeType: "application/zip", buffer: brokenBundle() });
  const card = episode.locator(".upload-card");
  await expect(card).toHaveAttribute("data-phase", "failed", { timeout: 20_000 });
  await expect(card).toContainText("missing_master_playlist");
  // The wizard stays on the episodes step while an angle is unusable.
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByTestId("season")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review" })).toHaveCount(0);
  await expect(card).toContainText("Choose another ZIP");
});

test("the session survives a reload through the refresh token", async ({ page }) => {
  await login(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Catalog" })).toBeVisible();
  await expect(page.getByRole("link", { name: `@${OPERATOR.handle}` })).toBeVisible();
});

test("account page lists sessions and surfaces a wrong current password", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Account" }).first().click();
  await expect(page.getByText(`@${OPERATOR.handle}`).first()).toBeVisible();
  const sessions = page.locator("section", { has: page.getByRole("heading", { name: "Sessions" }) });
  await expect(sessions.getByText("this session")).toBeVisible();

  const form = page.locator("section", { has: page.getByRole("heading", { name: "Change password" }) });
  await form.getByLabel(/Current password/).fill("not-the-password");
  await form.getByLabel(/^New password/).fill("a-much-longer-password");
  await form.getByLabel(/Confirm new password/).fill("a-much-longer-password");
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(form.getByRole("alert")).toContainText("unauthenticated: Current password is incorrect");

  await page.getByRole("banner").getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
});
