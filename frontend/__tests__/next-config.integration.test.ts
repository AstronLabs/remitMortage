import express from "express";
import request from "supertest";

describe("Next config headers integration", () => {
  it("applies CSP header to HTML responses when headers are attached", async () => {
    const { default: nextConfig } = await import("../next.config");
    const headersConfig = await nextConfig.headers();
    expect(Array.isArray(headersConfig)).toBe(true);

    const app = express();

    // Apply headers from the first headers group to all responses
    const headerGroup = headersConfig[0];
    if (headerGroup && Array.isArray(headerGroup.headers)) {
      headerGroup.headers.forEach((h: any) => {
        app.use((req, res, next) => {
          res.setHeader(h.key, h.value);
          next();
        });
      });
    }

    app.get('/', (req, res) => {
      res.set('Content-Type', 'text/html');
      res.send('<!doctype html><html><head><title>Test</title></head><body>ok</body></html>');
    });

    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    const csp = res.header['content-security-policy'] || res.header['Content-Security-Policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("img-src 'self'");
    // Ensure reporting headers are present
    expect(csp).toContain('report-uri /api/csp/report');
    const reportTo = res.header['report-to'];
    expect(reportTo).toBeDefined();
    expect(reportTo).toContain('csp-endpoint');
  });
});
