// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TextInputField from "../TextInputField";
import SelectField from "../SelectField";
import CurrencyAmountInput from "../CurrencyAmountInput";
import FileUploadField from "../FileUploadField";
import * as TextInputStories from "../TextInputField.stories";
import * as SelectStories from "../SelectField.stories";
import * as AmountStories from "../CurrencyAmountInput.stories";
import * as FileUploadStories from "../FileUploadField.stories";

describe("Storybook Form Components Interaction Tests (#1001)", () => {
  describe("Story exports verification", () => {
    it("exports Default, WithErrorState, and Disabled stories for all four form components", () => {
      for (const mod of [
        TextInputStories,
        SelectStories,
        AmountStories,
        FileUploadStories,
      ]) {
        expect(mod.default).toBeDefined();
        expect(mod.Default).toBeDefined();
        expect(mod.WithErrorState).toBeDefined();
        expect(mod.Disabled).toBeDefined();
      }
    });
  });

  describe("TextInputField interactions", () => {
    it("supports typing, keyboard Tab focus, and validation error announcements", async () => {
      const user = userEvent.setup();
      function Harness() {
        const [val, setVal] = useState("");
        const [err, setErr] = useState<string | null>(null);
        return (
          <TextInputField
            id="full-name"
            label="Full legal name"
            value={val}
            required
            error={err}
            onChange={(next) => {
              setVal(next);
              setErr(next.trim() ? null : "Full legal name is required.");
            }}
            onBlur={() => {
              if (!val.trim()) setErr("Full legal name is required.");
            }}
          />
        );
      }

      render(<Harness />);
      const input = screen.getByLabelText(/Full legal name/i);

      await user.tab();
      expect(input).toHaveFocus();

      // Blur while empty -> triggers validation error message
      await user.tab();
      expect(screen.getByRole("alert")).toHaveTextContent("Full legal name is required.");
      expect(input).toHaveAttribute("aria-invalid", "true");

      // Typing valid input clears the validation error
      await user.click(input);
      await user.type(input, "Ada Lovelace");
      expect(input).toHaveValue("Ada Lovelace");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("blocks typing and focus when disabled", async () => {
      const user = userEvent.setup();
      const onChange = jest.fn();
      render(
        <TextInputField
          id="disabled-name"
          label="Full legal name"
          value="Locked"
          disabled
          onChange={onChange}
        />,
      );

      const input = screen.getByLabelText(/Full legal name/i);
      expect(input).toBeDisabled();
      await user.type(input, "Edit");
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe("SelectField interactions", () => {
    const options = [
      { value: "construction", label: "Home construction" },
      { value: "renovation", label: "Home renovation" },
      { value: "refinance", label: "Mortgage refinance" },
    ];

    it("supports keyboard focus, option selection, and error state display", async () => {
      const user = userEvent.setup();
      function Harness() {
        const [val, setVal] = useState("");
        const [err, setErr] = useState<string | null>("Please select a loan purpose.");
        return (
          <SelectField
            id="loan-purpose"
            label="Loan purpose"
            value={val}
            placeholder="Select a purpose..."
            options={options}
            error={err}
            required
            onChange={(next) => {
              setVal(next);
              setErr(next ? null : "Please select a loan purpose.");
            }}
          />
        );
      }

      render(<Harness />);
      const select = screen.getByLabelText(/Loan purpose/i);
      expect(screen.getByRole("alert")).toHaveTextContent("Please select a loan purpose.");
      expect(select).toHaveAttribute("aria-invalid", "true");

      await user.tab();
      expect(select).toHaveFocus();

      await user.selectOptions(select, "renovation");
      expect(select).toHaveValue("renovation");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("prevents selection changes when disabled", async () => {
      const user = userEvent.setup();
      const onChange = jest.fn();
      render(
        <SelectField
          id="disabled-purpose"
          label="Loan purpose"
          value="construction"
          options={options}
          disabled
          onChange={onChange}
        />,
      );

      const select = screen.getByLabelText(/Loan purpose/i);
      expect(select).toBeDisabled();
      await user.selectOptions(select, "renovation");
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe("CurrencyAmountInput interactions", () => {
    it("parses typed amounts, formats on blur, and shows validation alerts for invalid or out-of-range input", async () => {
      const user = userEvent.setup();
      const onChange = jest.fn();

      render(
        <div>
          <label htmlFor="loan-amount">Loan amount</label>
          <CurrencyAmountInput
            id="loan-amount"
            value={null}
            locale="en"
            currencyLabel="USDC"
            min={500}
            max={100_000}
            showInvalidError
            onChange={onChange}
          />
        </div>,
      );

      const input = screen.getByLabelText(/Loan amount/i);
      await user.click(input);
      await user.type(input, "abc");
      await user.tab();

      expect(screen.getByRole("alert")).toHaveTextContent(/Enter a valid number/i);
      expect(input).toHaveAttribute("aria-invalid", "true");

      // Out-of-range value below min (500)
      await user.clear(input);
      await user.type(input, "100");
      await user.tab();
      expect(screen.getByRole("alert")).toHaveTextContent(/within the allowed range/i);

      // Valid amount in range formats cleanly on blur and clears error
      await user.clear(input);
      await user.type(input, "12500.5");
      await user.tab();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(onChange).toHaveBeenLastCalledWith(12500.5, "12500.5");
    });

    it("rejects typing when disabled", async () => {
      const user = userEvent.setup();
      const onChange = jest.fn();
      render(
        <div>
          <label htmlFor="disabled-amount">Loan amount</label>
          <CurrencyAmountInput
            id="disabled-amount"
            value={5000}
            locale="en"
            disabled
            onChange={onChange}
          />
        </div>,
      );

      const input = screen.getByLabelText(/Loan amount/i);
      expect(input).toBeDisabled();
      await user.type(input, "999");
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe("FileUploadField interactions", () => {
    it("validates file MIME type and size, supports keyboard trigger activation, and announces errors", async () => {
      const user = userEvent.setup();
      const onFileSelect = jest.fn();

      render(
        <FileUploadField
          id="income-doc"
          label="Proof of income"
          accept="application/pdf"
          maxSizeBytes={1024}
          onFileSelect={onFileSelect}
        />,
      );

      const triggerBtn = screen.getByRole("button", { name: /choose file/i });
      await user.tab();
      expect(triggerBtn).toHaveFocus();

      const fileInput = screen.getByLabelText(/Proof of income/i);

      // 1. Wrong MIME type -> validation alert
      const badTypeFile = new File(["hello"], "notes.txt", { type: "text/plain" });
      fireEvent.change(fileInput, { target: { files: [badTypeFile] } });
      expect(screen.getByRole("alert")).toHaveTextContent(/Unsupported file type/i);
      expect(onFileSelect).toHaveBeenLastCalledWith(null);

      // 2. Oversized file -> validation alert
      const bigFile = new File(["x".repeat(2048)], "large.pdf", { type: "application/pdf" });
      fireEvent.change(fileInput, { target: { files: [bigFile] } });
      expect(screen.getByRole("alert")).toHaveTextContent(/exceeds the maximum size/i);

      // 3. Valid PDF -> clears error and displays filename
      const validPdf = new File(["%PDF-1.4"], "payslip.pdf", { type: "application/pdf" });
      fireEvent.change(fileInput, { target: { files: [validPdf] } });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByTestId("income-doc-filename")).toHaveTextContent("payslip.pdf");
      expect(onFileSelect).toHaveBeenLastCalledWith(validPdf);
    });

    it("prevents file selection and disables trigger button when disabled", () => {
      const onFileSelect = jest.fn();
      render(
        <FileUploadField
          id="disabled-doc"
          label="Proof of income"
          disabled
          onFileSelect={onFileSelect}
        />,
      );

      const triggerBtn = screen.getByRole("button", { name: /choose file/i });
      const fileInput = screen.getByLabelText(/Proof of income/i);
      expect(triggerBtn).toBeDisabled();
      expect(fileInput).toBeDisabled();

      const validPdf = new File(["%PDF-1.4"], "payslip.pdf", { type: "application/pdf" });
      fireEvent.change(fileInput, { target: { files: [validPdf] } });
      expect(onFileSelect).not.toHaveBeenCalled();
    });
  });
});
