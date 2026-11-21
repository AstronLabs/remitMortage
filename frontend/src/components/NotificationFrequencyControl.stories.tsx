import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import NotificationFrequencyControl from "./NotificationFrequencyControl";

const meta = {
  title: "Shared/Notifications/FrequencyControl",
  component: NotificationFrequencyControl,
  tags: ["autodocs"],
  args: {
    label: "Payment reminders",
    description: "Choose how often you receive reminders about upcoming payments.",
    value: "DAILY_DIGEST",
    onChange: fn(),
  },
} satisfies Meta<typeof NotificationFrequencyControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SecurityAlertsLocked: Story = {
  args: {
    label: "Security alerts",
    description: "Important changes to your account and wallet.",
    locked: true,
    lockedReason: "Security alerts are always delivered immediately.",
  },
};
