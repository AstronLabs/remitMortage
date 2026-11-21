import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { DashboardSkeleton } from "./Skeleton";

const meta = {
  title: "Shared/States/DashboardSkeleton",
  component: DashboardSkeleton,
  tags: ["autodocs"],
} satisfies Meta<typeof DashboardSkeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
