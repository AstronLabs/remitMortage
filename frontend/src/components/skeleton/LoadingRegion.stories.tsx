import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { LoadingRegion, SkeletonCard } from "./Skeleton";
import { EmptyState } from "../EmptyState";

const meta = {
  title: "Shared/States/LoadingRegion",
  component: LoadingRegion,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    label: "Loading loan summary",
    minHeight: 180,
    skeleton: <SkeletonCard />,
  },
} satisfies Meta<typeof LoadingRegion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  args: { loading: true },
};

export const Loaded: Story = {
  args: {
    loading: false,
    children: (
      <section aria-label="Loan summary" className="rounded-xl border border-slate-700 p-5">
        <h2 className="text-lg font-semibold">Loan summary</h2>
        <p className="mt-2 text-sm text-slate-300">3 active loans · $24,000 outstanding</p>
      </section>
    ),
  },
};

export const Error: Story = {
  args: {
    loading: false,
    reserve: false,
    children: <p role="alert">Loan details could not be loaded. Try again.</p>,
  },
};

export const Empty: Story = {
  args: {
    loading: false,
    children: <EmptyState title="No active loans" message="Your active loans will appear here." />,
  },
};
