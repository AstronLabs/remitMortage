// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * API response schema validation against the OpenAPI document (issue #879).
 *
 * Two halves:
 *
 *   1. **The validator** — proves it actually fails on an undocumented field
 *      and on a wrong type. A drift detector nobody has watched fail is not a
 *      drift detector.
 *   2. **Real responses** — every endpoint below is driven through its router
 *      with supertest and its *actual* body checked against the schema the
 *      spec publishes for that method, path and status. Error responses are
 *      covered alongside the success cases.
 *
 * Adding an endpoint here is how its payload becomes contracted. See
 * docs/OPENAPI_RESPONSE_VALIDATION.md for how to change a schema on purpose.
 */

import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";

import { swaggerSpec } from "../docs/swagger";
import {
  assertResponseIsDocumented,
  assertResponseMatchesSpec,
  findOperation,
  formatIssues,
  resolveRef,
  validateAgainstSchema,
  validateResponse,
  type OpenApiDocument,
  type OpenApiSchema,
} from "../utils/openapiValidator";

jest.mock("../services/db", () => ({
  prisma: { $queryRaw: jest.fn() },
  getBorrowerStatus: jest.fn(),
  getApplicant: jest.fn(),
  upsertApplicant: jest.fn().mockResolvedValue({ id: "applicant-1" }),
  createVerificationResult: jest.fn().mockResolvedValue({ id: "vr-1" }),
  getNotificationPreference: jest.fn().mockResolvedValue(null),
}));

jest.mock("../services/stellar", () => ({ analyzeRemittanceHistory: jest.fn() }));

jest.mock("../middleware/rateLimit", () => {
  const passthrough = (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next();
  return {
    verificationChallengeRateLimiter: passthrough,
    verificationOwnershipRateLimiter: passthrough,
    sensitiveRateLimiter: passthrough,
    mutationRateLimiter: passthrough,
    globalRateLimiter: passthrough,
  };
});

jest.mock("../config", () => ({
  loadConfig: () => ({
    horizonUrl: "https://horizon-testnet.stellar.org",
    allowedOrigins: ["http://localhost:3000"],
    adminApiKey: "test_admin_api_key",
    adminAlertEmail: "",
  }),
}));

const spec = swaggerSpec as OpenApiDocument;

// ── The spec itself ──────────────────────────────────────────────────────

describe("the generated OpenAPI document", () => {
  it("is produced with paths and component schemas", () => {
    expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(spec.components?.schemas ?? {}).length).toBeGreaterThan(0);
  });

  it("has no dangling $ref anywhere", () => {
    const dangling: string[] = [];

    const walk = (node: unknown, path: string) => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") {
          if (!resolveRef(spec, value)) dangling.push(`${path}: ${value}`);
        }
        walk(value, `${path}.${key}`);
      }
    };

    walk(spec.paths, "paths");
    walk(spec.components, "components");

    expect(dangling).toEqual([]);
  });
});

// ── The validator fails when it should ───────────────────────────────────

