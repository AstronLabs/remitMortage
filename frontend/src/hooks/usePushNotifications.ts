"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef, useState } from "react";
import {
  defaultPushPreferences,
  deletePushSubscription,
  getExistingSubscription,
  getPermissionState,
  isPushSupported,
  loadPushPreferences,
  PushError,
  savePushPreferences,
  savePushSubscription,
  subscribeToPush,
  unsubscribeFromPush,
  type PushPreferences,
  type PushTopic,
} from "@/lib/webPush";

export interface UsePushNotificationsResult {
  /** Whether this browser can register push subscriptions at all. */
  supported: boolean;
  /** Live notification permission state. */
  permission: NotificationPermission | "unsupported";
  /** Whether this browser currently holds an active subscription. */
  subscribed: boolean;
  /** Per-topic delivery preferences. */
  preferences: PushPreferences;
  /** True while a subscribe/unsubscribe/save request is in flight. */
  busy: boolean;
  /** Last user-facing error, or null. */
  error: string | null;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
  togglePreference: (topic: PushTopic) => void;
  setAllPreferences: (enabled: boolean) => void;
  dismissError: () => void;
}

/**
 * Drives the push subscription lifecycle for the current browser.
 *
 * All transitions happen in React state, so subscribing and unsubscribing
 * update the UI in place with no page reload. Preference edits are applied
 * optimistically and pushed to the backend in the background; a failed write
 * rolls the toggle back so the panel never claims a setting that did not save.
 */
export function usePushNotifications(address: string): UsePushNotificationsResult {
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    "unsupported"
  );
  const [subscribed, setSubscribed] = useState(false);
  const [preferences, setPreferences] = useState<PushPreferences>(defaultPushPreferences);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Endpoint of the active subscription, needed for preference/delete calls. */
  const endpointRef = useRef<string | null>(null);
  /** Guards against setting state after the component unmounts. */
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Detect capability and adopt any subscription this browser already holds.
  useEffect(() => {
    const canPush = isPushSupported();
    setSupported(canPush);
    setPermission(getPermissionState());
    if (!canPush) return;

    let cancelled = false;
    (async () => {
      try {
        const existing = await getExistingSubscription();
        if (cancelled || !aliveRef.current) return;
        endpointRef.current = existing?.endpoint ?? null;
        setSubscribed(Boolean(existing));
      } catch {
        // A service worker that never becomes ready simply means no subscription.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Load stored preferences once an address is known.
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    (async () => {
      const stored = await loadPushPreferences(address);
      if (!cancelled && aliveRef.current) setPreferences(stored);
    })();
    return () => {
      cancelled = true;
    };
  }, [address]);

  const subscribe = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const subscription = await subscribeToPush(
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
      );
      await savePushSubscription({ address, subscription, preferences });

      if (!aliveRef.current) return;
      endpointRef.current = subscription.endpoint;
      setSubscribed(true);
      setPermission(getPermissionState());
    } catch (err) {
      if (!aliveRef.current) return;
      setError(
        err instanceof PushError || err instanceof Error
          ? err.message
          : "Could not enable push notifications."
      );
      setPermission(getPermissionState());
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [address, preferences]);

  const unsubscribe = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const endpoint = (await unsubscribeFromPush()) ?? endpointRef.current;
      if (endpoint && address) {
        await deletePushSubscription({ address, endpoint });
      }
      if (!aliveRef.current) return;
      endpointRef.current = null;
      setSubscribed(false);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(
        err instanceof Error ? err.message : "Could not disable push notifications."
      );
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [address]);

  /**
   * Writes preferences through to the backend, rolling back on failure.
   *
   * The backend is what filters outbound pushes, so a preference that did not
   * persist must not keep showing as applied.
   */
  const persist = useCallback(
    async (next: PushPreferences, previous: PushPreferences) => {
      const endpoint = endpointRef.current;
      if (!endpoint || !address) return;
      try {
        await savePushPreferences({ address, endpoint, preferences: next });
      } catch (err) {
        if (!aliveRef.current) return;
        setPreferences(previous);
        setError(
          err instanceof Error ? err.message : "Could not update your preferences."
        );
      }
    },
    [address]
  );

  const togglePreference = useCallback(
    (topic: PushTopic) => {
      setPreferences((previous) => {
        const next = { ...previous, [topic]: !previous[topic] };
        void persist(next, previous);
        return next;
      });
    },
    [persist]
  );

  const setAllPreferences = useCallback(
    (enabled: boolean) => {
      setPreferences((previous) => {
        const next = Object.keys(previous).reduce((acc, key) => {
          acc[key as PushTopic] = enabled;
          return acc;
        }, {} as PushPreferences);
        void persist(next, previous);
        return next;
      });
    },
    [persist]
  );

  const dismissError = useCallback(() => setError(null), []);

  return {
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
  };
}
