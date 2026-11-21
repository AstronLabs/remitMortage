"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import {
  CHANNEL_EVENT_TYPES,
  CHANNEL_LABELS,
  EVENT_TYPE_LABELS,
  NOTIFICATION_CHANNELS,
  type ChannelEventType,
  type EventChannels,
  type NotificationChannel,
} from "@/lib/notificationChannels";

interface NotificationChannelMatrixProps {
  value: EventChannels;
  onToggle: (type: ChannelEventType, channel: NotificationChannel) => void;
}

/**
 * Per-event-type delivery channels (issue #1116): one row per event type,
 * one checkbox per channel, so each type can use any combination of channels.
 */
export default function NotificationChannelMatrix({ value, onToggle }: NotificationChannelMatrixProps) {
  return (
    <div className="space-y-2" role="group" aria-label="Delivery channels per event type">
      {CHANNEL_EVENT_TYPES.map((type) => {
        const label = EVENT_TYPE_LABELS[type];
        const selected = value[type];
        return (
          <fieldset
            key={type}
            className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
          >
            <legend className="sr-only">{`${label} channels`}</legend>
            <div>
              <span className="text-sm font-bold text-white">{label}</span>
              <p className="text-xs text-slate-400 mt-0.5">
                {selected.length === 0
                  ? "No channels — you won't be notified of this event."
                  : `Delivered by ${selected.map((c) => CHANNEL_LABELS[c]).join(" + ")}`}
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              {NOTIFICATION_CHANNELS.map((channel) => {
                const checked = selected.includes(channel);
                return (
                  <label
                    key={channel}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold border cursor-pointer transition-colors ${
                      checked
                        ? "border-cyan-500 bg-cyan-500/10 text-white"
                        : "border-slate-700 text-slate-400 hover:border-slate-600"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="accent-cyan-500"
                      checked={checked}
                      onChange={() => onToggle(type, channel)}
                      aria-label={`${label} via ${CHANNEL_LABELS[channel]}`}
                    />
                    {CHANNEL_LABELS[channel]}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
