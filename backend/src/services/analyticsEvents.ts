import { randomUUID } from "node:crypto";
import { prisma } from "./db.js";
import { queueService, type AnalyticsJobData } from "./queueService.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";

export const MAX_ANALYTICS_BATCH_SIZE = 50;
export const MAX_ANALYTICS_PROPERTIES_BYTES = 16_384;
const EVENT_NAME = /^[a-z][a-z0-9_.-]{1,99}$/;

export type AnalyticsInput = {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
};

export type AnalyticsEventRecord = AnalyticsInput & { id: string; userId: string };

export function validateAnalyticsInput(input: unknown): input is AnalyticsInput {
  if (!input || typeof input !== "object") return false;
  const value = input as Partial<AnalyticsInput>;
  if (typeof value.event !== "string" || !EVENT_NAME.test(value.event)) return false;
  if (!value.properties || typeof value.properties !== "object" || Array.isArray(value.properties)) return false;
  try {
    if (JSON.stringify(value.properties).length > MAX_ANALYTICS_PROPERTIES_BYTES) return false;
  } catch {
    return false;
  }
  return typeof value.timestamp === "string" && !Number.isNaN(Date.parse(value.timestamp));
}

export async function enqueueAnalyticsEvents(userId: string, inputs: AnalyticsInput[]): Promise<void> {
  if (!loadConfig().analyticsEnabled || inputs.length === 0) return;
  const events: AnalyticsEventRecord[] = inputs.map((input) => ({ ...input, id: randomUUID(), userId }));
  const queued = await queueService.addAnalyticsJob({ events });
  if (!queued) await persistAnalyticsEvents(events);
}

export async function persistAnalyticsEvents(events: AnalyticsEventRecord[]): Promise<void> {
  if (!events.length) return;
  await prisma.analyticsEvent.createMany({
    data: events.map(({ id, event, userId, properties, timestamp }) => ({
      id, event, userId, properties, timestamp: new Date(timestamp),
    })),
    skipDuplicates: true,
  });
}

export async function processAnalyticsJob(data: AnalyticsJobData): Promise<void> {
  try {
    await persistAnalyticsEvents(data.events);
  } catch (error) {
    logger.error("[analytics-worker] batch persistence failed", { error, count: data.events.length });
    throw error;
  }
}

export async function getAnalyticsCounts(start: Date, end: Date, event?: string) {
  const rows = await prisma.analyticsEvent.groupBy({
    by: ["event"],
    where: { timestamp: { gte: start, lt: end }, ...(event ? { event } : {}) },
    _count: { _all: true },
    orderBy: { _count: { event: "desc" } },
  });
  return rows.map((row: any) => ({ event: row.event, count: row._count._all }));
}

export async function getAnalyticsFunnel(start: Date, end: Date, events: string[]) {
  const rows = await Promise.all(events.map((event) => prisma.analyticsEvent.count({
    where: { event, timestamp: { gte: start, lt: end } },
    distinct: ["userId"],
  })));
  return { steps: events.map((event, index) => ({ event, count: rows[index] })) };
}