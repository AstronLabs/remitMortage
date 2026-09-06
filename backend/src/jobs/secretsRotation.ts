import cron from "node-cron";
import logger from "../utils/logger.js";
import { secrets } from "../services/secretsManager.js";
import { refreshDatabaseCredentials } from "../services/db.js";

let task: ReturnType<typeof cron.schedule> | null = null;

export async function runSecretsRotationRefresh(): Promise<void> {
  await secrets.refreshConfigured();
  await refreshDatabaseCredentials();
  logger.info("[secrets] credential refresh completed");
}

export function startSecretsRotationScheduler(): void {
  if (task) return;
  const schedule = process.env.SECRETS_ROTATION_CRON_SCHEDULE || "*/5 * * * *";
  task = cron.schedule(schedule, () => {
    void runSecretsRotationRefresh().catch((error) => {
      logger.error("[secrets] credential refresh failed", { error });
    });
  }, { timezone: "UTC" });
  logger.info(`[secrets] rotation refresh scheduled: ${schedule}`);
}

export function stopSecretsRotationScheduler(): void {
  task?.stop();
  task = null;
}