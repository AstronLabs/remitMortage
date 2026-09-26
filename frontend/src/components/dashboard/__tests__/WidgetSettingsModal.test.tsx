// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { WidgetSettingsModal } from "../WidgetSettingsModal";
import { DEFAULT_REFRESH_INTERVAL, RefreshInterval, useWidgetStore } from "../../../app/stores/useWidgetStore";

const STORAGE_KEY = "dashboard-widget-layout";

function persisted() {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}").state;
}

describe("WidgetSettingsModal auto-refresh setting", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWidgetStore.getState().resetLayout();
  });

  it("defaults to a 1 minute refresh interval", () => {
    render(<WidgetSettingsModal isOpen onClose={jest.fn()} />);
    expect(DEFAULT_REFRESH_INTERVAL).toBe(60_000);
    expect(screen.getByRole("radio", { name: "1m" })).toHaveAttribute("aria-checked", "true");
  });

  it("updates the interval and persists it alongside the widget layout", () => {
    render(<WidgetSettingsModal isOpen onClose={jest.fn()} />);

    fireEvent.click(screen.getByRole("radio", { name: "30s" }));
    expect(useWidgetStore.getState().refreshInterval).toBe(30_000);
    expect(screen.getByRole("radio", { name: "30s" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "1m" })).toHaveAttribute("aria-checked", "false");

    fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    const state = persisted();
    expect(state.refreshInterval).toBe(0);
    expect(state.order).toBeDefined();
    expect(state.visibility).toBeDefined();
  });

  it("restores a persisted interval on rehydration", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { refreshInterval: 300_000 }, version: 0 })
    );
    await useWidgetStore.persist.rehydrate();
    expect(useWidgetStore.getState().refreshInterval).toBe(300_000);
  });

  it("falls back to the default for unsupported intervals", () => {
    useWidgetStore.getState().setRefreshInterval(1234 as RefreshInterval);
    expect(useWidgetStore.getState().refreshInterval).toBe(DEFAULT_REFRESH_INTERVAL);
  });

  it("resets the interval with the rest of the layout", () => {
    render(<WidgetSettingsModal isOpen onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "5m" }));
    fireEvent.click(screen.getByText("Reset to Default"));
    expect(useWidgetStore.getState().refreshInterval).toBe(DEFAULT_REFRESH_INTERVAL);
  });
});
