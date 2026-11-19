import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import DateRangePicker from "./DateRangePicker";

const meta = {
  title: "Shared/Filters/DateRangePicker",
  component: DateRangePicker,
  tags: ["autodocs"],
  args: {
    value: { start: "2026-10-01", end: "2026-10-24" },
    onChange: fn(),
  },
} satisfies Meta<typeof DateRangePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const InvalidRange: Story = {
  args: { value: { start: "2026-10-24", end: "2026-10-01" } },
};
