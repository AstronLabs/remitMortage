import React, { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConfirmationDialog from "../ConfirmationDialog";

function renderDialog(onConfirm: () => void | Promise<void>, onCancel = jest.fn()) {
  function Harness() {
    const [isOpen, setIsOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setIsOpen(true)}>
          Open dialog
        </button>
        <ConfirmationDialog
          isOpen={isOpen}
          title="Delete record?"
          description="This permanently deletes the record."
          confirmationText="DELETE"
          confirmLabel="Delete"
          onConfirm={onConfirm}
          onCancel={() => {
            onCancel();
            setIsOpen(false);
          }}
        />
      </>
    );
  }
  return render(<Harness />);
}

describe("ConfirmationDialog", () => {
  it("executes only after exact typed confirmation", async () => {
    const user = userEvent.setup();
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    renderDialog(onConfirm, onCancel);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));

    const input = screen.getByRole("textbox", { name: /type delete to continue/i });
    const confirmButton = screen.getByRole("button", { name: "Delete" });
    expect(confirmButton).toBeDisabled();

    await user.type(input, "DELET");
    expect(confirmButton).toBeDisabled();
    await user.clear(input);
    await user.type(input, "delete");
    expect(confirmButton).toBeDisabled();
    await user.clear(input);
    await user.type(input, "DELETE");
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it("cancels on Escape without executing and restores focus", async () => {
    const user = userEvent.setup();
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    renderDialog(onConfirm, onCancel);

    const openButton = screen.getByRole("button", { name: "Open dialog" });
    await user.click(openButton);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(openButton).toHaveFocus());
  });

  it("traps Tab navigation and prevents duplicate submission while loading", async () => {
    const user = userEvent.setup();
    let resolveConfirm!: () => void;
    const onConfirm = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        })
    );
    renderDialog(onConfirm);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));

    const confirmButton = screen.getByRole("button", { name: "Delete" });
    const input = screen.getByRole("textbox", { name: /type delete to continue/i });
    await user.type(input, "DELETE");
    confirmButton.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(input).toHaveFocus();
    input.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(confirmButton).toHaveFocus();

    confirmButton.focus();
    await user.click(confirmButton);
    expect(confirmButton).toBeDisabled();
    expect(confirmButton).toHaveAttribute("aria-busy", "true");
    await user.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    resolveConfirm();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("keeps the dialog open and announces a recoverable action error", async () => {
    const user = userEvent.setup();
    const onConfirm = jest.fn().mockRejectedValue(new Error("Request failed"));
    renderDialog(onConfirm);

    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    await user.type(screen.getByRole("textbox", { name: /type delete to continue/i }), "DELETE");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Request failed");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });
});