describe("validateAgainstSchema", () => {
  const schema: OpenApiSchema = {
    type: "object",
    required: ["id", "amount"],
    properties: {
      id: { type: "string", format: "uuid" },
      amount: { type: "string" },
      count: { type: "integer", minimum: 0 },
      status: { type: "string", enum: ["open", "closed"] },
      closedAt: { type: "string", format: "date-time", nullable: true },
      tags: { type: "array", items: { type: "string" } },
    },
  };

  const valid = {
    id: "3f3c2e5e-1d6a-4a0b-9f8e-2c6b6a7d8e90",
    amount: "100.50",
    count: 3,
    status: "open",
    closedAt: null,
    tags: ["a", "b"],
  };

  it("passes a body that matches exactly", () => {
    expect(validateAgainstSchema(spec, schema, valid)).toEqual([]);
  });

  // ── The two acceptance criteria ──
  it("fails a response carrying an undocumented field", () => {
    const issues = validateAgainstSchema(spec, schema, { ...valid, surprise: "new field" });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: "surprise", kind: "undocumented_property" });
  });

  it("fails a response whose field has the wrong type", () => {
    const issues = validateAgainstSchema(spec, schema, { ...valid, amount: 100.5 });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: "amount", kind: "type_mismatch" });
    expect(issues[0].message).toMatch(/expected type string but got number/);
  });

  it("fails an undocumented field nested inside an object", () => {
    const nested: OpenApiSchema = {
      type: "object",
      required: ["escrow"],
      properties: {
        escrow: {
          type: "object",
          required: ["deposited"],
          properties: { deposited: { type: "string" } },
        },
      },
    };

    const issues = validateAgainstSchema(spec, nested, {
      escrow: { deposited: "1", withdrawn: false },
    });

    expect(issues).toMatchObject([{ path: "escrow.withdrawn", kind: "undocumented_property" }]);
  });

  it("fails an undocumented field inside an array element", () => {
    const list: OpenApiSchema = {
      type: "array",
      items: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    };

    const issues = validateAgainstSchema(spec, list, [{ id: "a" }, { id: "b", extra: 1 }]);

    expect(issues).toMatchObject([{ path: "[1].extra", kind: "undocumented_property" }]);
  });

  it.each([
    ["a missing required field", { ...valid, amount: undefined }, "missing_required"],
    ["an integer field receiving a float", { ...valid, count: 1.5 }, "type_mismatch"],
    ["a value outside the enum", { ...valid, status: "archived" }, "enum_mismatch"],
    ["a malformed uuid", { ...valid, id: "not-a-uuid" }, "format_mismatch"],
    ["a malformed date-time", { ...valid, closedAt: "yesterday" }, "format_mismatch"],
    ["a number below minimum", { ...valid, count: -1 }, "range_violation"],
    ["an array element of the wrong type", { ...valid, tags: ["a", 2] }, "type_mismatch"],
  ])("fails on %s", (_name, body, kind) => {
    const issues = validateAgainstSchema(spec, schema, body);
    expect(issues.map((issue) => issue.kind)).toContain(kind);
  });

  it("rejects null for a field that is not declared nullable", () => {
    expect(validateAgainstSchema(spec, schema, { ...valid, amount: null })).toMatchObject([
      { path: "amount", kind: "type_mismatch" },
    ]);
  });

  it("accepts null for a field that is declared nullable", () => {
    expect(validateAgainstSchema(spec, schema, { ...valid, closedAt: null })).toEqual([]);
  });

  it("allows undocumented fields when asked to be OpenAPI-faithful", () => {
    expect(
      validateAgainstSchema(spec, schema, { ...valid, surprise: 1 }, { allowUndocumented: true })
    ).toEqual([]);
  });

  it("treats a bare `type: object` as any shape", () => {
    expect(validateAgainstSchema(spec, { type: "object" }, { anything: 1, nested: {} })).toEqual([]);
  });

  it("merges properties across allOf branches before flagging extras", () => {
    const combined: OpenApiSchema = {
      allOf: [
        { type: "object", required: ["a"], properties: { a: { type: "string" } } },
        { type: "object", required: ["b"], properties: { b: { type: "integer" } } },
      ],
      type: "object",
    };

    expect(validateAgainstSchema(spec, combined, { a: "x", b: 1 })).toEqual([]);
    expect(validateAgainstSchema(spec, combined, { a: "x", b: 1, c: true })).toMatchObject([
      { path: "c", kind: "undocumented_property" },
    ]);
  });

  it("reports when no oneOf variant matches", () => {
    const union: OpenApiSchema = {
      oneOf: [{ type: "string" }, { type: "integer" }],
    };

    expect(validateAgainstSchema(spec, union, "ok")).toEqual([]);
    expect(validateAgainstSchema(spec, union, true)).toMatchObject([
      { kind: "no_matching_variant" },
    ]);
  });

  it("reports a dangling $ref rather than passing the value", () => {
    expect(
      validateAgainstSchema(spec, { $ref: "#/components/schemas/DoesNotExist" }, {})
    ).toMatchObject([{ kind: "missing_schema" }]);
  });
});

// ── Operation and status lookup ──────────────────────────────────────────

