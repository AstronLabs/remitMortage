// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import {
  AppError,
  assertRegisteredErrorCode,
  getErrorCatalog,
  isRegisteredErrorCode,
} from "../errors/catalog.js";
import { errorCatalogRouter } from "../routes/errorCatalog.js";
import { errorHandler } from "../middleware/errorHandler.js";

describe("Error code catalog (#976)", () => {
  it("exposes every registered error code from the public read-only endpoint", async () => {
    const app = express();
    app.use("/api/errors", errorCatalogRouter);

    const res = await request(app).get("/api/errors");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(getErrorCatalog().length);
    for (const entry of res.body.errors) {
      expect(typeof entry.code).toBe("string");
      expect(typeof entry.httpStatus).toBe("number");
      expect(typeof entry.description).toBe("string");
      expect(typeof entry.remediation).toBe("string");
    }
  });

  it("errorHandler looks up registered codes and includes remediation", async () => {
    const app = express();
    app.get("/boom", (_req, _res, next) => {
      next(new AppError("VALIDATION_ERROR", "Amount must be positive"));
    });
    app.use(errorHandler);

    const res = await request(app).get("/boom");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(isRegisteredErrorCode(res.body.code)).toBe(true);
    expect(res.body.remediation).toBeTruthy();
  });

  it("fails when a route returns an error code that is not in the registry", async () => {
    const app = express();
    app.get("/rogue", (_req, res) => {
      res.status(400).json({ code: "TOTALLY_UNREGISTERED_CODE", message: "oops" });
    });

    const res = await request(app).get("/rogue");
    expect(() => assertRegisteredErrorCode(res.body.code)).toThrow(
      /Unregistered API error code/
    );
  });
});
