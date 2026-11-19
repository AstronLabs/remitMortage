import { detectBrowserTimezone, formatTimestamp, timezoneStorageKey } from "../timezone";

describe("timezone display", () => {
  it("detects the browser timezone", () => {
    expect(detectBrowserTimezone()).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    );
  });

  it("formats UTC timestamps with an explicit UTC mode", () => {
    expect(formatTimestamp("2026-01-01T12:00:00.000Z", "UTC")).toContain("UTC");
  });

  it("uses a stable per-user persistence key", () => {
    expect(timezoneStorageKey("wallet-123")).toBe("remitmortgage:timezone:wallet-123");
  });
});
