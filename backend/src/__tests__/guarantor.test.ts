/**
 * Tests for the co-signer / guarantor feature.
 *
 * Authorization mechanism under test
 * ────────────────────────────────────
 * verifyStellarGuarantorSignature (services/guarantor.ts) uses the same
 * nacl.sign.detached.verify path already used by verifyEd25519Signature in
 * services/did.ts.  Tests use real Ed25519 key pairs so that signature
 * verification is genuinely exercised, not mocked.
 *
 * Stellar G-address encoding
 * ──────────────────────────
 * StrKey.encodeEd25519PublicKey converts the 32-byte nacl public key into
 * a Stellar G-address, exactly as a real Stellar wallet would present it.
 *
 * On-chain limitation documented in each relevant test.
 */

import nacl from "tweetnacl";
import { StrKey } from "@stellar/stellar-sdk";
import {
  verifyStellarGuarantorSignature,
  buildGuarantorCommitment,
} from "../services/guarantor.js";
import { runRepaymentAudit } from "../jobs/repaymentAudit.js";
import { prisma } from "../services/db.js";
import { queueNotification } from "../services/notification.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("../services/db.js", () => ({
  prisma: {
    loanApplication: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
    applicant: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock("../services/notification.js", () => ({
  queueNotification: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers — real Ed25519 keys and signatures
// ---------------------------------------------------------------------------

/** Generate a Stellar G-address and its matching nacl signing key pair. */
function generateStellarKeypair() {
  const kp = nacl.sign.keyPair();
  const address = StrKey.encodeEd25519PublicKey(Buffer.from(kp.publicKey));
  return { address, secretKey: kp.secretKey, publicKey: kp.publicKey };
}

/**
 * Produce a real Ed25519 signature over the canonical commitment string.
 * Returns the signature as a lowercase hex string — the format expected by
 * verifyStellarGuarantorSignature.
 */
function signCommitment(
  secretKey: Uint8Array,
  borrowerAddress: string,
  principal: string | number,
  loanId: string
): string {
  const commitment = buildGuarantorCommitment(borrowerAddress, principal, loanId);
  const messageBytes = new TextEncoder().encode(commitment);
  const sig = nacl.sign.detached(messageBytes, secretKey);
  return Buffer.from(sig).toString("hex");
}

// ---------------------------------------------------------------------------
// Suite 1 — verifyStellarGuarantorSignature (pure unit tests, no DB)
// ---------------------------------------------------------------------------

describe("verifyStellarGuarantorSignature", () => {
  const borrower = generateStellarKeypair();
  const guarantor = generateStellarKeypair();
  const loanId = "test-loan-001";
  const principal = "1000";

  it("returns true for a valid signature over the correct commitment", () => {
    const sig = signCommitment(
      guarantor.secretKey,
      borrower.address,
      principal,
      loanId
    );
    expect(
      verifyStellarGuarantorSignature(
        guarantor.address,
        borrower.address,
        principal,
        loanId,
        sig
      )
    ).toBe(true);
  });

  it("returns false when the signature was produced by a different key", () => {
    const impostor = generateStellarKeypair();
    const sig = signCommitment(
      impostor.secretKey,      // wrong key
      borrower.address,
      principal,
      loanId
    );
    expect(
      verifyStellarGuarantorSignature(
        guarantor.address,     // claims to be guarantor but sig doesn't match
        borrower.address,
        principal,
        loanId,
        sig
      )
    ).toBe(false);
  });

  it("returns false when the signature is missing (empty string)", () => {
    expect(
      verifyStellarGuarantorSignature(
        guarantor.address,
        borrower.address,
        principal,
        loanId,
        "" // no signature supplied
      )
    ).toBe(false);
  });

  it("returns false when the signature is not valid hex", () => {
    expect(
      verifyStellarGuarantorSignature(
        guarantor.address,
        borrower.address,
        principal,
        loanId,
        "not-hex!!"
      )
    ).toBe(false);
  });

  it("returns false when the guarantor address is invalid", () => {
    const sig = signCommitment(
      guarantor.secretKey,
      borrower.address,
      principal,
      loanId
    );
    expect(
      verifyStellarGuarantorSignature(
        "INVALIDADDRESS",
        borrower.address,
        principal,
        loanId,
        sig
      )
    ).toBe(false);
  });

  it("returns false when the loanId in the commitment is different", () => {
    // Signature is over loanId "test-loan-001" but we verify against "other-loan"
    const sig = signCommitment(
      guarantor.secretKey,
      borrower.address,
      principal,
      loanId
    );
    expect(
      verifyStellarGuarantorSignature(
        guarantor.address,
        borrower.address,
        principal,
        "other-loan",  // different loanId — signature must not verify
        sig
      )
    ).toBe(false);
  });

  it("returns false when the borrower address in the commitment is different", () => {
    const otherBorrower = generateStellarKeypair();
    const sig = signCommitment(
      guarantor.secretKey,
      borrower.address,      // signed for borrower
      principal,
      loanId
    );
    expect(
      verifyStellarGuarantorSignature(
        guarantor.address,
        otherBorrower.address, // presented for a different borrower
        principal,
        loanId,
        sig
      )
    ).toBe(false);
  });

  it("returns false when the principal in the commitment is different", () => {
    const sig = signCommitment(
      guarantor.secretKey,
      borrower.address,
      "1000",              // signed for 1000
      loanId
    );
    expect(
      verifyStellarGuarantorSignature(
        guarantor.address,
        borrower.address,
        "9999",             // presented with a different amount
        loanId,
        sig
      )
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — buildGuarantorCommitment
// ---------------------------------------------------------------------------

describe("buildGuarantorCommitment", () => {
  it("produces the canonical commitment format", () => {
    expect(buildGuarantorCommitment("GABC", "1000", "loan-1")).toBe(
      "guarantee:GABC:1000:loan-1"
    );
  });

  it("coerces numeric principal to string", () => {
    expect(buildGuarantorCommitment("GABC", 1000, "loan-1")).toBe(
      "guarantee:GABC:1000:loan-1"
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — runRepaymentAudit with guarantor (default handling)
// ---------------------------------------------------------------------------

describe("runRepaymentAudit — guarantor liability on default", () => {
  const guarantorKeypair = generateStellarKeypair();
  const guarantorAddress = guarantorKeypair.address;

  const applicantMock = { id: "applicant-1", stellarAddress: "GABCDBORROWER" };

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.applicant.findUnique as jest.Mock).mockResolvedValue(applicantMock);
  });

  // ── Loan with no guarantor ───────────────────────────────────────────────

  it("handles default with no guarantor: notifies borrower only", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-no-guarantor",
        applicantId: "applicant-1",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: yesterday,
        missedPayments: 2,    // will become 3 → DEFAULTED
        lateFeeBalance: 100,
        guarantorAddress: null,
        guarantorStatus: null,
      },
    ]);

    await runRepaymentAudit();

    expect(prisma.loanApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DEFAULTED" }),
      })
    );

    // Only ONE notification: to the borrower.  No guarantor notification.
    expect(queueNotification).toHaveBeenCalledTimes(1);
    expect(queueNotification).toHaveBeenCalledWith(
      `${applicantMock.stellarAddress}@example.com`,
      "EMAIL",
      expect.stringContaining("defaulted")
    );
  });

  // ── Loan with accepted guarantor — default invokes guarantor liability ───

  it("invokes guarantor liability notification on default when guarantor is accepted", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-with-guarantor",
        applicantId: "applicant-1",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: yesterday,
        missedPayments: 2,    // will become 3 → DEFAULTED
        lateFeeBalance: 100,
        guarantorAddress,
        guarantorStatus: "Accepted",
      },
    ]);

    await runRepaymentAudit();

    expect(prisma.loanApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DEFAULTED" }),
      })
    );

    // TWO notifications: borrower default + guarantor liability invocation
    expect(queueNotification).toHaveBeenCalledTimes(2);

    // Borrower gets the default notice
    expect(queueNotification).toHaveBeenCalledWith(
      `${applicantMock.stellarAddress}@example.com`,
      "EMAIL",
      expect.stringContaining("defaulted")
    );

    // Guarantor gets the formal liability demand
    expect(queueNotification).toHaveBeenCalledWith(
      `${guarantorAddress}@example.com`,
      "EMAIL",
      expect.stringContaining("GUARANTOR LIABILITY INVOKED")
    );
    expect(queueNotification).toHaveBeenCalledWith(
      `${guarantorAddress}@example.com`,
      "EMAIL",
      expect.stringContaining("loan-with-guarantor")
    );
  });

  // ── Guarantor is warned at grace-period entry ────────────────────────────

  it("warns guarantor when loan enters grace period", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-grace-guarantor",
        applicantId: "applicant-1",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: null,    // not yet in grace period
        missedPayments: 0,
        lateFeeBalance: 0,
        guarantorAddress,
        guarantorStatus: "Accepted",
      },
    ]);

    await runRepaymentAudit();

    expect(prisma.loanApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ gracePeriodEndsAt: expect.any(Date) }),
      })
    );

    // Two notifications: borrower (grace period) + guarantor (warning)
    expect(queueNotification).toHaveBeenCalledTimes(2);

    expect(queueNotification).toHaveBeenCalledWith(
      `${applicantMock.stellarAddress}@example.com`,
      "EMAIL",
      expect.stringContaining("grace period")
    );

    expect(queueNotification).toHaveBeenCalledWith(
      `${guarantorAddress}@example.com`,
      "EMAIL",
      expect.stringContaining("co-signed")
    );
  });

  // ── Guarantor is warned on each missed payment (not yet defaulted) ───────

  it("warns guarantor on missed payment (missedPayments < 3)", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-miss-guarantor",
        applicantId: "applicant-1",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: yesterday,  // grace period expired
        missedPayments: 1,
        lateFeeBalance: 50,
        guarantorAddress,
        guarantorStatus: "Accepted",
      },
    ]);

    await runRepaymentAudit();

    expect(prisma.loanApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ missedPayments: 2 }),
      })
    );

    // Two notifications: borrower late-fee + guarantor warning
    expect(queueNotification).toHaveBeenCalledTimes(2);

    expect(queueNotification).toHaveBeenCalledWith(
      `${applicantMock.stellarAddress}@example.com`,
      "EMAIL",
      expect.stringContaining("late fee")
    );

    expect(queueNotification).toHaveBeenCalledWith(
      `${guarantorAddress}@example.com`,
      "EMAIL",
      expect.stringContaining("missed payment")
    );
  });

  // ── handleDefault safeguard path also invokes guarantor ──────────────────

  it("invokes guarantor liability via handleDefault safeguard (missedPayments >= 3)", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-safeguard",
        applicantId: "applicant-1",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: null,
        missedPayments: 3,    // already at 3 — safeguard path
        lateFeeBalance: 150,
        guarantorAddress,
        guarantorStatus: "Accepted",
      },
    ]);

    await runRepaymentAudit();

    expect(prisma.loanApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DEFAULTED" }),
      })
    );

    expect(queueNotification).toHaveBeenCalledWith(
      `${guarantorAddress}@example.com`,
      "EMAIL",
      expect.stringContaining("GUARANTOR LIABILITY INVOKED")
    );
  });

  // ── Default with no guarantor: existing test behavior unchanged ───────────

  it("preserves existing behavior: enters grace period without a guarantor", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-no-g-grace",
        applicantId: "applicant-1",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: null,
        missedPayments: 0,
        lateFeeBalance: 0,
        guarantorAddress: null,
        guarantorStatus: null,
      },
    ]);

    await runRepaymentAudit();

    expect(prisma.loanApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loan-no-g-grace" },
        data: expect.objectContaining({ gracePeriodEndsAt: expect.any(Date) }),
      })
    );

    // Only one notification (borrower), no guarantor notification
    expect(queueNotification).toHaveBeenCalledTimes(1);
    expect(queueNotification).toHaveBeenCalledWith(
      `${applicantMock.stellarAddress}@example.com`,
      "EMAIL",
      expect.stringContaining("grace period")
    );
  });

  it("preserves existing behavior: late fee and missed payment increment without a guarantor", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-no-g-miss",
        applicantId: "applicant-1",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: yesterday,
        missedPayments: 1,
        lateFeeBalance: 50,
        guarantorAddress: null,
        guarantorStatus: null,
      },
    ]);

    await runRepaymentAudit();

    expect(prisma.loanApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ missedPayments: 2, lateFeeBalance: 100 }),
      })
    );

    expect(queueNotification).toHaveBeenCalledTimes(1);
  });

  it("preserves existing behavior: DEFAULTED transition on 3rd miss without a guarantor", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-no-g-default",
        applicantId: "applicant-1",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: yesterday,
        missedPayments: 2,
        lateFeeBalance: 100,
        guarantorAddress: null,
        guarantorStatus: null,
      },
    ]);

    await runRepaymentAudit();

    expect(prisma.loanApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DEFAULTED" }),
      })
    );

    expect(queueNotification).toHaveBeenCalledTimes(1);
    expect(queueNotification).toHaveBeenCalledWith(
      `${applicantMock.stellarAddress}@example.com`,
      "EMAIL",
      expect.stringContaining("defaulted")
    );
  });
});
