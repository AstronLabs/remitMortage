// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import {
  issueCsrfToken,
  csrfProtection,
  CSRF_COOKIE,
  CSRF_HEADER,
} from "../middleware/csrf";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(issueCsrfToken);
  app.use(csrfProtection);

  app.get("/api/csrf-token", (req, res) => {
    res.json({ csrfToken: (req as express.Request & { csrfToken?: string }).csrfToken });
  });
  app.post("/api/resource", (_req, res) => res.status(201).json({ ok: true }));
  app.delete("/api/resource/:id", (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

/** Pull a cookie value out of a supertest set-cookie array. */
function readCookie(setCookie: string[] | undefined, name: string): string | undefined {
  const entry = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  return entry?.split(";")[0].split("=")[1];
}

describe("CSRF protection", () => {
  it("issues a readable (non-HttpOnly) CSRF token cookie on a GET", async () => {
    const res = await request(buildApp()).get("/api/csrf-token");
    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"] as unknown as string[];
    const cookieLine = setCookie.find((c) => c.startsWith(`${CSRF_COOKIE}=`));
    expect(cookieLine).toBeDefined();
    expect(cookieLine!.toLowerCase()).not.toContain("httponly");
    expect(res.body.csrfToken).toBeTruthy();
  });

  it("rejects a POST from a cookie-authenticated client with no CSRF token", async () => {
    const res = await request(buildApp())
      .post("/api/resource")
      .set("Cookie", "token=session-jwt")
      .send({ value: 1 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "invalid_csrf_token", statusCode: 403 });
  });

  it("rejects a DELETE from a cookie-authenticated client with no CSRF token", async () => {
    const res = await request(buildApp())
      .delete("/api/resource/42")
      .set("Cookie", "session=abc");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invalid_csrf_token");
  });

  it("rejects a POST whose CSRF header does not match the cookie", async () => {
    const res = await request(buildApp())
      .post("/api/resource")
      .set("Cookie", `token=session-jwt; ${CSRF_COOKIE}=aaaa`)
      .set(CSRF_HEADER, "bbbb")
      .send({ value: 1 });
    expect(res.status).toBe(403);
  });

  it("accepts a POST whose CSRF header matches the cookie", async () => {
    const app = buildApp();

    // Obtain a token from the server first.
    const seed = await request(app).get("/api/csrf-token");
    const csrf = readCookie(seed.headers["set-cookie"] as unknown as string[], CSRF_COOKIE)!;

    const res = await request(app)
      .post("/api/resource")
      .set("Cookie", `token=session-jwt; ${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({ value: 1 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it("exempts Bearer-authenticated requests (not CSRF-able)", async () => {
    const res = await request(buildApp())
      .post("/api/resource")
      .set("Authorization", "Bearer some.jwt.token")
      .send({ value: 1 });
    expect(res.status).toBe(201);
  });

  it("exempts requests that carry no session cookie", async () => {
    const res = await request(buildApp()).post("/api/resource").send({ value: 1 });
    expect(res.status).toBe(201);
  });
});