describe("findOperation", () => {
  it("resolves a literal path", () => {
    expect(findOperation(spec, "GET", "/api/health")?.pathTemplate).toBe("/api/health");
  });

  it("resolves a templated path from a concrete URL", () => {
    const resolved = findOperation(
      spec,
      "GET",
      "/api/borrower/GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF/status"
    );
    expect(resolved?.pathTemplate).toBe("/api/borrower/{address}/status");
  });

  it("ignores the query string", () => {
    expect(findOperation(spec, "GET", "/api/health?verbose=1")?.pathTemplate).toBe("/api/health");
  });

  it("prefers a literal path over a template that would also match", () => {
    expect(findOperation(spec, "GET", "/api/admin/devices")?.pathTemplate).toBe(
      "/api/admin/devices"
    );
  });

  it("returns null for a path the spec does not describe", () => {
    expect(findOperation(spec, "GET", "/api/not-a-real-endpoint")).toBeNull();
  });
});

describe("validateResponse", () => {
  it("reports an undocumented status code", () => {
    const issues = validateResponse(spec, {
      method: "GET",
      path: "/api/health",
      status: 418,
      body: {},
    });

    expect(issues).toMatchObject([{ kind: "undocumented_response" }]);
  });

  it("reports an endpoint missing from the spec entirely", () => {
    expect(
      validateResponse(spec, { method: "GET", path: "/api/ghost", status: 200, body: {} })
    ).toMatchObject([{ kind: "undocumented_response" }]);
  });

  it("formats issues into an actionable message", () => {
    const message = formatIssues(
      { method: "get", path: "/api/health", status: 200, body: {} },
      [{ path: "status", kind: "missing_required", message: "is required" }]
    );

    expect(message).toContain("GET /api/health → 200");
    expect(message).toContain("status [missing_required]");
    expect(message).toContain("OPENAPI_RESPONSE_VALIDATION.md");
  });
});

// ── Real responses: /api/health ──────────────────────────────────────────

describe("GET /api/health", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require("../services/db") as { prisma: { $queryRaw: jest.Mock } };

  function healthApp() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { healthRouter } = require("../routes/health");
    const app = express();
    app.use("/api/health", healthRouter);
    return app;
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("matches the documented 200 shape when everything is healthy", async () => {
    db.prisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as never;

    const res = await request(healthApp()).get("/api/health");

    expect(res.status).toBe(200);
    assertResponseIsDocumented(spec, {
      method: "GET",
      path: "/api/health",
      status: res.status,
      body: res.body,
    });
  });

  it("matches the documented 503 shape when a dependency is down", async () => {
    db.prisma.$queryRaw.mockRejectedValue(new Error("Connection refused"));
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as never;

    const res = await request(healthApp()).get("/api/health");

    expect(res.status).toBe(503);
    expect(res.body.components.database.error).toBe("Connection refused");
    assertResponseIsDocumented(spec, {
      method: "GET",
      path: "/api/health",
      status: res.status,
      body: res.body,
    });
  });
});

// ── Real responses: /api/verification/check ──────────────────────────────

