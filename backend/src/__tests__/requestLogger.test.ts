// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import { requestLogger } from "../middleware/requestLogger.js";

describe("Performance Logging Middleware", () => {
  let app: express.Express;
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    app = express();
    app.use(requestLogger);
    app.get("/test", (req, res) => {
      res.status(200).send("OK");
    });
    app.get("/error", (req, res) => {
      res.status(500).send("Error");
    });

    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it("should record the duration and log HTTP GET /test with status 200", async () => {
    const res = await request(app).get("/test");

    expect(res.status).toBe(200);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const logMessage = infoSpy.mock.calls[0][0];
    expect(logMessage).toMatch(/\[Performance\] GET \/test - Status: 200 - \d+\.\d{2}ms - IP: ::ffff:127\.0\.0\.1/);
  });

  it("should log errors and preserve the original status code", async () => {
    const res = await request(app).get("/error");

    expect(res.status).toBe(500);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const logMessage = infoSpy.mock.calls[0][0];
    expect(logMessage).toMatch(/\[Performance\] GET \/error - Status: 500 - \d+\.\d{2}ms - IP: ::ffff:127\.0\.0\.1/);
  });
});
