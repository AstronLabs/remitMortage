// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_TEXT_SIZE, isTextSize, type TextSize } from "@/app/lib/textSize";
import {
  globalFlagsFromEventChannels,
  resolveEventChannels,
  validateEventChannels,
  type EventChannels,
} from "@/lib/notificationChannels";

type NotificationFrequency = "IMMEDIATE" | "DAILY_DIGEST" | "WEEKLY_DIGEST";

type UserSettingsPayload = {
  profile?: {
    displayName?: string;
    email?: string;
    phone?: string;
  };
  notifications?: {
    emailAlerts?: boolean;
    smsAlerts?: boolean;
    escrowApproaching?: boolean;
    escrowReached?: boolean;
    paymentMissed?: boolean;
    loanMilestones?: boolean;
    loanApproval?: boolean;
    governanceAlerts?: boolean;
    // No `securityFrequency` — security alerts are always immediate and are
    // never represented as a stored/configurable preference.
    depositsFrequency?: NotificationFrequency;
    milestonesFrequency?: NotificationFrequency;
    governanceFrequency?: NotificationFrequency;
    webhookUrl?: string;
    /** Channels per event type (issue #1116); supersedes the global emailAlerts/smsAlerts. */
    eventChannels?: Partial<EventChannels>;
  };
  contractor?: {
    businessName?: string;
    registrationNumber?: string;
    serviceRegion?: string;
  };
  textSize?: TextSize;
};

const settingsStore = new Map<string, UserSettingsPayload & { updatedAt: string }>();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_FREQUENCIES: NotificationFrequency[] = ["IMMEDIATE", "DAILY_DIGEST", "WEEKLY_DIGEST"];

function isValidFrequency(value: unknown): value is NotificationFrequency {
  return typeof value === "string" && (VALID_FREQUENCIES as string[]).includes(value);
}

function isValidWebhookUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId") || searchParams.get("address");

  if (!userId) {
    return NextResponse.json({ error: "userId or address query parameter is required." }, { status: 400 });
  }

  const existing = settingsStore.get(userId);
  if (existing) {
    // Records saved before per-event channels existed have none stored;
    // seed them from the global flags so behaviour is unchanged.
    const notifications = existing.notifications
      ? { ...existing.notifications, eventChannels: resolveEventChannels(existing.notifications) }
      : existing.notifications;
    return NextResponse.json({ success: true, settings: { ...existing, notifications } });
  }

  // Return default settings structure
  const defaultSettings = {
    profile: { displayName: "", email: "", phone: "" },
    notifications: {
      emailAlerts: true,
      smsAlerts: false,
      escrowApproaching: true,
      escrowReached: true,
      paymentMissed: true,
      loanMilestones: true,
      loanApproval: true,
      governanceAlerts: true,
      depositsFrequency: "IMMEDIATE" as NotificationFrequency,
      milestonesFrequency: "IMMEDIATE" as NotificationFrequency,
      governanceFrequency: "IMMEDIATE" as NotificationFrequency,
      webhookUrl: "",
      eventChannels: resolveEventChannels({ emailAlerts: true, smsAlerts: false }),
    },
    contractor: { businessName: "", registrationNumber: "", serviceRegion: "" },
    textSize: DEFAULT_TEXT_SIZE,
    updatedAt: new Date().toISOString(),
  };

  return NextResponse.json({ success: true, settings: defaultSettings });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as UserSettingsPayload & { userId?: string; address?: string };
    const key = body.userId || body.address || body.profile?.email || "default_user";
    const email = body.profile?.email?.trim() ?? "";
    const phone = body.profile?.phone?.trim() ?? "";
    const webhookUrl = body.notifications?.webhookUrl?.trim() ?? "";

    if (email && !EMAIL_PATTERN.test(email)) {
      return NextResponse.json({ error: "A valid linked email address is required." }, { status: 400 });
    }

    if (webhookUrl && !isValidWebhookUrl(webhookUrl)) {
      return NextResponse.json(
        { error: "Webhook URL must be a valid HTTP or HTTPS URL." },
        { status: 400 }
      );
    }

    // Security alerts are never configurable — there is no securityFrequency
    // field in UserSettingsPayload at all, so a request that includes one is
    // rejected outright rather than silently dropped.
    if ((body.notifications as Record<string, unknown> | undefined)?.securityFrequency !== undefined) {
      return NextResponse.json(
        {
          error: "security_frequency_not_configurable",
          message: "Security alerts are always delivered immediately and cannot be changed.",
        },
        { status: 400 }
      );
    }

    for (const field of ["depositsFrequency", "milestonesFrequency", "governanceFrequency"] as const) {
      const value = body.notifications?.[field];
      if (value !== undefined && !isValidFrequency(value)) {
        return NextResponse.json(
          { error: "invalid_frequency", field, message: `${field} must be one of: ${VALID_FREQUENCIES.join(", ")}` },
          { status: 400 }
        );
      }
    }

    const requestedEventChannels = body.notifications?.eventChannels;
    if (requestedEventChannels !== undefined) {
      const eventChannelsError = validateEventChannels(requestedEventChannels);
      if (eventChannelsError) {
        return NextResponse.json(
          { error: "invalid_event_channels", field: "eventChannels", message: eventChannelsError },
          { status: 400 }
        );
      }
    }

    // Event types not explicitly set fall back to the global flags, so a
    // client that only knows the old global setting keeps its behaviour.
    const eventChannels = resolveEventChannels({
      emailAlerts: body.notifications?.emailAlerts,
      smsAlerts: body.notifications?.smsAlerts,
      eventChannels: requestedEventChannels,
    });
    const globalFlags =
      requestedEventChannels !== undefined
        ? globalFlagsFromEventChannels(eventChannels)
        : {
            emailAlerts: body.notifications?.emailAlerts ?? true,
            smsAlerts: body.notifications?.smsAlerts ?? false,
          };

    if (body.textSize !== undefined && !isTextSize(body.textSize)) {
      return NextResponse.json(
        { error: "invalid_text_size", field: "textSize", message: "textSize must be one of: default, large, x-large" },
        { status: 400 }
      );
    }

    const savedSettings = {
      profile: {
        displayName: body.profile?.displayName?.trim() ?? "",
        email,
        phone,
      },
      notifications: {
        ...globalFlags,
        escrowApproaching: body.notifications?.escrowApproaching ?? true,
        escrowReached: body.notifications?.escrowReached ?? true,
        paymentMissed: body.notifications?.paymentMissed ?? true,
        loanMilestones: body.notifications?.loanMilestones ?? true,
        loanApproval: body.notifications?.loanApproval ?? true,
        governanceAlerts: body.notifications?.governanceAlerts ?? true,
        depositsFrequency: body.notifications?.depositsFrequency ?? "IMMEDIATE",
        milestonesFrequency: body.notifications?.milestonesFrequency ?? "IMMEDIATE",
        governanceFrequency: body.notifications?.governanceFrequency ?? "IMMEDIATE",
        webhookUrl,
        eventChannels,
      },
      contractor: {
        businessName: body.contractor?.businessName?.trim() ?? "",
        registrationNumber: body.contractor?.registrationNumber?.trim() ?? "",
        serviceRegion: body.contractor?.serviceRegion?.trim() ?? "",
      },
      textSize: isTextSize(body.textSize) ? body.textSize : DEFAULT_TEXT_SIZE,
      updatedAt: new Date().toISOString(),
    };

    settingsStore.set(key, savedSettings);

    return NextResponse.json({ success: true, settings: savedSettings });
  } catch (error) {
    console.error("Settings save error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}