describe("POST /api/verification/check", () => {
  const SENDER = Keypair.random().publicKey();
  const RECIPIENT = Keypair.random().publicKey();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const stellar = require("../services/stellar") as {
    analyzeRemittanceHistory: jest.Mock;
  };

  function verificationApp() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { verificationRouter } = require("../routes/verification");
    const app = express();
    app.use(express.json());
    app.use("/api/verification", verificationRouter);
    return app;
  }

  /** The exact shape `analyzeRemittanceHistory` resolves with. */
  const analysis = {
    senderAddress: SENDER,
    recipientAddress: RECIPIENT,
    totalPayments: 12,
    totalAmountUSDC: "2400.00",
    averageAmountUSDC: "200.00",
    standardDeviation: 12.5,
    selfDealing: false,
    firstPayment: "2025-01-15T10:00:00.000Z",
    lastPayment: "2025-12-15T10:00:00.000Z",
    spanMonths: 11,
    eligible: true,
    reason: "Consistent monthly remittances over 11 months",
  };

  it("matches the documented 200 shape", async () => {
    stellar.analyzeRemittanceHistory.mockResolvedValue(analysis);

    const res = await request(verificationApp())
      .post("/api/verification/check")
      .send({ senderAddress: SENDER, recipientAddress: RECIPIENT });

    expect(res.status).toBe(200);
    assertResponseIsDocumented(spec, {
      method: "POST",
      path: "/api/verification/check",
      status: res.status,
      body: res.body,
    });
  });

  it("matches the documented 400 shape when a field is missing", async () => {
    const res = await request(verificationApp())
      .post("/api/verification/check")
      .send({ recipientAddress: RECIPIENT });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "missing_field", field: "senderAddress" });
    assertResponseIsDocumented(spec, {
      method: "POST",
      path: "/api/verification/check",
      status: res.status,
      body: res.body,
    });
  });

  it("matches the documented 400 shape when an address is malformed", async () => {
    const res = await request(verificationApp())
      .post("/api/verification/check")
      .send({ senderAddress: "not-an-address", recipientAddress: RECIPIENT });

    expect(res.status).toBe(400);
    assertResponseIsDocumented(spec, {
      method: "POST",
      path: "/api/verification/check",
      status: res.status,
      body: res.body,
    });
  });

  it("matches the documented 500 shape when the analysis fails", async () => {
    stellar.analyzeRemittanceHistory.mockRejectedValue(new Error("Horizon unreachable"));

    const res = await request(verificationApp())
      .post("/api/verification/check")
      .send({ senderAddress: SENDER, recipientAddress: RECIPIENT });

    expect(res.status).toBe(500);
    assertResponseIsDocumented(spec, {
      method: "POST",
      path: "/api/verification/check",
      status: res.status,
      body: res.body,
    });
  });

  it("would fail if the handler grew an undocumented field", async () => {
    // Simulates the drift this suite exists to catch: a handler starts
    // returning something the spec does not mention.
    stellar.analyzeRemittanceHistory.mockResolvedValue({
      ...analysis,
      experimentalRiskBand: "B",
    });

    const res = await request(verificationApp())
      .post("/api/verification/check")
      .send({ senderAddress: SENDER, recipientAddress: RECIPIENT });

    const issues = validateResponse(spec, {
      method: "POST",
      path: "/api/verification/check",
      status: res.status,
      body: res.body,
    });

    expect(issues).toMatchObject([
      { path: "experimentalRiskBand", kind: "undocumented_property" },
    ]);
  });
});

// ── Real responses: /api/borrower/{address}/status ───────────────────────

describe("GET /api/borrower/{address}/status", () => {
  const ADDRESS = Keypair.random().publicKey();
  const path = `/api/borrower/${ADDRESS}/status`;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require("../services/db") as {
    getBorrowerStatus: jest.Mock;
    getApplicant: jest.Mock;
  };

  function borrowerApp(caller = ADDRESS) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { borrowerRouter } = require("../routes/borrower");
    const app = express();
    app.use(express.json());
    app.use(
      "/api/borrower",
      (req: express.Request, _res: express.Response, next: express.NextFunction) => {
        (req as express.Request & { user?: unknown }).user = {
          walletAddress: caller,
          network: "stellar",
        };
        next();
      },
      borrowerRouter
    );
    return app;
  }

  it("matches the documented 200 shape for a borrower with no history", async () => {
    db.getBorrowerStatus.mockResolvedValue(null);
    db.getApplicant.mockResolvedValue(null);

    const res = await request(borrowerApp()).get(path);

    expect(res.status).toBe(200);
    expect(res.body.loan.status).toBe("none");
    assertResponseIsDocumented(spec, { method: "GET", path, status: res.status, body: res.body });
  });

  it("matches the documented 200 shape for a borrower with a loan and a verification", async () => {
    db.getBorrowerStatus.mockResolvedValue({
      stellarAddress: ADDRESS,
      escrowBalance: "5000000000",
      loanOutstanding: "7000000000",
      totalDeposited: "5000000000",
      totalDisbursed: "7000000000",
      totalRepaid: "1000000000",
      lastEventLedger: 123456,
    });
    db.getApplicant.mockResolvedValue({
      verificationStatus: "ELIGIBLE",
      creditScore: 78,
      verificationResults: [
        {
          eligible: true,
          totalPayments: 12,
          totalVolume: 2400,
          spanMonths: 11,
          reportHash: "a".repeat(64),
          analyzedAt: new Date("2026-01-05T09:30:00.000Z"),
        },
      ],
      loanApplications: [
        {
          status: "Disbursing",
          principal: "7000000000",
          escrowContractId: "CESCROW000000000000000000000000000000000000000000000000000",
          loanId: "f".repeat(64),
        },
      ],
    });

    const res = await request(borrowerApp()).get(path);

    expect(res.status).toBe(200);
    expect(res.body.verification.analyzedAt).toBe("2026-01-05T09:30:00.000Z");
    assertResponseIsDocumented(spec, { method: "GET", path, status: res.status, body: res.body });
  });

  it("matches the documented 403 shape for another borrower's status", async () => {
    const res = await request(borrowerApp(Keypair.random().publicKey())).get(path);

    expect(res.status).toBe(403);
    assertResponseIsDocumented(spec, { method: "GET", path, status: res.status, body: res.body });
  });

  it("matches the documented 400 shape for a malformed address", async () => {
    const res = await request(borrowerApp("not-an-address")).get(
      "/api/borrower/not-an-address/status"
    );

    expect(res.status).toBe(400);
    assertResponseIsDocumented(spec, {
      method: "GET",
      path: "/api/borrower/not-an-address/status",
      status: res.status,
      body: res.body,
    });
  });

  it("documents escrow.progress on the scale computeProgress actually returns", () => {
    // computeProgress() returns a 0-100 percentage. The spec used to say
    // `maximum: 1`, which no test noticed because the mocked target is 0 and
    // the field is therefore always 0 through the route. Asserting the schema
    // directly is what keeps that from drifting back.
    const schema = resolveRef(spec, "#/components/schemas/BorrowerStatusResponse");
    const progress = schema?.properties?.escrow?.properties?.progress;

    expect(progress).toMatchObject({ type: "number", minimum: 0, maximum: 100 });
  });

  it("matches the documented 500 shape when the lookup throws", async () => {
    db.getBorrowerStatus.mockRejectedValue(new Error("pool exhausted"));

    const res = await request(borrowerApp()).get(path);

    expect(res.status).toBe(500);
    assertResponseIsDocumented(spec, { method: "GET", path, status: res.status, body: res.body });
  });
});

