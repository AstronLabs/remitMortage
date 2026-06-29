import express from "express";
import request from "supertest";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "../docs/swagger";

jest.mock("../config", () => ({
  loadConfig: () => ({
    allowedOrigins: ["http://localhost:3000"],
  }),
}));

const app = express();
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

describe("GET /api-docs/", () => {
  // swagger-ui-express redirects /api-docs -> /api-docs/, so we test with
  // the trailing-slash path that serves the actual HTML page.

  it("returns 200 and contains Swagger UI HTML", async () => {
    const res = await request(app).get("/api-docs/");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("swagger-ui");
    expect(res.text).toContain("swagger-ui-bundle.js");
    expect(res.text).toContain("swagger-ui-init.js");
  });

  it("serves Swagger UI CSS assets", async () => {
    const res = await request(app).get("/api-docs/swagger-ui.css");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/css");
  });

  it("serves Swagger UI JS bundle", async () => {
    const res = await request(app).get("/api-docs/swagger-ui-bundle.js");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
  });
});
