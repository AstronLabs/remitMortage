// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useState } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProgressStepper, { getStepState } from "../ProgressStepper";
import { getOnboardingStore } from "@/hooks/useOnboardingState";

const STEPS = ["Connect Wallet", "Verify History", "Set Goal", "Documents", "Submit Application"];

/** Mirrors how the wizard drives the stepper: Next advances, picking a step revisits it. */
function Harness({ initialStep = 1 }: { initialStep?: number }) {
  const [step, setStep] = useState(initialStep);
  const [furthest, setFurthest] = useState(initialStep);
  const goTo = (target: number) => {
    setStep(target);
    setFurthest((value) => Math.max(value, target));
  };
  return (
    <>
      <ProgressStepper
        steps={STEPS}
        currentStep={step}
        furthestStep={furthest}
        onStepSelect={goTo}
      />
      <button type="button" onClick={() => goTo(step + 1)}>
        Next
      </button>
    </>
  );
}

describe("getStepState", () => {
  it("marks steps before the furthest reached step as completed", () => {
    expect(getStepState(1, 3, 3)).toBe("completed");
    expect(getStepState(3, 3, 3)).toBe("current");
    expect(getStepState(4, 3, 3)).toBe("upcoming");
    // Went back to step 2 after reaching step 4: step 3 stays completed.
    expect(getStepState(3, 2, 4)).toBe("completed");
    expect(getStepState(4, 2, 4)).toBe("upcoming");
  });
});

describe("ProgressStepper", () => {
  it("announces the current step and total to screen readers", () => {
    render(<ProgressStepper steps={STEPS} currentStep={2} />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Step 2 of 5: Verify History");
    expect(status).toHaveTextContent("1 of 5 steps completed");
    expect(screen.getByRole("navigation", { name: "Application progress" })).toBeInTheDocument();
    expect(screen.getByTestId("progress-step-2")).toHaveAttribute("aria-current", "step");
    expect(screen.getByTestId("progress-step-1")).not.toHaveAttribute("aria-current");
  });

  it("updates the indicator as steps are completed", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.getByTestId("progress-step-1")).toHaveAttribute("data-state", "current");
    expect(screen.getByTestId("application-progress-status")).toHaveTextContent("Step 1 of 5");

    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByTestId("progress-step-1")).toHaveAttribute("data-state", "completed");
    expect(screen.getByTestId("progress-step-2")).toHaveAttribute("data-state", "completed");
    expect(screen.getByTestId("progress-step-3")).toHaveAttribute("data-state", "current");
    expect(screen.getByTestId("progress-step-4")).toHaveAttribute("data-state", "upcoming");
    expect(screen.getByTestId("application-progress-status")).toHaveTextContent(
      "Step 3 of 5: Set Goal"
    );
  });

  it("makes completed steps clickable and keeps unreached steps non-interactive", () => {
    render(<ProgressStepper steps={STEPS} currentStep={3} onStepSelect={jest.fn()} />);

    expect(
      screen.getByRole("button", { name: /Step 1 of 5: Connect Wallet, completed/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Step 2 of 5: Verify History, completed/ })
    ).toBeInTheDocument();
    // Only the two completed steps are buttons: not the current one, not upcoming ones.
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByText("Step 4 of 5: Documents, not yet reached")).toBeInTheDocument();
  });

  it("revisits a completed step and keeps later progress marked complete", async () => {
    const user = userEvent.setup();
    render(<Harness initialStep={4} />);

    await user.click(screen.getByRole("button", { name: /Step 2 of 5: Verify History/ }));

    expect(screen.getByTestId("progress-step-2")).toHaveAttribute("data-state", "current");
    expect(screen.getByTestId("progress-step-2")).toHaveAttribute("aria-current", "step");
    expect(screen.getByTestId("progress-step-3")).toHaveAttribute("data-state", "completed");
    expect(screen.getByTestId("application-progress-status")).toHaveTextContent(
      "Step 2 of 5: Verify History"
    );
    // Step 3 was completed earlier, so it is still reachable from here.
    expect(screen.getByRole("button", { name: /Step 3 of 5: Set Goal, completed/ })).toBeEnabled();
  });

  it("can be operated with the keyboard", async () => {
    const user = userEvent.setup();
    const onStepSelect = jest.fn();
    render(<ProgressStepper steps={STEPS} currentStep={3} onStepSelect={onStepSelect} />);

    await user.tab();
    expect(screen.getByRole("button", { name: /Step 1 of 5/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: /Step 2 of 5/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onStepSelect).toHaveBeenCalledWith(2);
    await user.keyboard(" ");
    expect(onStepSelect).toHaveBeenCalledTimes(2);
  });

  it("treats a step past the last one as every step complete", () => {
    render(<ProgressStepper steps={STEPS} currentStep={6} />);
    for (let step = 1; step <= STEPS.length; step += 1) {
      expect(screen.getByTestId(`progress-step-${step}`)).toHaveAttribute("data-state", "completed");
    }
    expect(screen.getByRole("status")).toHaveTextContent("5 of 5 steps completed");
  });
});

describe("onboarding store furthest step", () => {
  afterEach(() => {
    act(() => getOnboardingStore().getState().reset());
  });

  it("remembers the furthest step reached when going back", () => {
    const store = getOnboardingStore();
    act(() => {
      store.getState().setStep(2);
      store.getState().setStep(4);
      store.getState().setStep(2);
    });

    expect(store.getState().step).toBe(2);
    expect(store.getState().furthestStep).toBe(4);

    act(() => store.getState().reset());
    expect(store.getState().furthestStep).toBe(1);
  });
});
