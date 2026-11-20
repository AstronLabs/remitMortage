export type DisplayTimezone = "local" | "UTC";

export const TIMEZONE_STORAGE_PREFIX = "remitmortgage:timezone:";

export function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function timezoneStorageKey(userId = "anonymous"): string {
  return `${TIMEZONE_STORAGE_PREFIX}${userId}`;
}

export function getDisplayTimezone(userId = "anonymous"): DisplayTimezone {
  if (typeof window === "undefined") return "local";
  const saved = window.localStorage.getItem(timezoneStorageKey(userId));
  return saved === "UTC" ? "UTC" : "local";
}

export function formatTimestamp(value: string | number | Date, mode: DisplayTimezone = "local"): string {
  const date = value instanceof Date ? value : new Date(value);
  const timezone = mode === "UTC" ? "UTC" : detectBrowserTimezone();
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(date);
}

export function timezoneLabel(mode: DisplayTimezone = "local"): string {
  return mode === "UTC" ? "UTC" : detectBrowserTimezone();
}
