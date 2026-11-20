import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CopyValueButton from "../CopyValueButton";

const value = "ab".repeat(32);

it("copies the complete value and announces success", async () => {
  const user = userEvent.setup();
  const writeText = jest.spyOn(navigator.clipboard, "writeText");
  render(<CopyValueButton value={value} label="transaction hash" />);
  await user.click(screen.getByRole("button", { name: "Copy transaction hash" }));
  expect(writeText).toHaveBeenCalledWith(value);
  expect(screen.getByRole("status")).toHaveTextContent("Copied");
  writeText.mockRestore();
});

it("offers the selected original value when the clipboard is blocked", async () => {
  const user = userEvent.setup();
  const writeText = jest.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Denied"));
  render(<CopyValueButton value={value} label="transaction hash" />);
  await user.click(screen.getByRole("button", { name: "Copy transaction hash" }));
  expect(screen.getByRole("status")).toHaveTextContent("Could not copy");
  const fallback = screen.getByRole<HTMLInputElement>("textbox", { name: "Full transaction hash" });
  expect(fallback).toHaveValue(value);
  expect(fallback).toHaveFocus();
  expect(fallback.selectionStart).toBe(0);
  expect(fallback.selectionEnd).toBe(value.length);
  writeText.mockRestore();
});
