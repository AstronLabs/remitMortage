// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";

const mockGetScoreLineage = jest.fn();

jest.mock("../services/scoreLineage.js", () => ({
  getScoreLineage: (...args: unknown[]) => mockGetScoreLineage(...args),
}));

jest.mock("../services/db.js", () => ({ prisma: {} }));

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../config.js", () => ({
  loadConfig: () => ({ adminApiKey: "test-admin-key" }),
}));

jest.mock("../middleware/auth.js", () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    if (req.headers.authorization === "Bearer test-admin-key") return next();
    return res.status(401).json({ error: "unauthorized" });
  },
}));

import { adminRouter } from "../routes/admin.js";

const app = express();
app.use(express.json());
app.use("/api/admin", adminRouter);

describe("GET /api/admin/scoring/scores/:scoreId/lineage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires admin authentication", async () => {
    const res = await request(app).get("/api/admin/scoring/scores/score-1/lineage");

    expect(res.status).toBe(401);
    expect(mockGetScoreLineage).not.toHaveBeenCalled();
  });

  it("returns 404 when no lineage exists for the score", async () => {
    mockGetScoreLineage.mockResolvedValue(null);

    const res = await request(app)
      .get("/api/admin/scoring/scores/score-1/lineage")
      .set("Authorization", "Bearer test-admin-key");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("score_lineage_not_found");
    expect(mockGetScoreLineage).toHaveBeenCalledWith("score-1");
  });

  it("returns the stored lineage", async () => {
    const lineage = {
      verificationResultId: "score-1",
      inputs: { totalPayments: 12, totalAmountUSDC: "6000" },
      score: 100,
      modelVersion: "v1.0.0",
      computedAt: "2026-11-20T12:00:00.000Z",
      expiresAt: "2027-11-20T12:00:00.000Z",
    };
    mockGetScoreLineage.mockResolvedValue(lineage);

    const res = await request(app)
      .get("/api/admin/scoring/scores/score-1/lineage")
      .set("Authorization", "Bearer test-admin-key");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lineage });
  });

  it("returns 500 when the lookup fails", async () => {
    mockGetScoreLineage.mockRejectedValue(new Error("db unavailable"));

    const res = await request(app)
      .get("/api/admin/scoring/scores/score-1/lineage")
      .set("Authorization", "Bearer test-admin-key");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("failed_to_fetch_score_lineage");
  });
});
