// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

jest.mock("../config.js", () => ({ loadConfig: () => ({ lendingPoolContractId: "pool", alertWebhookUrl: "https://alerts.test" }) }));
jest.mock("../services/db.js", () => ({ prisma: {} }));
jest.mock("../services/soroban.js", () => ({ getInvestorInfo: jest.fn() }));

import { runInvestorPositionReconciliation } from "../jobs/investorPositionReconciliation.js";

function client(position: any) {
  return {
    investorPosition: { findMany: jest.fn().mockResolvedValue([position]), update: jest.fn() },
    auditLog: { create: jest.fn().mockResolvedValue(undefined) },
  };
}

const base = { id: "1", walletAddress: "GABC", deposited: "100", claimedYield: "5", startLedger: 10, tranche: "Senior", accruedYield: "7", absorbedLoss: "0" };

describe("investor position reconciliation", () => {
  it("detects, reports and alerts on an unsafe injected mismatch", async () => {
    const db = client(base);
    const alert = jest.fn().mockResolvedValue(true);
    const result = await runInvestorPositionReconciliation({ client: db, readPosition: async () => ({ ...base, deposited: "101" }), alert });
    expect(result.mismatches[0].fields).toEqual(["deposited"]);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(db.investorPosition.update).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledTimes(2);
  });

  it("records a clean run without alerting", async () => {
    const db = client(base);
    const alert = jest.fn();
    const result = await runInvestorPositionReconciliation({ client: db, readPosition: async () => ({ ...base }), alert });
    expect(result).toMatchObject({ scanned: 1, mismatches: [], corrected: 0, alerted: false });
    expect(alert).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
