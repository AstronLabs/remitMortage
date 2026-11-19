import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import EmptyState from "./EmptyState";

const meta = {
  title: "Shared/States/EmptyState",
  component: EmptyState,
  tags: ["autodocs"],
  args: {
    title: "No payments yet",
    message: "Payments will appear here after your first loan is funded.",
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithAction: Story = {
  args: {
    action: { label: "Explore loans", onClick: fn() },
  },
};
