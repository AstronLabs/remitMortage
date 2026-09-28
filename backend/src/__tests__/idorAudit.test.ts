// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Automated IDOR audit for loan / applicant / document endpoints (issue #760).
 *
 * 1. Behavioural: cross-user access to another user's loan / borrower record
 *    is rejected (403), owner access is allowed, admin access is allowed, and
 *    operator-only actions reject even the owning borrower.
 * 2. Completeness: every route handler that accepts a resource identifier
 *    (:id, :address, :documentId, :reportId, applicantId, loanId, …) must be
 *    listed in `security/idorRegistry.ts`, so a new ID-accepting endpoint
 *    without a corresponding ownership-check entry fails CI.
 */

import fs from "fs";
import path from "path";
import {
  isAdminRequest,
  requireBorrowerAddressOwnership,
  requireLoanAdmin,
  requireLoanOwnership,
} from "../security/requireResourceOwnership.js";
import { IDOR_ENDPOINT_REGISTRY } from "../security/idorRegistry.js";

jest.mock("../services/loanStore.js", () => ({
  getApplication: jest.fn(),
}));

import { getApplication } from "../services/loanStore.js";

const mockedGetApplication = getApplication as jest.Mock;

function mockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.body = undefined;
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

const OWNER = "GOWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "GOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ADMIN = "GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("IDOR ownership enforcement (issue #760)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_WALLET_ADDRESS = ADMIN;
  });

  afterEach(() => {
    delete process.env.ADMIN_WALLET_ADDRESS;
  });

  it("rejects cross-user loan access with 403", async () => {
    mockedGetApplication.mockResolvedValue({
      id: "loan-1",
      borrowerAddress: OWNER,
      amount: "1000",
      status: "Pending",
    });
    const res = mockRes();
    const out = await requireLoanOwnership(
      { user: { walletAddress: OTHER, network: "stellar" } } as any,
      res,
      "loan-1"
    );
    expect(out).toBeNull();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toMatchObject({ error: "forbidden" });
  });

  it("allows the owning borrower to access their loan", async () => {
    mockedGetApplication.mockResolvedValue({
      id: "loan-1",
      borrowerAddress: OWNER,
      amount: "1000",
      status: "Pending",
    });
    const res = mockRes();
    const out = await requireLoanOwnership(
      { user: { walletAddress: OWNER, network: "stellar" } } as any,
      res,
      "loan-1"
    );
    expect(out).not.toBeNull();
    expect(out?.id).toBe("loan-1");
  });

  it("allows the admin wallet to access any loan", async () => {
    mockedGetApplication.mockResolvedValue({
      id: "loan-1",
      borrowerAddress: OWNER,
      amount: "1000",
      status: "Pending",
    });
    const res = mockRes();
    const out = await requireLoanOwnership(
      { user: { walletAddress: ADMIN, network: "stellar" } } as any,
      res,
      "loan-1"
    );
    expect(out).not.toBeNull();
    expect(isAdminRequest({ user: { walletAddress: ADMIN, network: "stellar" } } as any)).toBe(true);
  });

  it("rejects even the owning borrower on operator-only loan actions", async () => {
    mockedGetApplication.mockResolvedValue({
      id: "loan-1",
      borrowerAddress: OWNER,
      amount: "1000",
      status: "Pending",
    });
    const res = mockRes();
    const out = await requireLoanAdmin(
      { user: { walletAddress: OWNER, network: "stellar" } } as any,
      res,
      "loan-1"
    );
    expect(out).toBeNull();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("allows the admin wallet on operator-only loan actions", async () => {
    mockedGetApplication.mockResolvedValue({
      id: "loan-1",
      borrowerAddress: OWNER,
      amount: "1000",
      status: "Pending",
    });
    const res = mockRes();
    const out = await requireLoanAdmin(
      { user: { walletAddress: ADMIN, network: "stellar" } } as any,
      res,
      "loan-1"
    );
    expect(out).not.toBeNull();
  });

  it("rejects cross-user borrower-address access with 403", () => {
    const res = mockRes();
    const ok = requireBorrowerAddressOwnership(
      { user: { walletAddress: OTHER, network: "stellar" } } as any,
      res,
      OWNER
    );
    expect(ok).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("allows self borrower-address access and admin access", () => {
    expect(
      requireBorrowerAddressOwnership(
        { user: { walletAddress: OWNER, network: "stellar" } } as any,
        mockRes(),
        OWNER
      )
    ).toBe(true);
    expect(
      requireBorrowerAddressOwnership(
        { user: { walletAddress: ADMIN, network: "stellar" } } as any,
        mockRes(),
        OWNER
      )
    ).toBe(true);
  });

  it("returns 404 (not 403) for unknown loan IDs so existence is not leaked differently", async () => {
    mockedGetApplication.mockResolvedValue(null);
    const res = mockRes();
    const out = await requireLoanOwnership(
      { user: { walletAddress: OTHER, network: "stellar" } } as any,
      res,
      "missing"
    );
    expect(out).toBeNull();
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("IDOR registry completeness (issue #760)", () => {
  const routesDir = path.join(__dirname, "..", "routes");

  function routeFiles(): string[] {
    return fs
      .readdirSync(routesDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join(routesDir, f));
  }

  it("registers every route file with an :id/:address/:documentId/:reportId path param", () => {
    const paramPattern = /\w+Router\.(get|post|patch|put|delete)\(\s*["'`]([^"'`]*:(id|address|documentId|reportId|deliveryId|applicationId|applicantId|loanId)[^"'`]*)["'`]/gi;
    const missing: string[] = [];

    for (const file of routeFiles()) {
      const src = fs.readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      paramPattern.lastIndex = 0;
      while ((m = paramPattern.exec(src)) !== null) {
        const routePattern = m[2];
        const covered = IDOR_ENDPOINT_REGISTRY.some((entry) => {
          const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9/:]/g, "");
          return (
            norm(entry.route).includes(norm(routePattern).slice(0, 12)) ||
            norm(routePattern).includes(norm(entry.route).split(" ").pop()!.slice(0, 12))
          );
        });
        if (!covered) missing.push(`${path.basename(file)}: ${m[0].slice(0, 90)}`);
      }
    }

    expect(missing).toEqual([]);
  });

  it("gives every registry entry a named ownership check and test coverage pointer", () => {
    for (const entry of IDOR_ENDPOINT_REGISTRY) {
      expect(entry.ownershipCheck.length).toBeGreaterThan(10);
      expect(entry.coveredBy).toContain("idorAudit.test.ts");
    }
    // Loan, applicant/document, and borrower resources must all be represented.
    const resources = new Set(IDOR_ENDPOINT_REGISTRY.map((e) => e.resource));
    expect(resources.has("loan")).toBe(true);
    expect(resources.has("borrower")).toBe(true);
    expect(resources.has("document")).toBe(true);
  });
});
