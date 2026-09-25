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

export interface WidgetState {
  order: WidgetId[];
  visibility: Record<WidgetId, boolean>;
  refreshInterval: RefreshInterval;
  setOrder: (newOrder: WidgetId[]) => void;
  toggleVisibility: (id: WidgetId) => void;
  setRefreshInterval: (interval: RefreshInterval) => void;
  resetLayout: () => void;
}

const defaultOrder: WidgetId[] = [
  'quick-metrics',
  'yield-estimator',
  'credit-recovery',
  'savings-loan',
  'milestones',
];
const defaultVisibility: Record<WidgetId, boolean> = {
  'quick-metrics': true,
  'yield-estimator': true,
  'credit-recovery': true,
  'savings-loan': true,
  'milestones': true,
};

export const useWidgetStore = create<WidgetState>()(
  persist(
    (set) => ({
      order: defaultOrder,
      visibility: defaultVisibility,
      refreshInterval: DEFAULT_REFRESH_INTERVAL,
      setOrder: (newOrder) => set({ order: newOrder }),
      toggleVisibility: (id) =>
        set((state) => ({
          visibility: {
            ...state.visibility,
            [id]: !state.visibility[id],
          },
        })),
      setRefreshInterval: (interval) =>
        set({
          refreshInterval: REFRESH_INTERVAL_OPTIONS.includes(interval)
            ? interval
            : DEFAULT_REFRESH_INTERVAL,
        }),
      resetLayout: () =>
        set({
          order: defaultOrder,
          visibility: defaultVisibility,
          refreshInterval: DEFAULT_REFRESH_INTERVAL,
        }),
    }),
    {
      name: 'dashboard-widget-layout', // unique name for localStorage key
    }
  )
);
