import type { NextConfig } from "next";

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "https://remitmortgage.com";
const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const STELLAR_RPC_URL = process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";

const IPFS_GATEWAYS = [
  "https://ipfs.io",
  "https://cloudflare-ipfs.com",
  "https://gateway.pinata.cloud",
];

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  `connect-src 'self' ${BASE_URL} ${HORIZON_URL} ${STELLAR_RPC_URL}`,
  `img-src 'self' ${IPFS_GATEWAYS.join(" ")}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
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

export default nextConfig;
