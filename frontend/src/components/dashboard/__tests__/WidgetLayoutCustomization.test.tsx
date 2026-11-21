// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Dashboard widget customization (issue #1111): reordering, hiding, per-user
 * persistence across a reload, and the reset-to-default control.
 */

import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { WidgetSettingsModal } from "../WidgetSettingsModal";
import { SortableWidget } from "../SortableWidget";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import {
  DEFAULT_WIDGET_ORDER,
  defaultWidgetLayout,
  GUEST_LAYOUT_KEY,
  normalizeWidgetLayout,
  useWidgetStore,
  WidgetId,
} from "../../../app/stores/useWidgetStore";

const STORAGE_KEY = "dashboard-widget-layout";
const ALICE = "G" + "A".repeat(55);
const BOB = "G" + "B".repeat(55);

function layout() {
  const { order, visibility, refreshInterval } = useWidgetStore.getState();
  return { order, visibility, refreshInterval };
}

/** Simulates a page reload: wipe in-memory state, then rehydrate from storage. */
async function reload() {
  // setState also writes to storage, so keep what was saved before the wipe.
  const saved = window.localStorage.getItem(STORAGE_KEY);
  useWidgetStore.setState({ ...defaultWidgetLayout(), activeUser: GUEST_LAYOUT_KEY, layouts: {} });
  if (saved !== null) window.localStorage.setItem(STORAGE_KEY, saved);
  await useWidgetStore.persist.rehydrate();
}

function listedOrder(): string[] {
  const list = screen.getByTestId("widget-order-list");
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent?.replace(/[↑↓]/g, "").trim() ?? "");
}

beforeEach(() => {
  window.localStorage.clear();
  useWidgetStore.setState({ ...defaultWidgetLayout(), activeUser: GUEST_LAYOUT_KEY, layouts: {} });
});

describe("reordering widgets", () => {
  it("moves a widget up and down from the settings modal", () => {
    render(<WidgetSettingsModal isOpen onClose={jest.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Move Milestone Timeline up" }));
    expect(useWidgetStore.getState().order).toEqual([
      "quick-metrics",
      "yield-estimator",
      "credit-recovery",
      "milestones",
      "savings-loan",
    ]);
    expect(listedOrder()[3]).toBe("Milestone Timeline");

    fireEvent.click(screen.getByRole("button", { name: "Move Quick Metrics down" }));
    expect(useWidgetStore.getState().order.slice(0, 2)).toEqual([
      "yield-estimator",
      "quick-metrics",
    ]);
  });

  it("disables moving past either end of the list", () => {
    render(<WidgetSettingsModal isOpen onClose={jest.fn()} />);

    expect(screen.getByRole("button", { name: "Move Quick Metrics up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Milestone Timeline down" })).toBeDisabled();
  });

  it("accepts a drag-and-drop order and ignores unknown or duplicate ids", () => {
    act(() =>
      useWidgetStore
        .getState()
        .setOrder(["milestones", "milestones", "bogus" as WidgetId, "quick-metrics"])
    );

    // Widgets missing from the dropped order are kept, never lost.
    expect(useWidgetStore.getState().order).toEqual([
      "milestones",
      "quick-metrics",
      "yield-estimator",
      "credit-recovery",
      "savings-loan",
    ]);
  });
});

describe("hiding widgets", () => {
  it("hides and re-shows a widget from the settings modal", () => {
    render(<WidgetSettingsModal isOpen onClose={jest.fn()} />);
    const checkbox = screen.getByRole("checkbox", { name: "Credit Score Recovery" });

    fireEvent.click(checkbox);
    expect(useWidgetStore.getState().visibility["credit-recovery"]).toBe(false);
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);
    expect(useWidgetStore.getState().visibility["credit-recovery"]).toBe(true);
  });

  it("hides a widget from its own hide control on the dashboard", () => {
    const toggle = () => useWidgetStore.getState().toggleVisibility("yield-estimator");
    render(
      <DndContext>
        <SortableContext items={["yield-estimator"]}>
          <SortableWidget id="yield-estimator" label="Yield & APY Estimator" onHide={toggle}>
            <p>widget body</p>
          </SortableWidget>
        </SortableContext>
      </DndContext>
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide Yield & APY Estimator" }));

    expect(useWidgetStore.getState().visibility["yield-estimator"]).toBe(false);
  });
});

describe("persistence", () => {
  it("restores the chosen order and visibility after a reload", async () => {
    const store = useWidgetStore.getState();
    act(() => {
      store.setActiveUser(ALICE);
      useWidgetStore.getState().moveWidget("savings-loan", -1);
      useWidgetStore.getState().toggleVisibility("milestones");
    });
    const chosen = layout();

    await reload();

    expect(useWidgetStore.getState().activeUser).toBe(ALICE);
    expect(layout()).toEqual(chosen);
    expect(layout().visibility.milestones).toBe(false);
  });

  it("keeps a separate layout per user", async () => {
    act(() => {
      useWidgetStore.getState().setActiveUser(ALICE);
      useWidgetStore.getState().toggleVisibility("quick-metrics");
      useWidgetStore.getState().setActiveUser(BOB);
    });

    // Bob starts from the default layout, untouched by Alice's choice.
    expect(layout()).toEqual(defaultWidgetLayout());
    act(() => useWidgetStore.getState().moveWidget("milestones", -1));
    const bobs = layout();

    await reload();
    expect(layout()).toEqual(bobs);

    act(() => useWidgetStore.getState().setActiveUser(ALICE));
    expect(layout().visibility["quick-metrics"]).toBe(false);
    expect(layout().order).toEqual([...DEFAULT_WIDGET_ORDER]);
  });

  it("restores a layout saved before per-user layouts existed", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          order: ["milestones", "quick-metrics"],
          visibility: { milestones: false },
          refreshInterval: 30_000,
        },
        version: 0,
      })
    );

    await useWidgetStore.persist.rehydrate();

    expect(layout()).toEqual({
      order: ["milestones", "quick-metrics", "yield-estimator", "credit-recovery", "savings-loan"],
      visibility: { ...defaultWidgetLayout().visibility, milestones: false },
      refreshInterval: 30_000,
    });
  });

  it("repairs a corrupted saved layout instead of losing widgets", () => {
    expect(
      normalizeWidgetLayout({
        order: "nope" as unknown as WidgetId[],
        visibility: { "quick-metrics": "yes" } as unknown as Record<WidgetId, boolean>,
        refreshInterval: 7 as never,
      })
    ).toEqual(defaultWidgetLayout());
  });
});

describe("reset to default", () => {
  it("restores the default layout exactly and persists it", async () => {
    render(<WidgetSettingsModal isOpen onClose={jest.fn()} />);
    act(() => useWidgetStore.getState().setActiveUser(ALICE));
    fireEvent.click(screen.getByRole("button", { name: "Move Milestone Timeline up" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Quick Metrics" }));
    fireEvent.click(screen.getByRole("radio", { name: "5m" }));
    expect(layout()).not.toEqual(defaultWidgetLayout());

    fireEvent.click(screen.getByText("Reset to Default"));

    expect(layout()).toEqual(defaultWidgetLayout());
    await reload();
    expect(layout()).toEqual(defaultWidgetLayout());
  });

  it("does not share state with the defaults, so later edits cannot corrupt a reset", () => {
    act(() => {
      useWidgetStore.getState().resetLayout();
      useWidgetStore.getState().moveWidget("milestones", -1);
      useWidgetStore.getState().resetLayout();
    });

    expect(layout().order).toEqual([...DEFAULT_WIDGET_ORDER]);
  });
});
