import {
  CHANNEL_EVENT_TYPES,
  channelsFromGlobalFlags,
  globalFlagsFromEventChannels,
  resolveEventChannels,
  toggleEventChannel,
  validateEventChannels,
} from "../notificationChannels";

describe("default-preserving migration from the global channel setting", () => {
  it.each([
    [{ emailAlerts: true, smsAlerts: false }, ["email"]],
    [{ emailAlerts: true, smsAlerts: true }, ["email", "sms"]],
    [{ emailAlerts: false, smsAlerts: true }, ["sms"]],
    [{ emailAlerts: false, smsAlerts: false }, []],
  ])("seeds every event type from %j", (globals, expected) => {
    const resolved = resolveEventChannels(globals);
    for (const type of CHANNEL_EVENT_TYPES) {
      expect(resolved[type]).toEqual(expected);
    }
  });

  it("uses the legacy defaults (email on, SMS off) when nothing is stored", () => {
    expect(channelsFromGlobalFlags()).toEqual(["email"]);
    expect(resolveEventChannels().paymentMissed).toEqual(["email"]);
  });

  it("round-trips an unmigrated user's global flags unchanged", () => {
    for (const globals of [
      { emailAlerts: true, smsAlerts: false },
      { emailAlerts: true, smsAlerts: true },
      { emailAlerts: false, smsAlerts: true },
    ]) {
      expect(globalFlagsFromEventChannels(resolveEventChannels(globals))).toEqual(globals);
    }
  });
});

describe("per-event-type overrides", () => {
  it("keeps explicit per-type choices and seeds only the missing types from the globals", () => {
    const resolved = resolveEventChannels({
      emailAlerts: true,
      smsAlerts: false,
      eventChannels: { paymentMissed: ["sms"], governanceAlerts: [] },
    });
    expect(resolved.paymentMissed).toEqual(["sms"]);
    expect(resolved.governanceAlerts).toEqual([]);
    expect(resolved.escrowReached).toEqual(["email"]);
    expect(resolved.loanApproval).toEqual(["email"]);
  });

  it("toggling one type's channel leaves every other type untouched", () => {
    const before = resolveEventChannels({ emailAlerts: true });
    const after = toggleEventChannel(before, "paymentMissed", "sms");
    expect(after.paymentMissed).toEqual(["email", "sms"]);
    for (const type of CHANNEL_EVENT_TYPES.filter((t) => t !== "paymentMissed")) {
      expect(after[type]).toEqual(before[type]);
    }
    expect(toggleEventChannel(after, "paymentMissed", "email").paymentMissed).toEqual(["sms"]);
  });

  it("derives the legacy global flags from whichever channels any type uses", () => {
    const channels = toggleEventChannel(resolveEventChannels({ emailAlerts: true }), "paymentMissed", "sms");
    expect(globalFlagsFromEventChannels(channels)).toEqual({ emailAlerts: true, smsAlerts: true });
  });
});

describe("multi-channel selection for one event type", () => {
  it("allows more than one channel and keeps them in canonical, de-duplicated order", () => {
    const resolved = resolveEventChannels({ eventChannels: { paymentMissed: ["sms", "email", "sms"] } });
    expect(resolved.paymentMissed).toEqual(["email", "sms"]);
  });
});

describe("validateEventChannels", () => {
  it("accepts a partial map of known types to known channels", () => {
    expect(validateEventChannels({ paymentMissed: ["email", "sms"], loanApproval: [] })).toBeNull();
  });

  it.each([
    ["a non-object", "email"],
    ["an array", [["email"]]],
    ["an unknown event type", { marketing: ["email"] }],
    ["an unknown channel", { paymentMissed: ["carrier-pigeon"] }],
    ["a non-array channel list", { paymentMissed: "email" }],
  ])("rejects %s", (_label, value) => {
    expect(validateEventChannels(value)).toEqual(expect.any(String));
  });
});
