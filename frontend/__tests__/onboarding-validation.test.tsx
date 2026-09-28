import React from "react";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import OnboardingWizard from "../src/components/onboarding/OnboardingWizard";
import { getOnboardingStore } from "../src/hooks/useOnboardingState";

// Mock the Next.js router
jest.mock("next/navigation", () => ({
  useRouter() {
    return { push: jest.fn() };
  },
  useSearchParams() {
    return new URLSearchParams();
  },
}));

// Wallet is connected so the wizard can advance past step 1.
jest.mock("../src/context/WalletContext", () => ({
  useWallet: () => ({
    publicKey: "GTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTEST",
    connect: jest.fn(),
    disconnect: jest.fn(),
  }),
}));

const setStep = (step: number) => {
  getOnboardingStore().setState({ step });
};

describe("Onboarding wizard – form validation", () => {
  beforeEach(() => {
    // Clear any autosaved draft so useFormAutosave's on-mount restore can't
    // silently override the step set up below (it reads localStorage and
    // calls setStep() as soon as the wizard mounts).
    localStorage.clear();
    // Reset persisted store to a known baseline before each test.
    getOnboardingStore().setState({
      step: 1,
      recipientAddress: "",
      isVerified: false,
      savingsTarget: 10000,
      savingsDuration: 12,
      firstDepositAmount: 0,
    });
  });

  it("blocks navigation past the address step when the recipient address is invalid", async () => {
    setStep(2);
    render(<OnboardingWizard />);

    const input = screen.getByPlaceholderText("Recipient's G... address");
    const scrollIntoView = jest.fn();
    input.scrollIntoView = scrollIntoView;
    fireEvent.change(input, { target: { value: "not-a-stellar-address" } });

    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    // An inline validation alert is shown and the step does not advance.
    await waitFor(() => {
      expect(document.getElementById("recipientAddress-error")).toHaveTextContent(
        /Invalid Stellar address/i
      );
    });
    const summary = screen.getByRole("region", { name: "Please correct the following errors" });
    const summaryLink = within(summary).getByRole("link", {
      name: /Recipient's Stellar wallet address: Invalid Stellar address/i,
    });
    expect(summaryLink).toHaveAttribute("href", "#recipientAddress");
    fireEvent.click(summaryLink);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(document.activeElement).toBe(input);
    expect(getOnboardingStore().getState().step).toBe(2);
  });

  it("removes the summary when the invalid field is corrected", async () => {
    setStep(2);
    render(<OnboardingWizard />);

    const input = screen.getByPlaceholderText("Recipient's G... address");
    fireEvent.change(input, { target: { value: "not-a-stellar-address" } });
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(
      await screen.findByRole("region", { name: "Please correct the following errors" })
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: `G${"A".repeat(55)}` } });
    await waitFor(() => {
      expect(
        screen.queryByRole("region", { name: "Please correct the following errors" })
      ).not.toBeInTheDocument();
    });
  });

  it("switches steps before scrolling and focusing a summary target", async () => {
    setStep(2);
    render(<OnboardingWizard />);

    const recipientAddress = screen.getByPlaceholderText("Recipient's G... address");
    const scrollIntoView = jest.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    fireEvent.change(recipientAddress, { target: { value: "not-a-stellar-address" } });

    act(() => setStep(3));
    const savingsTarget = await screen.findByLabelText("Down Payment Goal (USDC)");
    fireEvent.change(savingsTarget, { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    const summary = await screen.findByRole("region", {
      name: "Please correct the following errors",
    });
    expect(within(summary).getAllByRole("link")).toHaveLength(2);
    fireEvent.click(
      within(summary).getByRole("link", {
        name: /Recipient's Stellar wallet address: Invalid Stellar address/i,
      })
    );

    await waitFor(() => expect(getOnboardingStore().getState().step).toBe(2));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Recipient's G... address"));
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  });

  it("blocks navigation past the savings-goal step when the target is below the minimum", async () => {
    setStep(3);
    render(<OnboardingWizard />);

    const target = screen.getByRole("spinbutton");
    fireEvent.change(target, { target: { value: "100" } });

    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    await waitFor(() => {
      expect(document.getElementById("savingsTarget-error")).toHaveTextContent(/at least \$500/i);
    });
    expect(getOnboardingStore().getState().step).toBe(3);
  });

  it("advances past the savings-goal step when values are valid", async () => {
    setStep(3);
    render(<OnboardingWizard />);

    const target = screen.getByRole("spinbutton");
    fireEvent.change(target, { target: { value: "25000" } });

    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    await waitFor(() => expect(getOnboardingStore().getState().step).toBe(4));
  });
});
