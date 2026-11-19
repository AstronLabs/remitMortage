import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import createNextIntlPlugin from "next-intl/plugin";

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "https://remitmortgage.com";
const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const STELLAR_RPC_URL =
  process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";

const IPFS_GATEWAYS = [
  "https://ipfs.io",
  "https://cloudflare-ipfs.com",
  "https://gateway.pinata.cloud",
];

const isDev = process.env.NODE_ENV === "development";

const contentSecurityPolicy = [
  "default-src 'self'",
  isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
  isDev
    ? `connect-src 'self' ${BASE_URL} ${HORIZON_URL} ${STELLAR_RPC_URL} ws: wss:`
    : `connect-src 'self' ${BASE_URL} ${HORIZON_URL} ${STELLAR_RPC_URL}`,
  `img-src 'self' ${IPFS_GATEWAYS.join(" ")} data:`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data: https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

// CSP reporting endpoint path
const CSP_REPORT_PATH = "/api/csp/report";

const reportTo = JSON.stringify({
  group: "csp-endpoint",
  max_age: 10886400,
  endpoints: [{ url: CSP_REPORT_PATH }],
  include_subdomains: true,
});

const nextConfig: NextConfig = {
  // The production Dockerfile copies .next/standalone, so the build must emit it.
  output: "standalone",
  // Browser source maps are only emitted for the CI client-bundle secret scan
  // (scripts/client-bundle-secret-scan.mjs); they are never shipped to users.
  productionBrowserSourceMaps: process.env.CLIENT_BUNDLE_SOURCEMAPS === "true",
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `${contentSecurityPolicy}; report-uri ${CSP_REPORT_PATH}; report-to csp-endpoint`,
          },
          {
            key: "Report-To",
            value: reportTo,
          },
        ],
      },
    ];
  },
};

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withSentryConfig(withNextIntl(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  sourcemaps: {
    disable: true,
  },
  disableLogger: true,
});
