// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";

const getApplicationMock = jest.fn();
jest.mock("../services/loanStore.js", () => ({
  getApplication: (...args: unknown[]) => getApplicationMock(...args),
}));

const logAuditMock = jest.fn();
jest.mock("../services/audit.js", () => ({
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}));

import { loanAgreementRouter } from "../routes/loanAgreement";

const ADMIN = "GADMINWALLET";
const BORROWER = "GBORROWERWALLET";
const STRANGER = "GSTRANGERWALLET";

const loan = {
  id: "loan-1",
  borrowerAddress: BORROWER,
  amount: "70000",
  status: "Approved",
  version: 2,
  interestRateBps: 850,
  loanType: "Purchase",
  rateSheetVersionId: "rs-1",
};

function app() {
  const a = express();
  a.use((req, _res, next) => {
    const wallet = req.header("x-test-wallet");
    if (wallet) (req as any).user = { walletAddress: wallet, network: "testnet" };
    next();
  });
  a.use("/api/loan", loanAgreementRouter);
  return a;
}

const binaryParser = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

describe("loan agreement routes", () => {
  const originalAdmin = process.env.ADMIN_WALLET_ADDRESS;

  beforeAll(() => {
    process.env.ADMIN_WALLET_ADDRESS = ADMIN;
  });
  afterAll(() => {
    process.env.ADMIN_WALLET_ADDRESS = originalAdmin;
  });
  beforeEach(() => {
    getApplicationMock.mockReset();
    logAuditMock.mockReset();
  });

  it("lets the reviewer generate, then the borrower list and download the agreement", async () => {
    getApplicationMock.mockResolvedValue({ ...loan });

    const created = await request(app())
      .post("/api/loan/loan-1/agreements")
      .set("x-test-wallet", ADMIN);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ agreementVersion: 1, loanVersion: 2 });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "loan_agreement_generated", actorAddress: ADMIN })
    );

    const list = await request(app()).get("/api/loan/loan-1/agreements").set("x-test-wallet", BORROWER);
    expect(list.status).toBe(200);
    expect(list.body.agreements).toHaveLength(1);

    const pdf = await request(app())
      .get("/api/loan/loan-1/agreements/1/pdf")
      .set("x-test-wallet", BORROWER)
      .buffer(true)
      .parse(binaryParser);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["x-document-hash"]).toBe(created.body.documentHash);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("keeps other users and borrowers away from generation and other people's agreements", async () => {
    getApplicationMock.mockResolvedValue({ ...loan });

    const byBorrower = await request(app())
      .post("/api/loan/loan-1/agreements")
      .set("x-test-wallet", BORROWER);
    expect(byBorrower.status).toBe(403);

    const byStranger = await request(app())
      .get("/api/loan/loan-1/agreements")
      .set("x-test-wallet", STRANGER);
    expect(byStranger.status).toBe(403);
  });

  it("refuses to generate an agreement for a loan that is not approved", async () => {
    getApplicationMock.mockResolvedValue({ ...loan, id: "loan-2", status: "Pending" });
    const res = await request(app()).post("/api/loan/loan-2/agreements").set("x-test-wallet", ADMIN);
    expect(res.status).toBe(409);
  });
});
