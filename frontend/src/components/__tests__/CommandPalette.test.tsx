import { fireEvent, render, screen } from "@testing-library/react";
import { useAuth } from "@/context/AuthContext";
import CommandPalette from "../CommandPalette";

jest.mock("@/context/AuthContext", () => ({ useAuth: jest.fn() }));

it("opens by button or shortcut, filters permitted routes, and closes with Escape", () => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } },
  });
  const auth = jest.mocked(useAuth);
  auth.mockReturnValue({
    role: "borrower", isAuthorized: true, isLoading: false, resolveRole: () => "borrower",
    hasAccess: href => !["/admin", "/invest", "/contractor"].includes(href),
  });
  render(<CommandPalette />);
  fireEvent.click(screen.getByRole("button", { name: "Quick navigation" }));
  const search = screen.getByRole("textbox", { name: "Search commands" });
  expect(search).toHaveFocus();
  expect(screen.queryByRole("link", { name: "Admin dashboard" })).toBeNull();
  fireEvent.change(search, { target: { value: "history" } });
  expect(screen.getByRole("status")).toHaveTextContent("1 command available");
  expect(screen.getByRole("link", { name: "Transaction history" })).toHaveAttribute("href", "/history");
  fireEvent.keyDown(search, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  expect(screen.getByRole("textbox")).toHaveValue("");
});
