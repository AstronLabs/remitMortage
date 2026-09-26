// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  NARRATION_RATES,
  collectNarrationSegments,
  createNarrationEngine,
  speakAmount,
  speakRateBps,
  speakTermMonths,
  spellOutSymbol,
  toSpokenNumber,
  type NarrationSegment,
  type SpeechSynthesisLike,
  type SpeechSynthesisUtteranceLike,
} from "../loanTermsNarration";

/**
 * Records every utterance handed to `speak` and lets a test drive the queue by
 * firing `onend`, standing in for the real engine's speech-finished event.
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

  /** Text of every utterance, in the order they were spoken. */
  get texts(): string[] {
    return this.spoken.map((utterance) => utterance.text);
  }

  /** Simulates the active utterance finishing. */
  finishCurrent() {
    this.spoken[this.spoken.length - 1].onend?.();
  }
}

function segments(...texts: string[]): NarrationSegment[] {
  return texts.map((text, position) => ({ text, order: position, position }));
}

function setup(rate: 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2 = 1) {
  const synth = new FakeSynth();
  const engine = createNarrationEngine({
    synth,
    createUtterance: (text) => ({ text, rate: 1, onend: null, onerror: null }),
    rate,
  });
  return { synth, engine };
}

describe("collectNarrationSegments", () => {
  it("returns marked-up terms in DOM order", () => {
    document.body.innerHTML = `
      <div data-narration="Principal, 25,000 USDC"></div>
      <div data-narration="Interest rate, 6.5 percent per year"></div>
      <div data-narration="Term length, 2 years, 0 months"></div>
    `;

    expect(collectNarrationSegments(document.body).map((segment) => segment.text)).toEqual([
      "Principal, 25,000 USDC",
      "Interest rate, 6.5 percent per year",
      "Term length, 2 years, 0 months",
    ]);
  });

  it("ignores elements that are not marked up", () => {
    document.body.innerHTML = `
      <div>Not narrated</div>
      <div data-narration="Principal"></div>
    `;

    expect(collectNarrationSegments(document.body)).toHaveLength(1);
  });

  it("skips empty summaries so they do not become silent utterances", () => {
    document.body.innerHTML = `
      <div data-narration="   "></div>
      <div data-narration="Principal"></div>
    `;

    expect(collectNarrationSegments(document.body).map((segment) => segment.text)).toEqual([
      "Principal",
    ]);
  });

  it("trims surrounding whitespace from the summary", () => {
    document.body.innerHTML = `<div data-narration="  Principal  "></div>`;
    expect(collectNarrationSegments(document.body)[0].text).toBe("Principal");
  });

  it("honours an explicit order when layout reorders the terms", () => {
    document.body.innerHTML = `
      <div data-narration="Penalty" data-narration-order="3"></div>
      <div data-narration="Principal" data-narration-order="1"></div>
      <div data-narration="Rate" data-narration-order="2"></div>
    `;

    expect(collectNarrationSegments(document.body).map((segment) => segment.text)).toEqual([
      "Principal",
      "Rate",
      "Penalty",
    ]);
  });

  it("keeps DOM order for terms sharing an explicit order", () => {
    document.body.innerHTML = `
      <div data-narration="First" data-narration-order="1"></div>
      <div data-narration="Second" data-narration-order="1"></div>
    `;

    expect(collectNarrationSegments(document.body).map((segment) => segment.text)).toEqual([
      "First",
      "Second",
    ]);
  });
});

describe("spoken formatting", () => {
  it("spaces thousands so the synthesiser reads digits individually", () => {
    expect(toSpokenNumber(25000)).toBe("25 000");
    expect(toSpokenNumber(250)).toBe("250");
  });

  it("spells out a ticker so it is not mispronounced", () => {
    expect(spellOutSymbol("USDC")).toBe("U S D C");
  });

  it("renders an amount as a spoken figure", () => {
    expect(speakAmount(25000)).toBe("25,000 U S D C");
  });

  it("renders basis points as percent", () => {
    expect(speakRateBps(650)).toBe("6.5 percent");
    expect(speakRateBps(400)).toBe("4 percent");
  });

  it("renders a term in months as years and months", () => {
    expect(speakTermMonths(30)).toBe("2 years, 6 months");
    expect(speakTermMonths(18)).toBe("1 year, 6 months");
    // A whole number of years or months is spoken without a "0" remainder.
    expect(speakTermMonths(24)).toBe("2 years");
    expect(speakTermMonths(1)).toBe("1 month");
    expect(speakTermMonths(6)).toBe("6 months");
  });

  it("degrades gracefully on missing or invalid values", () => {
    expect(speakTermMonths(0)).toBe("unknown");
    expect(speakRateBps(Number.NaN)).toBe("unknown");
    expect(toSpokenNumber(Number.POSITIVE_INFINITY)).toBe("unknown");
  });
});

