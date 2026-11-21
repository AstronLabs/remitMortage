import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { FieldErrors } from "react-hook-form";
import ErrorSummary from "./ErrorSummary";

type ApplicationFields = {
  email: string;
  amount: string;
};

const meta = {
  title: "Shared/Forms/ErrorSummary",
  component: ErrorSummary<ApplicationFields>,
  tags: ["autodocs"],
  args: {
    announcementKey: 1,
    labels: { email: "Email address", amount: "Loan amount" },
    onFieldSelect: fn(),
  },
} satisfies Meta<typeof ErrorSummary<ApplicationFields>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoErrors: Story = {
  args: { errors: {} },
};

export const ValidationErrors: Story = {
  args: {
    errors: {
      email: { type: "required", message: "Enter a valid email address." },
      amount: { type: "min", message: "Amount must be at least $500." },
    } satisfies FieldErrors<ApplicationFields>,
  },
};
