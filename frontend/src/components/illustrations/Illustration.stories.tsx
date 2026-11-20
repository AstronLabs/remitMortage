// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Illustration, ILLUSTRATION_NAMES } from "./Illustration";

const meta = {
  title: "Shared/Illustrations/Illustration",
  component: Illustration,
  tags: ["autodocs"],
  args: {
    name: "empty-states",
  },
} satisfies Meta<typeof Illustration>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Both variants side by side, so reviewers can spot light-background artifacts. */
function BothThemes({ name }: { name: (typeof ILLUSTRATION_NAMES)[number] }) {
  return (
    <div className="flex flex-wrap items-start gap-8">
      <div className="rounded-xl bg-white p-6 text-slate-900">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Light</p>
        <div className="w-56">
          <Illustration name={name} theme="light" />
        </div>
      </div>
      <div className="rounded-xl bg-[#0f172a] p-6">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Dark</p>
        <div className="w-56">
          <Illustration name={name} theme="dark" />
        </div>
      </div>
    </div>
  );
}

export const AllVariants: Story = {
  render: () => (
    <div className="space-y-10">
      {ILLUSTRATION_NAMES.map((name) => (
        <section key={name}>
          <h3 className="mb-4 text-sm font-semibold text-[var(--color-text)]">{name}</h3>
          <BothThemes name={name} />
        </section>
      ))}
    </div>
  ),
};

export const EmptyStates: Story = { render: () => <BothThemes name="empty-states" /> };
export const OnboardingWelcome: Story = { render: () => <BothThemes name="onboarding-welcome" /> };
export const OnboardingConnectWallet: Story = {
  render: () => <BothThemes name="onboarding-connect-wallet" />,
};
export const OnboardingDocuments: Story = {
  render: () => <BothThemes name="onboarding-documents" />,
};
