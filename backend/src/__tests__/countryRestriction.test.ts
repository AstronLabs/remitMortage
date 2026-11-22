// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Mock the geo-IP resolver so the test does not pull in Prisma, and so the
// country mapping is fully deterministic and under the test's control.
jest.mock("../services/locationAnomalyService.js", () => ({
  getIpGeoLocation: jest.fn((ip: string) => {
    const cleanIp = ip.replace(/^::ffff:/, "");
    if (cleanIp.startsWith("10.0.2.")) return { ip: cleanIp, country: "UK", city: "London", latitude: 51.5, longitude: -0.1 };
    if (cleanIp.startsWith("10.0.3.")) return { ip: cleanIp, country: "JP", city: "Tokyo", latitude: 35.7, longitude: 139.7 };
    if (cleanIp.startsWith("10.0.4.")) return { ip: cleanIp, country: "AU", city: "Sydney", latitude: -33.9, longitude: 151.2 };
    return { ip: cleanIp, country: "US", city: "New York", latitude: 40.7, longitude: -74.0 };
  }),
}));

import express from "express";
import request from "supertest";
import logger from "../utils/logger.js";
import { createCountryRestriction, loadCountryRestrictionConfig } from "../middleware/countryRestriction.js";

function buildApp(config: ReturnType<typeof loadCountryRestrictionConfig>) {
  const app = express();
  app.set("trust proxy", true);
  app.use(createCountryRestriction(config));
  app.get("/api/test", (_req, res) => res.json({ ok: true }));
  return app;
}

function configFor(env: Record<string, string | undefined>): ReturnType<typeof loadCountryRestrictionConfig> {
  return loadCountryRestrictionConfig(env as NodeJS.ProcessEnv);
}

beforeEach(() => jest.clearAllMocks());

describe("Country-level access restrictions (#1029)", () => {
  it("blocks a request from a restricted country with a non-specific 403", async () => {
    const app = buildApp(configFor({ RESTRICTED_COUNTRIES: "UK" }));

    const res = await request(app)
      .get("/api/test")
      .set("X-Forwarded-For", "10.0.2.5"); // UK

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "access_denied", message: "Access denied" });
  });

  it("allows a request from an unrestricted country", async () => {
    const app = buildApp(configFor({ RESTRICTED_COUNTRIES: "UK" }));

    const res = await request(app)
      .get("/api/test")
      .set("X-Forwarded-For", "10.0.1.5"); // US

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("allows an override IP within a restricted country", async () => {
    const app = buildApp(configFor({
      RESTRICTED_COUNTRIES: "UK",
      COUNTRY_OVERRIDE_IP_RANGES: "10.0.2.0/24",
    }));

    const res = await request(app)
      .get("/api/test")
      .set("X-Forwarded-For", "10.0.2.5"); // UK, but in override range

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("is inert when no restricted countries are configured", async () => {
    const app = buildApp(configFor({}));

    const res = await request(app)
      .get("/api/test")
      .set("X-Forwarded-For", "10.0.2.5"); // UK

    expect(res.status).toBe(200);
  });

  it("does not reveal the restriction logic in the error response", async () => {
    const app = buildApp(configFor({ RESTRICTED_COUNTRIES: "UK" }));

    const res = await request(app)
      .get("/api/test")
      .set("X-Forwarded-For", "10.0.2.5");

    expect(res.status).toBe(403);
    expect(res.text).not.toMatch(/country|UK|restrict|sanction|region|geo|block/i);
  });

  it("logs the rejection server-side with the country and IP for operators", async () => {
    const app = buildApp(configFor({ RESTRICTED_COUNTRIES: "UK" }));

    await request(app)
      .get("/api/test")
      .set("X-Forwarded-For", "10.0.2.5");

    expect(logger.warn).toHaveBeenCalledWith(
      "Request blocked by country restriction",
      expect.objectContaining({ country: "UK", method: "GET" }),
    );
  });

  it("blocks multiple configured countries", async () => {
    const app = buildApp(configFor({ RESTRICTED_COUNTRIES: "UK,JP" }));

    const ukRes = await request(app).get("/api/test").set("X-Forwarded-For", "10.0.2.5");
    expect(ukRes.status).toBe(403);

    const jpRes = await request(app).get("/api/test").set("X-Forwarded-For", "10.0.3.5");
    expect(jpRes.status).toBe(403);

    const usRes = await request(app).get("/api/test").set("X-Forwarded-For", "10.0.1.5");
    expect(usRes.status).toBe(200);
  });

  it("is case-insensitive for country codes", async () => {
    const app = buildApp(configFor({ RESTRICTED_COUNTRIES: "uk" }));

    const res = await request(app)
      .get("/api/test")
      .set("X-Forwarded-For", "10.0.2.5");

    expect(res.status).toBe(403);
  });

  it("allows a restricted-country IP that matches an exact /32 override", async () => {
    const app = buildApp(configFor({
      RESTRICTED_COUNTRIES: "UK",
      COUNTRY_OVERRIDE_IP_RANGES: "10.0.2.5/32",
    }));

    const res = await request(app)
      .get("/api/test")
      .set("X-Forwarded-For", "10.0.2.5");

    expect(res.status).toBe(200);

    // A different IP in the same country is still blocked.
    const res2 = await request(app)
      .get("/api/test")
      .set("X-Forwarded-For", "10.0.2.6");
    expect(res2.status).toBe(403);
  });
});
