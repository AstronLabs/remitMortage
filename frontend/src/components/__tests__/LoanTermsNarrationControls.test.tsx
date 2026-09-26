// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import LoanTermsNarrationControls from "../LoanTermsNarrationControls";
import { NarrationProvider } from "@/context/NarrationContext";
import type { SpeechSynthesisLike, SpeechSynthesisUtteranceLike } from "@/lib/loanTermsNarration";

/**
 * Stands in for the Web Speech API, which jsdom does not implement. Records
 * utterances and exposes a manual clock so tests can advance the queue.
 */
class FakeSynth implements SpeechSynthesisLike {
  spoken: SpeechSynthesisUtteranceLike[] = [];
  cancelled = 0;
  pauses = 0;
  resumes = 0;
  speaking = false;
  paused = false;

  speak(utterance: SpeechSynthesisUtteranceLike) {
    this.spoken.push(utterance);
    this.speaking = true;
  }
  cancel() {
    this.cancelled += 1;
    this.speaking = false;
  }
  pause() {
    this.pauses += 1;
    this.paused = true;
  }
  resume() {
    this.resumes += 1;
    this.paused = false;
  }
  get texts(): string[] {
    return this.spoken.map((utterance) => utterance.text);
  }
  finishCurrent() {
    act(() => {
      this.spoken[this.spoken.length - 1].onend?.();
    });
  }
}

/** Installs a fake `window.speechSynthesis` + `SpeechSynthesisUtterance`. */
function installSpeechApi() {
  const synth = new FakeSynth();
  (window as unknown as { speechSynthesis: SpeechSynthesisLike }).speechSynthesis = synth;
  (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = function (
    this: SpeechSynthesisUtteranceLike,
    text: string
  ) {
    this.text = text;
    this.rate = 1;
    this.onend = null;
    this.onerror = null;
  };
  return synth;
}

function renderControls() {
  return render(
    <NarrationProvider>
      <LoanTermsNarrationControls />
    </NarrationProvider>
  );
}

/** Marks up a set of terms, standing in for the real loan-terms surface. */
function renderTerms(...texts: string[]) {
  return render(
    <NarrationProvider>
      <div>
        {texts.map((text) => (
          <div key={text} data-narration={text} />
        ))}
      </div>
      <LoanTermsNarrationControls />
    </NarrationProvider>
  );
}

/** Switches the mode on, then starts playback the way a user would. */
async function enableAndPlay(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("narration-toggle"));
  await user.click(screen.getByTestId("narration-playback"));
}

