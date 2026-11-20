// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import FeatureAnnouncements from "../FeatureAnnouncements";
import { FEATURE_ANNOUNCEMENTS } from "@/lib/featureAnnouncements";

// The component is driven entirely by this config, so the tests read it rather
// than hard-coding copy: adding an announcement must not break them.
const announcement = FEATURE_ANNOUNCEMENTS[0];

beforeEach(() => {
  window.localStorage.clear();
});

describe("FeatureAnnouncements", () => {
  it("shows an active announcement from the config", async () => {
    render(<FeatureAnnouncements />);

    expect(
      await screen.findByTestId(`feature-announcement-${announcement.id}`)
    ).toBeInTheDocument();
    expect(screen.getByText(announcement.title)).toBeInTheDocument();
    expect(screen.getByText(announcement.message)).toBeInTheDocument();
  });

  it("dismisses an announcement individually", async () => {
    render(<FeatureAnnouncements />);

    const card = await screen.findByTestId(`feature-announcement-${announcement.id}`);
    expect(card).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`dismiss-announcement-${announcement.id}`));

    expect(
      screen.queryByTestId(`feature-announcement-${announcement.id}`)
    ).not.toBeInTheDocument();
  });

  it("never shows a dismissed announcement again", async () => {
    const { unmount } = render(<FeatureAnnouncements />);

    await screen.findByTestId(`feature-announcement-${announcement.id}`);
    fireEvent.click(screen.getByTestId(`dismiss-announcement-${announcement.id}`));
    unmount();

    // A fresh mount (e.g. next visit) must not bring the announcement back.
    render(<FeatureAnnouncements />);
    expect(
      screen.queryByTestId(`feature-announcement-${announcement.id}`)
    ).not.toBeInTheDocument();
  });
});