// ── Real responses: /api/admin/devices (issue #886's endpoints) ──────────

describe("admin device endpoints", () => {
  const ADMIN = "GADMIN00000000000000000000000000000000000000000000000000";

  function adminApp() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { adminDevicesRouter } = require("../routes/adminDevices");
    const app = express();
    app.use(express.json());
    app.use("/api/admin", adminDevicesRouter);
    return app;
  }

  beforeEach(() => {
    process.env.ADMIN_WALLET_ADDRESS = ADMIN;
    process.env.ADMIN_DEVICE_BINDING = "monitor";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("../services/adminDeviceBinding")._resetAdminDeviceStore();
  });

  it("matches the documented 201 shape on enrolment", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nacl = require("tweetnacl");
    const publicKey = Buffer.from(nacl.sign.keyPair().publicKey).toString("base64");

    const res = await request(adminApp())
      .post("/api/admin/devices/enroll")
      .set("Authorization", "Bearer test_admin_api_key")
      .send({ publicKey, label: "Laptop" });

    expect(res.status).toBe(201);
    assertResponseIsDocumented(spec, {
      method: "POST",
      path: "/api/admin/devices/enroll",
      status: res.status,
      body: res.body,
    });
  });

  it("matches the documented 400 shape for a malformed key", async () => {
    const res = await request(adminApp())
      .post("/api/admin/devices/enroll")
      .set("Authorization", "Bearer test_admin_api_key")
      .send({ publicKey: "nope" });

    expect(res.status).toBe(400);
    assertResponseIsDocumented(spec, {
      method: "POST",
      path: "/api/admin/devices/enroll",
      status: res.status,
      body: res.body,
    });
  });

  it("matches the documented 200 shape when listing devices", async () => {
    const res = await request(adminApp())
      .get("/api/admin/devices")
      .set("Authorization", "Bearer test_admin_api_key");

    expect(res.status).toBe(200);
    assertResponseIsDocumented(spec, {
      method: "GET",
      path: "/api/admin/devices",
      status: res.status,
      body: res.body,
    });
  });

  it("matches the documented 404 shape when revoking an unknown device", async () => {
    const path = "/api/admin/devices/00000000-0000-0000-0000-000000000000/revoke";

    const res = await request(adminApp())
      .post(path)
      .set("Authorization", "Bearer test_admin_api_key")
      .send({});

    expect(res.status).toBe(404);
    assertResponseMatchesSpec(spec, {
      method: "POST",
      path,
      status: res.status,
      body: res.body,
    });
  });
});
