import { expect, test } from "@playwright/test";

// Signer public keys mirroring the governance signer registry
const CONTRACTOR_ADDRESS = "GAB123456789CONTRACTORSTELLARPUBLICKEY012345";
const SIGNER_LEAD = "GCOMMITTEELEAD00000000000000000000000000000000000000A";
const SIGNER_LEGAL = "GLEGALREVIEW000000000000000000000000000000000000000B";

const PROPOSAL_ID = "proposal-m1-e2e";
const MILESTONE_ID = "m1";
const MILESTONE_NAME = "Foundation";
const MOCK_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const DISBURSEMENT_TX_HASH = "3f8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f";
const DISBURSEMENT_AMOUNT = "18000.00";

test.describe("Milestone Full Lifecycle E2E: Evidence Upload to On-Chain Disbursement", () => {
  test("completes the real-world contractor upload → multisig quorum → disbursement → payout history flow", async ({
    page,
  }) => {
    // -------------------------------------------------------------------------
    // Mutable Test State Across the Multi-Step Flow
    // -------------------------------------------------------------------------
    let proposalState = {
      proposalId: PROPOSAL_ID,
      milestoneId: MILESTONE_ID,
      evidenceCid: MOCK_CID,
      status: "Open" as "Open" | "Passed",
      requiredWeight: 3,
      totalWeight: 4,
      currentWeight: 0,
      signers: [
        {
          address: SIGNER_LEAD,
          label: "Committee Lead",
          weight: 2,
          status: "pending" as "pending" | "approved",
        },
        {
          address: SIGNER_LEGAL,
          label: "Legal Review",
          weight: 1,
          status: "pending" as "pending" | "approved",
        },
        {
          address: "GFINANCEBOARD00000000000000000000000000000000000000C",
          label: "Finance Board",
          weight: 1,
          status: "pending" as "pending" | "approved",
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    let isDisbursed = false;

    const basePayouts = [
      {
        id: "pay-101",
        date: "2026-02-15T14:30:00Z",
        projectRef: "PRJ-MORT-2026-01",
        projectName: "Horizon Heights Residential - Unit 4B",
        milestoneName: "Substructure Inspection",
        amount: "12500.00",
        currency: "USDC",
        status: "Completed",
        txHash: "4a7f8e12b39d01f5c6789e0123456789abcdef0123456789abcdef0123456789",
        escrowContract: "CCX4V7R3XKEYKJLMNPQRSTUVWYZ23456789ABCDEF",
        contractorAddress: CONTRACTOR_ADDRESS,
        taxYear: "2026",
        notes: "Initial release",
      },
    ];

    // -------------------------------------------------------------------------
    // Wallet & Network Mock Injections (Consistent with Existing E2E Patterns)
    // -------------------------------------------------------------------------
    await page.addInitScript(
      ({ initialKey }) => {
        window.localStorage.clear();
        (window as any).freighterApi = {
          isConnected: async () => true,
          getPublicKey: async () => initialKey,
          signBlob: async (blob: string) => `mock_signature_hex_${blob}`,
          signTransaction: async (xdr: string) => `mock_signed_xdr_${xdr}`,
          requestAccess: async () => undefined,
          getNetwork: async () => "https://horizon-testnet.stellar.org",
          isAllowed: async () => true,
        };
      },
      { initialKey: CONTRACTOR_ADDRESS }
    );

    // Stellar Horizon RPC balances mock
    await page.route("https://horizon-testnet.stellar.org/accounts/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ balances: [] }),
      })
    );

    // Notifications mock
    await page.route("**/*notifications*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ notifications: [] }),
      })
    );

    // Builders reputation mock
    await page.route("**/api/builders*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ builders: [] }),
      })
    );

    // Analytics events mock
    await page.route("**/api/analytics/events*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      })
    );

    // IPFS Evidence Upload Mock (Deterministic Pinning)
    await page.route("**/api/milestone/upload", async (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            cid: MOCK_CID,
            milestoneId: MILESTONE_ID,
            filename: "foundation-inspection-report.jpg",
          }),
        });
      }
      return route.fallback();
    });

    // Milestone Proposal Creation Mock
    await page.route("**/api/milestone/proposals", async (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(proposalState),
        });
      }
      return route.fallback();
    });

    // Signing Status Polling Mock
    await page.route(`**/api/milestone/proposals/${PROPOSAL_ID}/signing-status`, async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(proposalState),
      });
    });

    // Signer Vote Mock (Quorum Tallying Engine)
    await page.route(`**/api/milestone/proposals/${PROPOSAL_ID}/vote`, async (route) => {
      const body = route.request().postDataJSON();
      const signer = proposalState.signers.find((s) => s.address === body.signerAddress);

      if (signer && signer.status === "pending") {
        signer.status = "approved";
        proposalState.currentWeight += signer.weight;
        proposalState.updatedAt = new Date().toISOString();

        if (proposalState.currentWeight >= proposalState.requiredWeight) {
          proposalState.status = "Passed";
        }
      }

      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(proposalState),
      });
    });

    // On-Chain Transaction Submission Mock
    await page.route("**/api/milestone/proposals/submit", async (route) => {
      isDisbursed = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          txHash: DISBURSEMENT_TX_HASH,
        }),
      });
    });

    // Contractor Payouts API Mock
    await page.route("**/api/contractor/payouts*", async (route) => {
      const payouts = [...basePayouts];
      if (isDisbursed) {
        payouts.unshift({
          id: "pay-disbursed-m1",
          date: new Date().toISOString(),
          projectRef: "PRJ-MORT-2026-01",
          projectName: "Horizon Heights Residential - Unit 4B",
          milestoneName: MILESTONE_NAME,
          amount: DISBURSEMENT_AMOUNT,
          currency: "USDC",
          status: "Completed",
          txHash: DISBURSEMENT_TX_HASH,
          escrowContract: "CCX4V7R3XKEYKJLMNPQRSTUVWYZ23456789ABCDEF",
          contractorAddress: CONTRACTOR_ADDRESS,
          taxYear: "2026",
          notes: "Governance multisig quorum reached and funds disbursed",
        });
      }

      const totalAmountUSDC = payouts
        .reduce((sum, p) => sum + parseFloat(p.amount), 0)
        .toFixed(2);

      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          payouts,
          totalCount: payouts.length,
          totalAmountUSDC,
        }),
      });
    });

    // =========================================================================
    // STEP 1: Contractor uploads inspection evidence to IPFS
    // =========================================================================
    await test.step("Step 1: Contractor uploads inspection evidence to IPFS", async () => {
      await page.goto("/contractor");

      // Verify Contractor Portal loaded
      await expect(page.getByText("Contractor Portal")).toBeVisible();
      const milestoneCard = page.getByTestId(`milestone-card-${MILESTONE_ID}`);
      await expect(milestoneCard).toBeVisible();
      await expect(page.getByTestId(`milestone-stage-badge-${MILESTONE_ID}`)).toHaveText("Pending");

      // Attach evidence file via input
      const fileInput = page.locator(`#evidence-upload-${MILESTONE_ID}`);
      await fileInput.setInputFiles({
        name: "foundation-inspection-report.jpg",
        mimeType: "image/jpeg",
        buffer: Buffer.from("inspection-foundation-photo-evidence-content"),
      });

      // Submit evidence to IPFS
      const submitBtn = page.getByTestId(`submit-evidence-btn-${MILESTONE_ID}`);
      await expect(submitBtn).toBeEnabled();
      await submitBtn.click();

      // Assert IPFS upload success and CID presentation
      const uploadSuccess = page.getByTestId(`upload-success-${MILESTONE_ID}`);
      await expect(uploadSuccess).toBeVisible();
      await expect(uploadSuccess).toContainText("Upload Successful");
      await expect(uploadSuccess).toContainText(`CID: ${MOCK_CID}`);
    });

    // =========================================================================
    // STEP 2: Contractor submits disbursement request proposal
    // =========================================================================
    await test.step("Step 2: Contractor submits disbursement request proposal", async () => {
      const requestBtn = page.getByTestId(`request-disbursement-btn-${MILESTONE_ID}`);
      await expect(requestBtn).toBeEnabled();
      await requestBtn.click();

      // Assert milestone transitioned to Proposed stage
      await expect(page.getByTestId(`milestone-stage-badge-${MILESTONE_ID}`)).toHaveText("Proposed");

      // Assert multi-wallet signature queue panel appeared
      const queuePanel = page.getByTestId("signature-queue-panel");
      await expect(queuePanel).toBeVisible();
      await expect(queuePanel).toContainText("Signature Queue");

      // Verify signers are listed in queue
      const signerRows = page.getByTestId("queue-signer-row");
      await expect(signerRows).toHaveCount(3);
    });

    // =========================================================================
    // STEP 3: Multi-wallet governance signers review and approve milestone
    // =========================================================================
    await test.step("Step 3: Multi-wallet signers review and cast approvals", async () => {
      // ── Signer 1: Committee Lead (Weight = 2) ─────────────────────────────
      await page.evaluate((signerKey) => {
        if ((window as any).freighterApi) {
          (window as any).freighterApi.getPublicKey = async () => signerKey;
        }
        window.dispatchEvent(new Event("focus"));
      }, SIGNER_LEAD);

      // Verify Committee Lead is highlighted as active signer ("YOU")
      const leadRow = page.getByTestId("queue-signer-row").filter({ hasText: "Committee Lead" });
      await expect(leadRow.getByText("YOU")).toBeVisible({ timeout: 5000 });

      // Cast signature
      const signBtn = page.getByTestId("sign-vote-btn");
      await expect(signBtn).toBeVisible();
      await signBtn.click();

      // Verify Committee Lead signature recorded
      await expect(leadRow).toContainText("Signed");
      await expect(page.getByText("2 of 3 votes")).toBeVisible();

      // ── Signer 2: Legal Review (Weight = 1) ───────────────────────────────
      await page.evaluate((signerKey) => {
        if ((window as any).freighterApi) {
          (window as any).freighterApi.getPublicKey = async () => signerKey;
        }
        window.dispatchEvent(new Event("focus"));
      }, SIGNER_LEGAL);

      // Verify Legal Review is highlighted as active signer ("YOU")
      const legalRow = page.getByTestId("queue-signer-row").filter({ hasText: "Legal Review" });
      await expect(legalRow.getByText("YOU")).toBeVisible({ timeout: 5000 });

      // Cast signature
      await expect(signBtn).toBeVisible();
      await signBtn.click();

      // Verify Legal Review signature recorded
      await expect(legalRow).toContainText("Signed");
    });

    // =========================================================================
    // STEP 4: Quorum reached and disbursement executes on-chain
    // =========================================================================
    await test.step("Step 4: Quorum reached and disbursement transaction executes on-chain", async () => {
      // Assert Quorum reached banner
      const quorumBanner = page.getByTestId("quorum-reached-banner");
      await expect(quorumBanner).toBeVisible();
      await expect(quorumBanner).toContainText("Quorum reached");
      await expect(quorumBanner).toContainText("All required signatures collected");

      // Submit transaction envelope to the network
      const submitNetworkBtn = page.getByTestId("submit-to-network-btn");
      await expect(submitNetworkBtn).toBeVisible();
      await submitNetworkBtn.click();

      // Assert on-chain execution confirmation and TX hash presentation
      await expect(page.getByText("Transaction submitted")).toBeVisible();
      await expect(page.getByText(`TX: ${DISBURSEMENT_TX_HASH}`)).toBeVisible();

      // Assert Milestone Card stage updated to Approved
      await expect(page.getByTestId(`milestone-stage-badge-${MILESTONE_ID}`)).toHaveText("Approved");
    });

    // =========================================================================
    // STEP 5: Contractor inspects updated payout history and disbursement confirmation
    // =========================================================================
    await test.step("Step 5: Contractor inspects updated payout history", async () => {
      // Navigate to Payout History page
      await page.getByRole("link", { name: /Payout History/i }).click();
      await expect(page).toHaveURL(/\/contractor\/payouts/);

      // Verify Payout History page loaded
      await expect(page.getByText("Contractor Payout History")).toBeVisible();

      // Verify updated total gross payouts metric (includes $18,000.00 disbursement)
      const grossMetric = page.getByTestId("total-gross-payout");
      await expect(grossMetric).toBeVisible();
      await expect(grossMetric).toContainText("30,500.00 USDC");

      // Verify newly disbursed milestone record in the table
      const disbursedRow = page.getByTestId("payout-row").filter({ hasText: MILESTONE_NAME });
      await expect(disbursedRow).toBeVisible();
      await expect(disbursedRow).toContainText(MILESTONE_NAME);
      await expect(disbursedRow).toContainText(`$${DISBURSEMENT_AMOUNT}`);
      await expect(disbursedRow).toContainText("Completed");
      await expect(disbursedRow).toContainText(DISBURSEMENT_TX_HASH.slice(0, 8));
    });
  });

  // ===========================================================================
  // Step-Level Regression Guards
  // ===========================================================================
  test("regression guard: rejects evidence upload with unsupported file type", async ({ page }) => {
    await page.goto("/contractor");

    const fileInput = page.locator(`#evidence-upload-${MILESTONE_ID}`);
    await fileInput.setInputFiles({
      name: "malicious-executable.exe",
      mimeType: "application/x-msdownload",
      buffer: Buffer.from("MZ..."),
    });

    // Assert error message displayed
    await expect(
      page.getByText("Unsupported file type. Please upload JPG, PNG, WEBP, or MP4.")
    ).toBeVisible();

    // Verify submission button remains disabled
    const submitBtn = page.getByTestId(`submit-evidence-btn-${MILESTONE_ID}`);
    await expect(submitBtn).toBeDisabled();
  });
});
