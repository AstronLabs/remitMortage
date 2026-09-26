import cron from "node-cron";
import tls from "tls";
import { URL } from "url";
import logger from "../utils/logger.js";

export interface MtlsCheckResult {
  endpoint: string;
  valid: boolean;
  daysRemaining: number;
  fingerprint: string;
  expectedFingerprint?: string;
  error?: string;
  staleCertificateDetected: boolean;
}

let task: ReturnType<typeof cron.schedule> | null = null;

export async function checkEndpointMtls(
  endpointUrl: string,
  expectedFingerprint?: string,
  alertDaysThreshold: number = 14
): Promise<MtlsCheckResult> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(endpointUrl);
      const port = parsed.port ? parseInt(parsed.port, 10) : 443;
      const host = parsed.hostname;

      const socket = tls.connect(
        {
          host,
          port,
          servername: host,
          rejectUnauthorized: false, // Inspect certificate metadata even if self-signed in internal environment
        },
        () => {
          const cert = socket.getPeerCertificate();
          socket.destroy();

          if (!cert || !cert.valid_to) {
            resolve({
              endpoint: endpointUrl,
              valid: false,
              daysRemaining: 0,
              fingerprint: "",
              error: "No peer certificate returned from service",
              staleCertificateDetected: false,
            });
            return;
          }

          const validTo = new Date(cert.valid_to);
          const now = new Date();
          const msRemaining = validTo.getTime() - now.getTime();
          const daysRemaining = Math.floor(msRemaining / (1000 * 60 * 60 * 24));
          const fingerprint = cert.fingerprint256 || cert.fingerprint || "";

          let staleCertificateDetected = false;
          if (expectedFingerprint && fingerprint && fingerprint.toLowerCase() !== expectedFingerprint.toLowerCase()) {
            staleCertificateDetected = true;
          }

          if (daysRemaining <= alertDaysThreshold) {
            logger.warn(
              `[mTLS Expiry Alert] Certificate for ${endpointUrl} expires in ${daysRemaining} days (valid_to: ${cert.valid_to})`,
              { endpoint: endpointUrl, daysRemaining, validTo: cert.valid_to, fingerprint }
            );
          }

          if (staleCertificateDetected) {
            logger.error(
              `[mTLS Rotation Alert] Stale certificate detected for endpoint ${endpointUrl}! Expected fingerprint: ${expectedFingerprint}, actual: ${fingerprint}`,
              { endpoint: endpointUrl, expectedFingerprint, actualFingerprint: fingerprint }
            );
          }

          resolve({
            endpoint: endpointUrl,
            valid: daysRemaining > 0 && !staleCertificateDetected,
            daysRemaining,
            fingerprint,
            expectedFingerprint,
            staleCertificateDetected,
          });
        }
      );

      socket.on("error", (err) => {
        logger.error(`[mTLS Verification Error] Failed to connect to ${endpointUrl}`, { error: err.message });
        resolve({
          endpoint: endpointUrl,
          valid: false,
          daysRemaining: 0,
          fingerprint: "",
          error: err.message,
          staleCertificateDetected: false,
        });
      });

      socket.setTimeout(5000, () => {
        socket.destroy();
        resolve({
          endpoint: endpointUrl,
          valid: false,
          daysRemaining: 0,
          fingerprint: "",
          error: "Connection timeout while verifying mTLS certificate",
          staleCertificateDetected: false,
        });
      });
    } catch (err: any) {
      resolve({
        endpoint: endpointUrl,
        valid: false,
        daysRemaining: 0,
        fingerprint: "",
        error: err.message,
        staleCertificateDetected: false,
      });
    }
  });
}

export async function runMtlsRotationVerifier(): Promise<MtlsCheckResult[]> {
  const endpointsRaw = process.env.MTLS_SERVICE_ENDPOINTS || "https://localhost:8443/health,https://auth-service:8443/health";
  const endpoints = endpointsRaw.split(",").map((e) => e.trim()).filter(Boolean);
  const expectedFingerprintsRaw = process.env.EXPECTED_MTLS_FINGERPRINTS || "";
  const expectedFingerprintsMap = new Map<string, string>();

  if (expectedFingerprintsRaw) {
    expectedFingerprintsRaw.split(",").forEach((pair) => {
      const [ep, fp] = pair.split("=").map((s) => s.trim());
      if (ep && fp) expectedFingerprintsMap.set(ep, fp);
    });
  }

  const alertDays = parseInt(process.env.MTLS_EXPIRY_ALERT_DAYS || "14", 10);
  const results: MtlsCheckResult[] = [];

  logger.info(`[mTLS Rotation Verifier] Starting verification scan for ${endpoints.length} endpoints...`);

  for (const endpoint of endpoints) {
    const expectedFp = expectedFingerprintsMap.get(endpoint);
    const result = await checkEndpointMtls(endpoint, expectedFp, alertDays);
    results.push(result);
  }

  const failures = results.filter((r) => !r.valid || r.staleCertificateDetected);
  if (failures.length > 0) {
    logger.error(`[mTLS Rotation Verifier] Scan completed with ${failures.length} issues detected. See MTLS_ROTATION_FAILURE.md runbook.`, { failures });
  } else {
    logger.info(`[mTLS Rotation Verifier] Scan completed successfully. All ${results.length} endpoints verified.`);
  }

  return results;
}

export function startMtlsRotationScheduler(): void {
  if (task) return;
  const schedule = process.env.MTLS_ROTATION_VERIFIER_CRON_SCHEDULE || "0 */6 * * *"; // Every 6 hours
  task = cron.schedule(schedule, () => {
    void runMtlsRotationVerifier().catch((error) => {
      logger.error("[mTLS Rotation Verifier] Scheduled execution failed", { error });
    });
  }, { timezone: "UTC" });
  logger.info(`[mTLS Rotation Verifier] Scheduled rotation verification job: ${schedule}`);
}

export function stopMtlsRotationScheduler(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