describe("LoanTermsNarrationControls", () => {
  let synth: FakeSynth;

  beforeEach(() => {
    window.localStorage.clear();
    document.body.innerHTML = "";
    synth = installSpeechApi();
  });

  afterEach(() => {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    delete (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
  });

  it("is opt-in: nothing is spoken until the mode is switched on", async () => {
    const user = userEvent.setup();
    renderTerms("Principal", "Rate", "Term");

    expect(synth.spoken).toHaveLength(0);
    expect(screen.queryByTestId("narration-playback")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("narration-toggle"));

    expect(screen.getByTestId("narration-toggle")).toHaveAttribute("aria-pressed", "true");
    // Switching the mode on must not start talking unprompted — a restored
    // preference should never ambush the user with audio on page load.
    expect(synth.spoken).toHaveLength(0);

    await user.click(screen.getByTestId("narration-playback"));
    expect(synth.texts).toEqual(["Principal"]);
  });

  it("narrates all marked-up terms in order once enabled", async () => {
    const user = userEvent.setup();
    renderTerms("Principal", "Rate", "Term");

    await enableAndPlay(user);
    synth.finishCurrent();
    synth.finishCurrent();
    synth.finishCurrent();

    expect(synth.texts).toEqual(["Principal", "Rate", "Term"]);
  });

  it("reports progress as it advances", async () => {
    const user = userEvent.setup();
    renderTerms("Principal", "Rate", "Term");

    await enableAndPlay(user);
    expect(screen.getByTestId("narration-progress")).toHaveTextContent("Term 1 of 3");

    synth.finishCurrent();
    expect(screen.getByTestId("narration-progress")).toHaveTextContent("Term 2 of 3");
  });

  it("stops speaking and cancels when the toggle is switched off", async () => {
    const user = userEvent.setup();
    renderTerms("Principal", "Rate");

    await user.click(screen.getByTestId("narration-toggle"));
    const cancelsBefore = synth.cancelled;

    await user.click(screen.getByTestId("narration-toggle"));

    expect(synth.cancelled).toBeGreaterThan(cancelsBefore);
    expect(screen.getByTestId("narration-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("hides the transport controls while the mode is off", () => {
    renderControls();
    expect(screen.queryByTestId("narration-playback")).not.toBeInTheDocument();
  });

  it("pauses without losing the current term", async () => {
    const user = userEvent.setup();
    renderTerms("Principal", "Rate", "Term");

    await enableAndPlay(user);
    synth.finishCurrent();
    expect(screen.getByTestId("narration-progress")).toHaveTextContent("Term 2 of 3");

    await user.click(screen.getByTestId("narration-playback"));

    expect(synth.pauses).toBe(1);
    expect(screen.getByTestId("narration-playback")).toHaveTextContent("Resume");
    expect(screen.getByTestId("narration-progress")).toHaveTextContent("Term 2 of 3");
  });

  it("resumes the same term instead of starting over", async () => {
    const user = userEvent.setup();
    renderTerms("Principal", "Rate", "Term");

    await enableAndPlay(user);
    synth.finishCurrent();
    await user.click(screen.getByTestId("narration-playback"));
    await user.click(screen.getByTestId("narration-playback"));

    expect(synth.resumes).toBe(1);
    // The first term must not be spoken a second time.
    expect(synth.texts).toEqual(["Principal", "Rate"]);
  });

  it("replays only the current term", async () => {
    const user = userEvent.setup();
    renderTerms("Principal", "Rate", "Term");

    await enableAndPlay(user);
    synth.finishCurrent();
    synth.finishCurrent();

    await user.click(screen.getByTestId("narration-replay"));

    expect(synth.texts).toEqual(["Principal", "Rate", "Term", "Term"]);
    expect(screen.getByTestId("narration-progress")).toHaveTextContent("Term 3 of 3");
  });

  it("keeps playing after a replayed term", async () => {
    const user = userEvent.setup();
    renderTerms("Principal", "Rate", "Term");

    await enableAndPlay(user);
    synth.finishCurrent();
    await user.click(screen.getByTestId("narration-replay"));
    synth.finishCurrent();

    expect(synth.texts).toEqual(["Principal", "Rate", "Rate", "Term"]);
  });

  it("adjusts speed without interrupting the current term", async () => {
    const user = userEvent.setup();
    renderTerms("Principal", "Rate");

    await enableAndPlay(user);
    const cancelsBefore = synth.cancelled;
    const spokenBefore = synth.texts.length;

    await user.click(screen.getByTestId("narration-rate"));

    expect(screen.getByTestId("narration-rate")).toHaveTextContent("Speed 1.25x");
    // Speed changed mid-sentence: no cancel, no re-speak.
    expect(synth.cancelled).toBe(cancelsBefore);
    expect(synth.texts).toHaveLength(spokenBefore);

    synth.finishCurrent();
    expect(synth.spoken[1].rate).toBe(1.25);
  });

  it("cycles speed through every offered rate", async () => {
    const user = userEvent.setup();
    renderTerms("Principal");

    await user.click(screen.getByTestId("narration-toggle"));
    const seen = ["Speed 1x"];
    for (let i = 0; i < 5; i += 1) {
      await user.click(screen.getByTestId("narration-rate"));
      seen.push(screen.getByTestId("narration-rate").textContent ?? "");
    }

    expect(seen).toEqual([
      "Speed 1x",
      "Speed 1.25x",
      "Speed 1.5x",
      "Speed 2x",
      "Speed 0.5x",
      "Speed 0.75x",
    ]);
  });

  it("stops on demand and can play again", async () => {
    const user = userEvent.setup();
    renderTerms("Principal", "Rate");

    await enableAndPlay(user);
    await user.click(screen.getByTestId("narration-stop"));

    expect(screen.getByTestId("narration-playback")).toHaveTextContent("Play");

    await user.click(screen.getByTestId("narration-playback"));
    // Play after a stop starts the run again from the first term.
    expect(synth.texts).toEqual(["Principal", "Principal"]);
  });

  it("starts over from the first term on request", async () => {
    const user = userEvent.setup();
    renderTerms("Principal", "Rate", "Term");

    await enableAndPlay(user);
    synth.finishCurrent();
    synth.finishCurrent();
    await user.click(screen.getByTestId("narration-restart"));

    expect(screen.getByTestId("narration-progress")).toHaveTextContent("Term 1 of 3");
    expect(synth.texts).toEqual(["Principal", "Rate", "Term", "Principal"]);
  });

  it("announces playback state to assistive technology", async () => {
    const user = userEvent.setup();
    renderTerms("Principal", "Rate");

    await enableAndPlay(user);
    expect(screen.getByTestId("narration-status")).toHaveTextContent("Term 1 of 2. Reading.");

    await user.click(screen.getByTestId("narration-playback"));
    expect(screen.getByTestId("narration-status")).toHaveTextContent("Paused.");
  });

  it("says so when the page has no marked-up terms", async () => {
    const user = userEvent.setup();
    render(
      <NarrationProvider>
        <LoanTermsNarrationControls />
      </NarrationProvider>
    );

    await user.click(screen.getByTestId("narration-toggle"));
    expect(screen.getByTestId("narration-progress")).toHaveTextContent("No terms found");
  });

  it("disables the toggle and explains why when speech is unavailable", () => {
    // Simulate a browser with no Web Speech API at all.
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    delete (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;

    renderControls();

    expect(screen.getByTestId("narration-unsupported")).toBeInTheDocument();
    expect(screen.getByTestId("narration-toggle")).toBeDisabled();
  });
});

describe("opt-in persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.innerHTML = "";
    installSpeechApi();
  });

  afterEach(() => {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    delete (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
  });

  it("remembers that the mode was switched on", async () => {
    const user = userEvent.setup();
    const { unmount } = renderTerms("Principal");
    await user.click(screen.getByTestId("narration-toggle"));
    unmount();

    expect(JSON.parse(window.localStorage.getItem("loan-terms-narration") ?? "{}")).toMatchObject({
      enabled: true,
    });

    renderTerms("Principal");
    expect(screen.getByTestId("narration-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  it("remembers the chosen speed", async () => {
    const user = userEvent.setup();
    renderTerms("Principal");
    await user.click(screen.getByTestId("narration-toggle"));
    await user.click(screen.getByTestId("narration-rate"));

    expect(JSON.parse(window.localStorage.getItem("loan-terms-narration") ?? "{}")).toMatchObject({
      rate: 1.25,
    });
  });

  it("starts opted out when nothing is stored", () => {
    renderTerms("Principal");
    expect(screen.getByTestId("narration-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("falls back to opted out when storage holds junk", () => {
    window.localStorage.setItem("loan-terms-narration", "{not json");
    renderTerms("Principal");

    expect(screen.getByTestId("narration-toggle")).toHaveAttribute("aria-pressed", "false");
  });
});
