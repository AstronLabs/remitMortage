// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NotificationCoalescer } from "../services/notificationCoalescer";

interface Payload {
  channel: string;
  content: string;
}

const WINDOW_MS = 1000;

function sample(content = "failed sign-in"): Payload {
  return { channel: "EMAIL", content };
}

function setup() {
  const flushed: Array<{
    type: string;
    recipient: string;
    count: number;
    sample: Payload;
  }> = [];

  const coalescer = new NotificationCoalescer<Payload>({
    windowMs: WINDOW_MS,
    flush: (key, count, payload) =>
      flushed.push({ type: key.type, recipient: key.recipient, count, sample: payload }),
  });

  return { coalescer, flushed };
}

describe("NotificationCoalescer", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("delivers a single trigger immediately", () => {
    const { coalescer } = setup();

    const decision = coalescer.record(
      { type: "LOGIN_FAILED", recipient: "a@example.com" },
      sample()
    );

    expect(decision).toEqual({ deliver: true, count: 1 });
  });

  it("folds repeated triggers of the same type and recipient into one", () => {
    const { coalescer, flushed } = setup();
    const key = { type: "LOGIN_FAILED", recipient: "a@example.com" };

    expect(coalescer.record(key, sample()).deliver).toBe(true);
    expect(coalescer.record(key, sample())).toEqual({ deliver: false, count: 2 });
    expect(coalescer.record(key, sample())).toEqual({ deliver: false, count: 3 });

    expect(flushed).toEqual([]);
    jest.advanceTimersByTime(WINDOW_MS);

    expect(flushed).toEqual([
      {
        type: "LOGIN_FAILED",
        recipient: "a@example.com",
        count: 3,
        sample: sample(),
      },
    ]);
  });

  it("does not coalesce two different notification types for the same recipient", () => {
    const { coalescer } = setup();

    expect(
      coalescer.record({ type: "LOGIN_FAILED", recipient: "a@example.com" }, sample()).deliver
    ).toBe(true);
    expect(
      coalescer.record({ type: "PAYMENT_MISSED", recipient: "a@example.com" }, sample()).deliver
    ).toBe(true);
  });

  it("does not coalesce the same type across different recipients", () => {
    const { coalescer } = setup();

    expect(
      coalescer.record({ type: "LOGIN_FAILED", recipient: "a@example.com" }, sample()).deliver
    ).toBe(true);
    expect(
      coalescer.record({ type: "LOGIN_FAILED", recipient: "b@example.com" }, sample()).deliver
    ).toBe(true);
  });

  it("does not flush a window that only ever saw one trigger", () => {
    const { coalescer, flushed } = setup();

    coalescer.record({ type: "LOGIN_FAILED", recipient: "a@example.com" }, sample());
    jest.advanceTimersByTime(WINDOW_MS);

    expect(flushed).toEqual([]);
  });

  it("starts a fresh window once the previous one has closed", () => {
    const { coalescer, flushed } = setup();
    const key = { type: "LOGIN_FAILED", recipient: "a@example.com" };

    coalescer.record(key, sample());
    jest.advanceTimersByTime(WINDOW_MS);
    expect(coalescer.record(key, sample())).toEqual({ deliver: true, count: 1 });

    // A lone trigger in the new window is delivered and never flushed.
    jest.advanceTimersByTime(WINDOW_MS);
    expect(flushed).toEqual([]);
  });

  it("clear() cancels pending windows without flushing them", () => {
    const { coalescer, flushed } = setup();
    const key = { type: "LOGIN_FAILED", recipient: "a@example.com" };

    coalescer.record(key, sample());
    coalescer.record(key, sample());
    coalescer.clear();

    jest.advanceTimersByTime(WINDOW_MS);
    expect(flushed).toEqual([]);
  });
});
