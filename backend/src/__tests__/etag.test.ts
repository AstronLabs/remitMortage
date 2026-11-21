// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import { computeStrongEtag, strongEtag } from "../middleware/etag.js";

let payload: unknown;

const app = express();
app.use((req, _res, next) => {
  (req as any).user = { walletAddress: req.headers["x-user"] ?? "anonymous" };
  next();
});
app.get("/shared", strongEtag(), (_req, res) => res.json(payload));
app.get("/user-scoped", strongEtag({ userScoped: true }), (_req, res) => res.json(payload));

beforeEach(() => {
  payload = { loans: [{ id: "loan-1", principal: 50000 }] };
});

describe("strongEtag middleware (issue #983)", () => {
  it("returns a strong ETag derived from the response body", async () => {
    const res = await request(app).get("/shared");

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe(computeStrongEtag(payload));
    expect(res.headers.etag).toMatch(/^"[^"]+"$/);
    expect(res.headers.etag.startsWith("W/")).toBe(false);
  });

  it("returns 304 with no body when If-None-Match matches", async () => {
    const first = await request(app).get("/shared");
    const etag = first.headers.etag;

    const second = await request(app).get("/shared").set("If-None-Match", etag);

    expect(second.status).toBe(304);
    expect(second.text).toBe("");
    expect(second.headers.etag).toBe(etag);
  });

  it("accepts a weak comparison of the strong tag in If-None-Match", async () => {
    const first = await request(app).get("/shared");

    const second = await request(app)
      .get("/shared")
      .set("If-None-Match", `W/${first.headers.etag}`);

    expect(second.status).toBe(304);
  });

  it("returns 200 when If-None-Match does not match", async () => {
    const res = await request(app)
      .get("/shared")
      .set("If-None-Match", '"a-different-tag"');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
  });

  it("changes the ETag when the underlying data changes", async () => {
    const first = await request(app).get("/shared");

    payload = { loans: [{ id: "loan-1", principal: 75000 }] };

    const second = await request(app).get("/shared");
    const revalidated = await request(app)
      .get("/shared")
      .set("If-None-Match", first.headers.etag);

    expect(second.headers.etag).not.toBe(first.headers.etag);
    expect(revalidated.status).toBe(200);
  });

  it("scopes user-specific tags so two users never share one", async () => {
    const alice = await request(app).get("/user-scoped").set("x-user", "GALICE");
    const bob = await request(app).get("/user-scoped").set("x-user", "GBOB");

    expect(alice.status).toBe(200);
    expect(bob.status).toBe(200);
    expect(alice.body).toEqual(bob.body);
    expect(alice.headers.etag).not.toBe(bob.headers.etag);
    expect(alice.headers.vary).toMatch(/Authorization/i);

    const aliceTagUsedByBob = await request(app)
      .get("/user-scoped")
      .set("x-user", "GBOB")
      .set("If-None-Match", alice.headers.etag);
    expect(aliceTagUsedByBob.status).toBe(200);

    const bobRevalidates = await request(app)
      .get("/user-scoped")
      .set("x-user", "GBOB")
      .set("If-None-Match", bob.headers.etag);
    expect(bobRevalidates.status).toBe(304);
  });

  it("never converts an error response into a 304", async () => {
    const errorApp = express();
    const body = { error: "not_found" };
    errorApp.get("/missing", strongEtag(), (_req, res) => {
      res.status(404).json(body);
    });

    const res = await request(errorApp)
      .get("/missing")
      .set("If-None-Match", computeStrongEtag(body));

    expect(res.status).toBe(404);
    expect(res.body).toEqual(body);
  });
});
