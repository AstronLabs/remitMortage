describe("frontend analytics tracker", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    Object.defineProperty(global, "fetch", { writable: true, value: jest.fn().mockResolvedValue({ ok: true }) });
  });

  it("sends a timestamped event without accepting a browser user identity", async () => {
    const { track } = require("../analytics");
    track("portfolio_viewed", { surface: "investor_dashboard" });
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledWith("/api/analytics/events", expect.objectContaining({
      method: "POST",
      credentials: "include",
    }));
    const request = (fetch as jest.Mock).mock.calls[0][1];
    expect(JSON.parse(request.body)).toEqual(expect.objectContaining({
      event: "portfolio_viewed",
      properties: { surface: "investor_dashboard" },
    }));
    expect(JSON.parse(request.body)).not.toHaveProperty("userId");
  });
});