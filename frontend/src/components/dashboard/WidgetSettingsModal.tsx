// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from 'react';
import {
  REFRESH_INTERVAL_OPTIONS,
  RefreshInterval,
  useWidgetStore,
  WidgetId,
} from '../../app/stores/useWidgetStore';

interface WidgetSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const WIDGET_LABELS: Record<WidgetId, string> = {
  'quick-metrics': 'Quick Metrics',
  'yield-estimator': 'Yield & APY Estimator',
  'credit-recovery': 'Credit Score Recovery',
  'savings-loan': 'Savings & Loan Status',
  'milestones': 'Milestone Timeline',
};

const REFRESH_INTERVAL_LABELS: Record<RefreshInterval, string> = {
  0: 'Off',
  30_000: '30s',
  60_000: '1m',
  300_000: '5m',
};

export function WidgetSettingsModal({ isOpen, onClose }: WidgetSettingsModalProps) {
  const {
    order,
    visibility,
    toggleVisibility,
    moveWidget,
    refreshInterval,
    setRefreshInterval,
    resetLayout,
  } = useWidgetStore();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-white">Dashboard Layout</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-4 mb-8">
          <h3 id="widget-order-label" className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
            Widgets &amp; Order
          </h3>
          <ol aria-labelledby="widget-order-label" className="space-y-2" data-testid="widget-order-list">
            {order.map((id, index) => (
              <li key={id} className="flex items-center gap-3 p-3 bg-slate-800/50 rounded-lg hover:bg-slate-800 transition-colors">
                <label className="flex flex-1 items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={visibility[id]}
                    onChange={() => toggleVisibility(id)}
                    className="w-5 h-5 rounded border-slate-600 bg-slate-900 text-cyan-500 focus:ring-cyan-500/50 focus:ring-offset-slate-900"
                  />
                  <span className={visibility[id] ? 'text-slate-200' : 'text-slate-500 line-through'}>
                    {WIDGET_LABELS[id]}
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => moveWidget(id, -1)}
                  disabled={index === 0}
                  aria-label={`Move ${WIDGET_LABELS[id]} up`}
                  className="px-2 py-1 rounded text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveWidget(id, 1)}
                  disabled={index === order.length - 1}
                  aria-label={`Move ${WIDGET_LABELS[id]} down`}
                  className="px-2 py-1 rounded text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  ↓
                </button>
              </li>
            ))}
          </ol>
          <p className="text-xs text-slate-500">
            Drag widgets on the dashboard or use the arrows. Your layout is saved to this wallet.
          </p>
        </div>

        <div className="space-y-4 mb-8">
          <h3 id="auto-refresh-label" className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
            Auto-Refresh
          </h3>
          <div role="radiogroup" aria-labelledby="auto-refresh-label" className="grid grid-cols-4 gap-2">
            {REFRESH_INTERVAL_OPTIONS.map((interval) => (
              <button
                key={interval}
                type="button"
                role="radio"
                aria-checked={refreshInterval === interval}
                onClick={() => setRefreshInterval(interval)}
                className={`py-2 rounded-lg text-sm font-medium transition-colors ${
                  refreshInterval === interval
                    ? 'bg-cyan-500 text-slate-900'
                    : 'bg-slate-800/50 text-slate-200 hover:bg-slate-800'
                }`}
              >
                {REFRESH_INTERVAL_LABELS[interval]}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500">Dashboard data refreshes automatically while this tab is open.</p>
        </div>

        <div className="flex items-center justify-between border-t border-slate-800 pt-6">
          <button
            onClick={() => {
              resetLayout();
              onClose();
            }}
            className="text-sm font-medium text-slate-400 hover:text-white transition-colors"
          >
            Reset to Default
          </button>
          <button
            onClick={onClose}
            className="px-6 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-900 font-bold rounded-full transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