describe("narration engine playback", () => {
  it("narrates every term in order", () => {
    const { synth, engine } = setup();
    engine.load(segments("Principal", "Rate", "Term"));

    engine.play();
    expect(synth.texts).toEqual(["Principal"]);
    expect(engine.getState().status).toBe("speaking");

    synth.finishCurrent();
    expect(synth.texts).toEqual(["Principal", "Rate"]);

    synth.finishCurrent();
    expect(synth.texts).toEqual(["Principal", "Rate", "Term"]);
    expect(engine.getState().index).toBe(2);

    synth.finishCurrent();
    expect(engine.getState().status).toBe("done");
  });

  it("reports total and current position", () => {
    const { synth, engine } = setup();
    engine.load(segments("Principal", "Rate", "Term"));
    engine.play();

    expect(engine.getState()).toMatchObject({ index: 0, total: 3, status: "speaking" });

    synth.finishCurrent();
    expect(engine.getState().index).toBe(1);
  });

  it("stays idle when no terms are marked up", () => {
    const { synth, engine } = setup();
    engine.load([]);

    engine.play();
    expect(synth.spoken).toHaveLength(0);
    expect(engine.getState().status).toBe("idle");
  });

  it("advances past an utterance that errors", () => {
    const { synth, engine } = setup();
    engine.load(segments("Principal", "Rate"));
    engine.play();

    synth.spoken[0].onerror?.({ error: "network" });
    expect(synth.texts).toEqual(["Principal", "Rate"]);
  });
});

describe("pause and resume", () => {
  it("pauses the underlying synth and holds position", () => {
    const { synth, engine } = setup();
    engine.load(segments("Principal", "Rate", "Term"));
    engine.play();
    synth.finishCurrent();

    engine.pause();

    expect(synth.pauses).toBe(1);
    expect(engine.getState()).toMatchObject({ status: "paused", index: 1 });
    // Pausing must not queue anything new.
    expect(synth.texts).toEqual(["Principal", "Rate"]);
  });

  it("ignores pause when nothing is playing", () => {
    const { synth, engine } = setup();
    engine.load(segments("Principal"));

    engine.pause();
    expect(synth.pauses).toBe(0);
  });

  it("resumes the same term rather than starting over", () => {
    const { synth, engine } = setup();
    engine.load(segments("Principal", "Rate", "Term"));
    engine.play();
    synth.finishCurrent();
    engine.pause();

    engine.resume();

    expect(synth.resumes).toBe(1);
    expect(engine.getState()).toMatchObject({ status: "speaking", index: 1 });
    // The key acceptance point: resume did not re-speak the first term.
    expect(synth.texts).toEqual(["Principal", "Rate"]);
  });

  it("ignores resume when not paused", () => {
    const { synth, engine } = setup();
    engine.load(segments("Principal"));
    engine.play();

    engine.resume();
    expect(synth.resumes).toBe(0);
  });

  it("carries on from the resumed term to the end", () => {
    const { synth, engine } = setup();
    engine.load(segments("Principal", "Rate", "Term"));
    engine.play();
    synth.finishCurrent();
    engine.pause();
    engine.resume();

    synth.finishCurrent();
    expect(synth.texts).toEqual(["Principal", "Rate", "Term"]);
  });
});

describe("replay", () => {
  it("re-speaks the current term without returning to the first", () => {
    const { synth, engine } = setup();
    engine.load(segments("Principal", "Rate", "Term"));
    engine.play();
    synth.finishCurrent();
    synth.finishCurrent();
    expect(engine.getState().index).toBe(2);

    engine.replayCurrent();

    // "Term" again — not "Principal".
    expect(synth.texts).toEqual(["Principal", "Rate", "Term", "Term"]);
    expect(engine.getState().index).toBe(2);
  });

  it("keeps the run going after a replayed term", () => {
    const { synth, engine } = setup();
    engine.load(segments("Principal", "Rate", "Term"));
    engine.play();
    synth.finishCurrent();

    engine.replayCurrent();
    synth.finishCurrent();

    expect(synth.texts).toEqual(["Principal", "Rate", "Rate", "Term"]);
  });

  it("does not advance when a cancelled utterance reports an error", () => {
    const { synth, engine } = setup();
    engine.load(segments("Principal", "Rate", "Term"));
    engine.play();
    synth.finishCurrent();

    engine.replayCurrent();
    // The superseded utterance erroring must be swallowed, not treated as the
    // replayed term finishing.
    synth.spoken[1].onerror?.({ error: "interrupted" });

    expect(synth.texts).toEqual(["Principal", "Rate", "Rate"]);
    expect(engine.getState().index).toBe(1);
  });

  it("restarts from the first term only when asked", () => {
    const { synth, engine } = setup();
    engine.load(segments("Principal", "Rate", "Term"));
    engine.play();
    synth.finishCurrent();
    synth.finishCurrent();

    engine.restart();

    expect(synth.texts).toEqual(["Principal", "Rate", "Term", "Principal"]);
    expect(engine.getState().index).toBe(0);
  });

  it("does nothing when replaying with no terms loaded", () => {
    const { synth, engine } = setup();
    engine.replayCurrent();
    expect(synth.spoken).toHaveLength(0);
  });
});

