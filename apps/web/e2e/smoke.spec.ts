import { expect, test } from "@playwright/test";

test("renders the app shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "DocuMind" })).toBeVisible();
});
