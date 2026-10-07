import { expect, test } from "@playwright/test";
import { configureConsole, VALID_RESET_TOKEN, VALID_VERIFY_TOKEN } from "./helpers";

test.beforeEach(async ({ page }) => {
  await configureConsole(page);
});

test.describe("verify-email", () => {
  test("confirms a valid token without signing in", async ({ page }) => {
    await page.goto(`/account/verify-email?token=${VALID_VERIFY_TOKEN}`);
    await expect(page.getByText("Your email address is verified.")).toBeVisible();
    await expect(page).not.toHaveURL(/login/);
  });

  test("shows the API error code for a bad token", async ({ page }) => {
    await page.goto("/account/verify-email?token=expired");
    await expect(page.getByRole("alert")).toContainText("invalid_token: Invalid or expired token");
  });

  test("explains a missing token", async ({ page }) => {
    await page.goto("/account/verify-email");
    await expect(page.getByRole("alert")).toContainText("missing its token");
  });
});

test.describe("reset-password", () => {
  test("enforces the minimum length and matching confirmation client-side", async ({ page }) => {
    await page.goto(`/account/reset-password?token=${VALID_RESET_TOKEN}`);
    await page.getByLabel(/^New password/).fill("short");
    await page.getByLabel(/Confirm new password/).fill("different");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText("Use at least 10 characters.")).toBeVisible();
    await expect(page.getByText("Passwords do not match.")).toBeVisible();
  });

  test("resets the password with a valid token", async ({ page }) => {
    await page.goto(`/account/reset-password?token=${VALID_RESET_TOKEN}`);
    await page.getByLabel(/^New password/).fill("brand-new-password-1");
    await page.getByLabel(/Confirm new password/).fill("brand-new-password-1");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText("Your password has been changed.")).toBeVisible();
  });

  test("shows the API error code for an invalid token", async ({ page }) => {
    await page.goto("/account/reset-password?token=nope");
    await page.getByLabel(/^New password/).fill("brand-new-password-1");
    await page.getByLabel(/Confirm new password/).fill("brand-new-password-1");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByRole("alert")).toContainText("invalid_token: Invalid or expired token");
  });

  test("explains a missing token", async ({ page }) => {
    await page.goto("/account/reset-password");
    await expect(page.getByRole("alert")).toContainText("missing its token");
  });
});
