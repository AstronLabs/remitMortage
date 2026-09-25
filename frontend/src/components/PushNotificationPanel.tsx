"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useMemo } from "react";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import {
  PUSH_TOPICS,
  PUSH_TOPIC_DETAILS,
  type PushTopic,
  type PushTopicDetail,
} from "@/lib/webPush";

const GROUP_LABELS: Record<PushTopicDetail["group"], string> = {
  milestones: "Construction milestones",
  payments: "Repayments",
  loan: "Loan & savings",
};

const GROUP_ORDER: PushTopicDetail["group"][] = ["milestones", "payments", "loan"];

export interface PushNotificationPanelProps {
  /** Wallet address or user id the subscription is stored against. */
  address: string;
}

/**
 * Browser push opt-in and per-event delivery preferences.
 *
 * Subscribing and unsubscribing both resolve in place — the panel swaps state
 * without navigating, so the user stays on the settings tab they were on.
 * Individual topic toggles are only meaningful once subscribed, so they are
 * disabled (rather than hidden) until then, keeping the list of what you can
 * receive visible while you decide.
 */
export default function PushNotificationPanel({ address }: PushNotificationPanelProps) {
  const {
    supported,
    permission,
    subscribed,
    preferences,
    busy,
    error,
    subscribe,
    unsubscribe,
    togglePreference,
    setAllPreferences,
    dismissError,
  } = usePushNotifications(address);

  const grouped = useMemo(() => {
    return GROUP_ORDER.map((group) => ({
      group,
      topics: PUSH_TOPICS.filter((topic) => PUSH_TOPIC_DETAILS[topic].group === group),
    })).filter((section) => section.topics.length > 0);
  }, []);

  const enabledCount = useMemo(
    () => PUSH_TOPICS.filter((topic) => preferences[topic]).length,
    [preferences]
  );

  if (!supported) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-5">
        <h3 className="text-sm font-bold text-white">Browser push notifications</h3>
        <p className="mt-1 text-sm text-slate-400">
          This browser does not support web push. Email and SMS alerts above will
          still be delivered.
        </p>
      </div>
    );
  }

  const blocked = permission === "denied";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-slate-800 bg-slate-950/40 p-5">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-white">Browser push notifications</h3>
          <p className="mt-1 text-sm text-slate-400">
            {subscribed
              ? `Enabled on this device — ${enabledCount} of ${PUSH_TOPICS.length} event types active.`
              : "Get milestone approvals and payment events pushed to this device in real time."}
          </p>
          {blocked && !subscribed && (
            <p className="mt-2 text-xs text-amber-400">
              Notifications are blocked for this site. Re-enable them in your
              browser settings, then try again.
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={subscribed ? unsubscribe : subscribe}
          disabled={busy || (blocked && !subscribed)}
          aria-busy={busy}
          className={`shrink-0 rounded-lg px-4 py-2 text-sm font-bold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
            subscribed
              ? "border border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600"
              : "bg-cyan-500 text-slate-950 hover:bg-cyan-400"
          }`}
        >
          {busy
            ? "Working…"
            : subscribed
              ? "Disable push"
              : "Enable push"}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={dismissError}
            aria-label="Dismiss error"
            className="shrink-0 text-red-300/70 hover:text-red-200"
          >
            ✕
          </button>
        </div>
      )}

      <fieldset
        disabled={!subscribed || busy}
        className="space-y-5 transition-opacity disabled:opacity-50"
      >
        <legend className="sr-only">Push notification event types</legend>

        <div className="flex items-center justify-between">
          <p className="text-xs font-bold uppercase tracking-wider text-cyan-400">
            Event types
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setAllPreferences(true)}
              className="text-xs text-slate-400 underline hover:text-slate-200"
            >
              Enable all
            </button>
            <span className="text-xs text-slate-700">|</span>
            <button
              type="button"
              onClick={() => setAllPreferences(false)}
              className="text-xs text-slate-400 underline hover:text-slate-200"
            >
              Mute all
            </button>
          </div>
        </div>

        {grouped.map(({ group, topics }) => (
          <div key={group} className="space-y-2">
            <h4 className="text-xs font-semibold text-slate-500">
              {GROUP_LABELS[group]}
            </h4>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {topics.map((topic: PushTopic) => {
                const detail = PUSH_TOPIC_DETAILS[topic];
                const enabled = preferences[topic];
                return (
                  <button
                    key={topic}
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    onClick={() => togglePreference(topic)}
                    className={`rounded-xl border p-4 text-left transition-all ${
                      enabled
                        ? "border-cyan-500 bg-cyan-500/10 text-white"
                        : "border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-bold text-white">
                        {detail.label}
                      </span>
                      <span
                        aria-hidden="true"
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          enabled
                            ? "bg-cyan-500 text-slate-950"
                            : "bg-slate-800 text-slate-400"
                        }`}
                      >
                        {enabled ? "ON" : "OFF"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-400">{detail.description}</p>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </fieldset>
    </div>
  );
}
