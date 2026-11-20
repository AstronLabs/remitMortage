import { render, screen, within } from "@testing-library/react";
import { usePathname } from "next/navigation";
import DashboardBreadcrumbs from "../DashboardBreadcrumbs";

jest.mock("next/navigation", () => ({ usePathname: jest.fn() }));
const pathname = jest.mocked(usePathname);

it("links the dashboard and contractor section and marks the current page", () => {
  pathname.mockReturnValue("/contractor/payout-history");
  render(<DashboardBreadcrumbs />);
  const trail = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
  expect(trail.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/dashboard");
  const contractor = trail.getByRole("link", { name: "Contractor" });
  expect(contractor).toHaveAttribute("href", "/contractor");
  expect(contractor.closest("li")).toHaveClass("hidden", "sm:flex");
  expect(trail.getByText("Payout history")).toHaveAttribute("aria-current", "page");
});

it("uses a readable label for a dynamic transaction route", () => {
  const hash = "ab".repeat(32);
  pathname.mockReturnValue(`/explorer/tx/${hash}`);
  render(<DashboardBreadcrumbs />);
  expect(screen.getByText("Transaction details")).toHaveAttribute("aria-current", "page");
  expect(screen.queryByText(hash)).not.toBeInTheDocument();
});
