import { render, screen, within } from "@testing-library/react";
import type { FieldErrors } from "react-hook-form";
import ErrorSummary from "../src/components/forms/ErrorSummary";

type FormValues = {
  email: string;
  age: number;
};

const labels = {
  email: "Email address",
  age: "Age",
};

const errors = (values: FieldErrors<FormValues>) => values;

describe("ErrorSummary", () => {
  it("lists exactly the fields with current validation errors", () => {
    render(
      <ErrorSummary
        errors={errors({
          email: { type: "required", message: "Enter an email address" },
          age: { type: "min", message: "Must be at least 18" },
        })}
        labels={labels}
        announcementKey={0}
        onFieldSelect={jest.fn()}
      />
    );

    const summary = screen.getByRole("region", { name: "Please correct the following errors" });
    const links = within(summary).getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent("Email address: Enter an email address");
    expect(links[1]).toHaveTextContent("Age: Must be at least 18");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status")).toHaveAttribute("aria-atomic", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Found 2 errors.");
  });

  it("removes fixed errors and only repeats the announcement on an explicit failed attempt", () => {
    const onFieldSelect = jest.fn();
    const { rerender } = render(
      <ErrorSummary
        errors={errors({
          email: { type: "required", message: "Enter an email address" },
          age: { type: "min", message: "Must be at least 18" },
        })}
        labels={labels}
        announcementKey={0}
        onFieldSelect={onFieldSelect}
      />
    );

    const initialAnnouncement = screen.getByRole("status").textContent;
    rerender(
      <ErrorSummary
        errors={errors({ age: { type: "min", message: "Must be at least 18" } })}
        labels={labels}
        announcementKey={0}
        onFieldSelect={onFieldSelect}
      />
    );

    const summary = screen.getByRole("region", { name: "Please correct the following errors" });
    expect(within(summary).getAllByRole("link")).toHaveLength(1);
    expect(within(summary).getByRole("link")).toHaveTextContent("Age: Must be at least 18");
    expect(screen.getByRole("status")).toHaveTextContent(initialAnnouncement ?? "");

    rerender(
      <ErrorSummary
        errors={errors({ age: { type: "min", message: "Must be at least 18" } })}
        labels={labels}
        announcementKey={1}
        onFieldSelect={onFieldSelect}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Found 1 error. Age: Must be at least 18");
  });

  it("links each summary item to its field and invokes the field selection handler", () => {
    const onFieldSelect = jest.fn();
    render(
      <ErrorSummary
        errors={errors({ email: { type: "required", message: "Enter an email address" } })}
        labels={labels}
        announcementKey={0}
        onFieldSelect={onFieldSelect}
      />
    );

    const link = screen.getByRole("link", { name: "Email address: Enter an email address" });
    expect(link).toHaveAttribute("href", "#email");
    link.click();
    expect(onFieldSelect).toHaveBeenCalledWith("email");
  });

  it("renders no summary when there are no errors", () => {
    render(
      <ErrorSummary
        errors={errors({})}
        labels={labels}
        announcementKey={0}
        onFieldSelect={jest.fn()}
      />
    );

    expect(
      screen.queryByRole("region", { name: "Please correct the following errors" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});
