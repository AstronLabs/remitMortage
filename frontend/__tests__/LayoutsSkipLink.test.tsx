// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Skip-link + landmark regression coverage for every layout (issue #485).
 * Each app-router layout must expose a visually-hidden skip link that targets
 * the `#main-content` landmark, and the landmark must be programmatically
 * focusable so activating the link moves focus into the main content.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import RootLayout from "@/app/layout";
import ShareLayout from "@/app/share/layout";
import SharePage from "@/app/share/[id]/page";

jest.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTranslations: () => (key: string) => key,
}));

jest.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getMessages: async () => ({}),
}));

jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

jest.mock("next/link", () => {
  const React = require("react");
  return {
    __esModule: true,
    default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) =>
      React.createElement("a", { href: typeof href === "string" ? href : "#", ...rest }, children),
  };
});

// Pass-through providers / no-op chrome so the layouts can render standalone.
jest.mock("@/context/WalletContext", () => ({
  WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/context/ContractRegistryContext", () => ({
  ContractRegistryProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/context/ThemeContext", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/context/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/context/NotificationContext", () => ({
  NotificationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/context/ToastContext", () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/context/IdleSessionContext", () => ({
  IdleSessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/context/KeyboardShortcutsContext", () => ({
  KeyboardShortcutsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/context/NarrationContext", () => ({
  NarrationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/context/DemoModeContext", () => ({
  DemoModeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/app/lib/theme-boot", () => ({ THEME_BOOT_SCRIPT: "" }));
jest.mock("@/components/NotificationLayer", () => ({ NotificationLayer: () => null }));
jest.mock("@/components/ToastContainer", () => ({ ToastContainer: () => null }));
jest.mock("@/components/HotToaster", () => ({ HotToaster: () => null }));
jest.mock("@/components/FeatureAnnouncements", () => ({ FeatureAnnouncements: () => null }));
jest.mock("@/components/LiveRegionAnnouncer", () => ({ LiveRegionAnnouncer: () => null }));
jest.mock("@/components/WalletBanner", () => () => null);
jest.mock("@/components/DemoModeBanner", () => () => null);
jest.mock("@/components/ImpersonationBanner", () => () => null);
jest.mock("@/components/Footer", () => ({
  __esModule: true,
  default: () => <footer role="contentinfo" aria-label="Site footer" />,
}));

/** Shared assertion: the skip link points at the focusable main landmark. */
function expectSkipLinkFocusesMain() {
  const skipLink = screen.getByRole("link", { name: /skip to main content/i });

  const target = skipLink.getAttribute("href");
  expect(target).toBe("#main-content");

  const main = document.querySelector(`${target}`);
  expect(main).not.toBeNull();
  expect(main).toHaveAttribute("role", "main");
  expect(main).toHaveAttribute("tabindex", "-1");

  (main as HTMLElement).focus();
  expect(main).toHaveFocus();
}

describe("Skip links and landmark regions — every layout (#485)", () => {
  it("root layout exposes a skip link that focuses main content", async () => {
    const ui = await RootLayout({ children: <div data-testid="page-content" /> });
    render(ui);

    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    expectSkipLinkFocusesMain();
  });

  it("root layout exposes a footer contentinfo landmark", async () => {
    const ui = await RootLayout({ children: <div /> });
    render(ui);

    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("share layout exposes a skip link that focuses main content", () => {
    render(
      <ShareLayout>
        <div data-testid="page-content" />
      </ShareLayout>
    );

    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    expectSkipLinkFocusesMain();
  });
});

describe("Share page landmark regions and heading order (#485)", () => {
  const shareData = {
    id: "sample-share-id",
    borrowerLabel: "Ada",
    deposited: "3000",
    target: "10000",
    progress: 30,
    apy: "6.2",
    milestonesCompleted: 1,
    milestonesTotal: 3,
    loanStatus: "Pending",
    milestones: [
      { id: "m1", title: "KYC", state: "Approved" },
      { id: "m2", title: "Valuation", state: "Voting" },
    ],
  };

  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => shareData,
    })) as unknown as typeof fetch;
  });

  it("exposes banner, navigation and contentinfo landmarks", async () => {
    const ui = await SharePage({ params: Promise.resolve({ id: shareData.id }) });
    render(ui);

    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /share page links/i })).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("has a logical heading order that does not skip levels", async () => {
    const ui = await SharePage({ params: Promise.resolve({ id: shareData.id }) });
    render(ui);

    const headings = screen
      .getAllByRole("heading")
      .map((el) => Number(el.tagName.replace("H", "")));

    expect(headings[0]).toBe(1);
    headings.forEach((level, index) => {
      if (index === 0) return;
      expect(level).toBeLessThanOrEqual(headings[index - 1] + 1);
    });
  });
});
