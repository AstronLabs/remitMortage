/** Environment configuration with validation. */

export type StellarNetwork = "testnet" | "mainnet" | "futurenet" | "standalone";

const NETWORK_PASSPHRASE_DEFAULTS: Record<StellarNetwork, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
  standalone: "Standalone Network ; February 2017",
};

export interface Config {
  port: number;
  stellarNetwork: StellarNetwork;
  networkPassphrase: string;
  horizonUrl: string;
  sorobanRpcUrl: string;
  escrowContractId: string;
  lendingPoolContractId: string;
  usdcTokenId: string;
  pinataApiKey: string;
  pinataSecretApiKey: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  webhookSecret: string;
  allowedOrigins: string[];
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || "4000", 10),
    stellarNetwork: (process.env.STELLAR_NETWORK as StellarNetwork) || "testnet",
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE ||
      NETWORK_PASSPHRASE_DEFAULTS[
        (process.env.STELLAR_NETWORK as StellarNetwork) || "testnet"
      ],
    horizonUrl:
      process.env.HORIZON_URL || "https://horizon-testnet.stellar.org",
    sorobanRpcUrl:
      process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
    escrowContractId: process.env.ESCROW_CONTRACT_ID || "",
    lendingPoolContractId: process.env.LENDING_POOL_CONTRACT_ID || "",
    usdcTokenId: process.env.USDC_TOKEN_ID || "",
    pinataApiKey: process.env.PINATA_API_KEY || "",
    pinataSecretApiKey: process.env.PINATA_SECRET_API_KEY || "",
    smtpHost: process.env.SMTP_HOST || "localhost",
    smtpPort: parseInt(process.env.SMTP_PORT || "587", 10),
    smtpUser: process.env.SMTP_USER || "",
    smtpPass: process.env.SMTP_PASS || "",
    smtpFrom: process.env.SMTP_FROM || "no-reply@remitmortgage.com",
    webhookSecret: process.env.WEBHOOK_SECRET || "default_signing_secret_key",
    allowedOrigins: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim())
      : ["http://localhost:3000", "http://localhost:4000"],
  };
}
