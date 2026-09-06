export type AnalyticsProperties = Record<string, unknown>;

const enabled = process.env.NEXT_PUBLIC_ANALYTICS_ENABLED !== "false";

/** Fire-and-forget product usage tracking. The server supplies the identity. */
export function track(event: string, properties: AnalyticsProperties = {}): void {
  if (!enabled || typeof window === "undefined") return;
  void fetch("/api/analytics/events", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, properties, timestamp: new Date().toISOString() }),
    keepalive: true,
  }).catch(() => undefined);
}