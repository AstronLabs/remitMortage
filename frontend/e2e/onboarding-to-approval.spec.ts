import { expect, test } from "@playwright/test";

const BORROWER = "GAXI4LZGQ7F3CKOBU7S6MFYKZRCNFRQVXJXKOMZ7GM7MIFST5W54AAAA";
const RECIPIENT = BORROWER;
const APPLICATION_ID = "e2e-loan-application";

test.describe("borrower onboarding to loan approval", () => {
  test("completes the borrower and admin journeys with deterministic network fixtures", async ({ page }) => {
    let applicationStatus = "Pending";

    await page.addInitScript(({ borrower }) => {
      window.localStorage.clear();
      (window as any).freighterApi = {
        isConnected: async () => true,
        getPublicKey: async () => borrower,
        signBlob: async (blob: string) => `mock-signature-${blob}`,
        requestAccess: async () => undefined,
        getNetwork: async () => "https://horizon-testnet.stellar.org",
        isAllowed: async () => true,
      };
    }, { borrower: BORROWER });

    await page.route("https://horizon-testnet.stellar.org/accounts/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ balances: [] }) })
    );
    await page.route("**/api/verification/check", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ eligible: true, message: "Remittance history verified." }) })
    );
    await page.route("**/*notifications*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notifications: [] }) })
    );
    await page.route("**/api/loan/applications*", async (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: APPLICATION_ID, borrowerAddress: BORROWER, amount: "70000", status: applicationStatus }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
    });
    await page.route("**/api/loan/pending", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: APPLICATION_ID, borrowerAddress: BORROWER, amount: "70000", status: applicationStatus, verificationScore: 92 }]) })
    );
    await page.route(`**/api/loan/${APPLICATION_ID}/approve`, async (route) => {
      applicationStatus = "Approved";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: APPLICATION_ID, status: applicationStatus }) });
    });

    await test.step("connect wallet", async () => {
      await page.goto("/onboarding");
      await page.getByTestId("onboarding-connect-wallet").click();
      await expect(page.getByText(BORROWER)).toBeVisible();
      await page.getByTestId("onboarding-next").click();
    });

    await test.step("verify remittance history", async () => {
      await page.getByTestId("onboarding-recipient").fill(RECIPIENT);
      await page.getByTestId("onboarding-verify").click();
      await expect(page.getByText("Remittance history verified.")).toBeVisible();
      await page.getByTestId("onboarding-next").click();
    });

    await test.step("set savings goal and deposit", async () => {
      await page.getByTestId("onboarding-savings-target").fill("30000");
      await page.getByTestId("onboarding-next").click();
      await page.getByTestId("onboarding-first-deposit").fill("5000");
      await page.getByTestId("onboarding-deposit").click();
      await expect(page).toHaveURL(/\/?redirect=%2Fdashboard$/);
    });

    await test.step("submit loan application", async () => {
      await page.goto("/application");
      await expect(page.getByTestId("loan-application-page")).toBeVisible();
      const connectButton = page.getByRole("button", { name: "Connect wallet" });
      if (await connectButton.isVisible()) await connectButton.click();
      await page.getByTestId("loan-amount").fill("70000");
      await page.getByTestId("loan-submit").click();
      await expect(page.getByTestId("loan-submit-status")).toContainText("Application submitted");
    });

    await test.step("admin approves the submitted loan", async () => {
      await page.context().addCookies([
        { name: "session", value: "e2e-session", domain: "localhost", path: "/" },
      ]);
      await page.goto("/admin");
      const connectButton = page.getByRole("button", { name: "Connect Wallet" });
      if (await connectButton.isVisible()) await connectButton.click();
      await page.getByTestId(`admin-approve-${APPLICATION_ID}`).click();
      await page.getByTestId("admin-confirm-approval").click();
      await expect(page.getByRole("status").filter({ hasText: "Loan approved." }).first()).toBeVisible();
    });
  });
});