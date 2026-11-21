// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type WidgetId =
  | 'quick-metrics'
  | 'yield-estimator'
  | 'credit-recovery'
  | 'savings-loan'
  | 'milestones';

export const REFRESH_INTERVAL_OPTIONS = [0, 30_000, 60_000, 300_000] as const;

/** Auto-refresh interval in milliseconds; 0 disables auto-refresh. */
export type RefreshInterval = (typeof REFRESH_INTERVAL_OPTIONS)[number];

export const DEFAULT_REFRESH_INTERVAL: RefreshInterval = 60_000;

/** Layout key used before a wallet is connected. */
export const GUEST_LAYOUT_KEY = 'guest';

/** One user's saved dashboard layout. */
export interface WidgetLayout {
  order: WidgetId[];
  visibility: Record<WidgetId, boolean>;
  refreshInterval: RefreshInterval;
}

export interface WidgetState extends WidgetLayout {
  /** Whose layout is currently shown; layouts are saved per user (issue #1111). */
  activeUser: string;
  /** Every user's saved layout on this device, keyed by wallet address. */
  layouts: Record<string, WidgetLayout>;
  setActiveUser: (userId: string | null) => void;
  setOrder: (newOrder: WidgetId[]) => void;
  moveWidget: (id: WidgetId, direction: -1 | 1) => void;
  toggleVisibility: (id: WidgetId) => void;
  setRefreshInterval: (interval: RefreshInterval) => void;
  resetLayout: () => void;
}

export const DEFAULT_WIDGET_ORDER: readonly WidgetId[] = [
  'quick-metrics',
  'yield-estimator',
  'credit-recovery',
  'savings-loan',
  'milestones',
];

/** A fresh copy of the default layout, so a reset never shares references with edited state. */
export function defaultWidgetLayout(): WidgetLayout {
  return {
    order: [...DEFAULT_WIDGET_ORDER],
    visibility: Object.fromEntries(DEFAULT_WIDGET_ORDER.map((id) => [id, true])) as Record<WidgetId, boolean>,
    refreshInterval: DEFAULT_REFRESH_INTERVAL,
  };
}

function isWidgetId(value: unknown): value is WidgetId {
  return DEFAULT_WIDGET_ORDER.includes(value as WidgetId);
}

/**
 * Repairs a stored layout: drops unknown or duplicate widgets, appends widgets
 * added since it was saved, and falls back to defaults for missing values, so
 * a stale or hand-edited save can never hide a widget from the settings list.
 */
export function normalizeWidgetLayout(saved: Partial<WidgetLayout> | undefined | null): WidgetLayout {
  const fallback = defaultWidgetLayout();
  if (!saved) return fallback;

  const order: WidgetId[] = [];
  for (const id of Array.isArray(saved.order) ? saved.order : []) {
    if (isWidgetId(id) && !order.includes(id)) order.push(id);
  }
  for (const id of fallback.order) if (!order.includes(id)) order.push(id);

  const visibility = { ...fallback.visibility };
  for (const id of fallback.order) {
    const value = saved.visibility?.[id];
    if (typeof value === 'boolean') visibility[id] = value;
  }

  const refreshInterval = REFRESH_INTERVAL_OPTIONS.includes(saved.refreshInterval as RefreshInterval)
    ? (saved.refreshInterval as RefreshInterval)
    : fallback.refreshInterval;

  return { order, visibility, refreshInterval };
}

function layoutKey(userId: string | null): string {
  return userId?.trim() || GUEST_LAYOUT_KEY;
}

export const useWidgetStore = create<WidgetState>()(
  persist(
    (set, get) => {
      /** Applies a layout change to the visible state and the active user's saved copy. */
      const commit = (patch: Partial<WidgetLayout>) => {
        const { activeUser, layouts, order, visibility, refreshInterval } = get();
        const next: WidgetLayout = { order, visibility, refreshInterval, ...patch };
        set({ ...next, layouts: { ...layouts, [activeUser]: next } });
      };

      return {
        ...defaultWidgetLayout(),
        activeUser: GUEST_LAYOUT_KEY,
        layouts: {},
        setActiveUser: (userId) => {
          const key = layoutKey(userId);
          if (key === get().activeUser) return;
          set({ activeUser: key, ...normalizeWidgetLayout(get().layouts[key]) });
        },
        setOrder: (newOrder) => commit({ order: normalizeWidgetLayout({ order: newOrder }).order }),
        moveWidget: (id, direction) => {
          const order = [...get().order];
          const from = order.indexOf(id);
          const to = from + direction;
          if (from === -1 || to < 0 || to >= order.length) return;
          [order[from], order[to]] = [order[to], order[from]];
          commit({ order });
        },
        toggleVisibility: (id) =>
          commit({ visibility: { ...get().visibility, [id]: !get().visibility[id] } }),
        setRefreshInterval: (interval) =>
          commit({
            refreshInterval: REFRESH_INTERVAL_OPTIONS.includes(interval)
              ? interval
              : DEFAULT_REFRESH_INTERVAL,
          }),
        resetLayout: () => commit(defaultWidgetLayout()),
      };
    },
    {
      name: 'dashboard-widget-layout', // unique name for localStorage key
      partialize: ({ activeUser, layouts, order, visibility, refreshInterval }) => ({
        activeUser,
        layouts,
        order,
        visibility,
        refreshInterval,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<WidgetState>;
        const activeUser = typeof saved.activeUser === 'string' ? saved.activeUser : current.activeUser;
        const layouts: Record<string, WidgetLayout> = {};
        for (const [user, layout] of Object.entries(saved.layouts ?? {})) {
          layouts[user] = normalizeWidgetLayout(layout);
        }
        // Saves from before per-user layouts only had the top-level fields.
        const active = normalizeWidgetLayout(layouts[activeUser] ?? saved);
        return { ...current, ...active, activeUser, layouts: { ...layouts, [activeUser]: active } };
      },
    }
  )
);