describe("speed control", () => {
  it("applies the configured rate to utterances", () => {
    const { synth, engine } = setup(1.5);
    engine.load(segments("Principal"));
    engine.play();

    expect(synth.spoken[0].rate).toBe(1.5);
  });

  it("applies a changed rate to the next term without restarting the run", () => {
    const { synth, engine } = setup();
    engine.load(segments("Principal", "Rate", "Term"));
    engine.play();

    engine.setRate(2);
    synth.finishCurrent();

    expect(synth.texts).toEqual(["Principal", "Rate"]);
    expect(synth.spoken[1].rate).toBe(2);
    expect(engine.getState().rate).toBe(2);
  });

  it("does not interrupt the term in flight when the rate changes", () => {
    const { synth, engine } = setup();
    engine.load(segments("Principal", "Rate"));
    engine.play();
    const cancelsBefore = synth.cancelled;
    const spokenBefore = synth.texts.length;

    engine.setRate(0.5);

    // Same utterance, still in progress — no cancel, no re-speak.
    expect(synth.cancelled).toBe(cancelsBefore);
    expect(synth.texts).toHaveLength(spokenBefore);
    expect(engine.getState().status).toBe("speaking");
  });

  it("cycles through the offered rates and wraps around", () => {
    const { engine } = setup(0.5);
    const seen = [engine.cycleRate()];

    for (let i = 0; i < NARRATION_RATES.length - 1; i += 1) {
      seen.push(engine.cycleRate());
    }

    expect(seen).toEqual([0.75, 1, 1.25, 1.5, 2, 0.5]);
    expect(engine.getState().rate).toBe(0.5);
  });
});

describe("stop and reload", () => {
  it("cancels speech and returns to idle", () => {
    const { synth, engine } = setup();
    engine.load(segments("Principal", "Rate"));
    engine.play();

    engine.stop();

    expect(synth.cancelled).toBeGreaterThan(0);
    expect(engine.getState().status).toBe("idle");
  });

  it("resets the position when new terms are loaded", () => {
    const { synth, engine } = setup();
    engine.load(segments("Principal", "Rate"));
    engine.play();
    synth.finishCurrent();

    engine.load(segments("Status, Approved"));
    engine.play();

    expect(synth.texts).toEqual(["Principal", "Rate", "Status, Approved"]);
    expect(engine.getState().index).toBe(0);
  });

  it("notifies the listener of every state change", () => {
    const states: string[] = [];
    const synth = new FakeSynth();
    const engine = createNarrationEngine({
      synth,
      createUtterance: (text) => ({ text, rate: 1, onend: null, onerror: null }),
      onStateChange: (state) => states.push(state.status),
    });

    // Two segments, so the run is still in progress after the first finishes.
    engine.load(segments("Principal", "Rate"));
    engine.play();
    synth.finishCurrent();
    engine.pause();
    engine.resume();

    expect(states).toContain("idle");
    expect(states).toContain("speaking");
    expect(states).toContain("paused");
  });

  it("notifies the listener when the run finishes", () => {
    const states: string[] = [];
    const synth = new FakeSynth();
    const engine = createNarrationEngine({
      synth,
      createUtterance: (text) => ({ text, rate: 1, onend: null, onerror: null }),
      onStateChange: (state) => states.push(state.status),
    });

    engine.load(segments("Principal"));
    engine.play();
    synth.finishCurrent();

    expect(states[states.length - 1]).toBe("done");
  });
});

describe("support detection", () => {
  it("reports support when a synth and utterance factory are available", () => {
    const { engine } = setup();
    expect(engine.isSupported()).toBe(true);
  });

  it("reports no support without a speech implementation", () => {
    const engine = createNarrationEngine({ synth: null, createUtterance: undefined });
    expect(engine.isSupported()).toBe(false);
  });

  it("degrades to idle instead of throwing when unsupported", () => {
    const engine = createNarrationEngine({ synth: null, createUtterance: undefined });
    engine.load(segments("Principal"));

    expect(() => engine.play()).not.toThrow();
  });
});
