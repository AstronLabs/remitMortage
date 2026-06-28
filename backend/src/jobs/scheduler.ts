import cron from "node-cron";
import { runRepaymentAudit } from "./repaymentAudit.js";

let schedulerTask: cron.ScheduledTask | null = null;

export function startScheduler() {
  if (schedulerTask) {
    console.log("[Scheduler] Already running, ignoring start request.");
    return;
  }

  // Schedule to run every day at midnight server time: "0 0 * * *"
  // For testing purposes, it could be scheduled more frequently, but we stick to midnight
  schedulerTask = cron.schedule("0 0 * * *", async () => {
    console.log("[Scheduler] Triggering repayment audit job...");
    await runRepaymentAudit();
  });

  console.log("[Scheduler] Started: daily repayment audit job scheduled.");
}

export function stopScheduler() {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
    console.log("[Scheduler] Stopped.");
  }
}
