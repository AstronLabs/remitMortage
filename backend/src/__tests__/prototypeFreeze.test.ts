// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Startup prototype freezing (issue #885), the third guard layer.
 *
 * This lives in its own file on purpose: `Object.freeze` is irreversible, so
 * sealing `Object.prototype` has to happen where nothing else runs afterwards.
 * Jest gives each test file its own VM context, so the freeze applied here
 * does not reach any other suite.
 *
 * The freeze is a backstop, not the primary defence — `prototypePollution.test.ts`
 * covers the stripping and safe-merge layers that run first.
 */

import {
  CRITICAL_PROTOTYPES,
  freezeCriticalPrototypes,
  safeMerge,
} from "../utils/safeObject";

describe("CRITICAL_PROTOTYPES", () => {
  it("covers the prototypes a pollution payload actually targets", () => {
    const names = CRITICAL_PROTOTYPES.map((entry) => entry.name);

    expect(names).toContain("Object.prototype");
    expect(names).toContain("Array.prototype");
    expect(names).toContain("String.prototype");
  });

  it("leaves Function.prototype mutable, because instrumentation patches it", () => {
    // OpenTelemetry and Sentry both wrap functions at require time; sealing
    // Function.prototype breaks them, so it is deliberately not in the list.
    expect(CRITICAL_PROTOTYPES.map((entry) => entry.name)).not.toContain("Function.prototype");
  });
});

describe("freezeCriticalPrototypes", () => {
  const originalFlag = process.env.PROTOTYPE_FREEZE;

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.PROTOTYPE_FREEZE;
    else process.env.PROTOTYPE_FREEZE = originalFlag;
  });

  it("is a no-op when PROTOTYPE_FREEZE=off", () => {
    process.env.PROTOTYPE_FREEZE = "off";

    // Passing an explicit target keeps this assertion independent of the
    // real builtins, which later tests in this file do freeze.
    const sacrificial = { name: "Sacrificial.prototype", proto: {} };
    expect(freezeCriticalPrototypes([sacrificial])).toEqual([]);
    expect(Object.isFrozen(sacrificial.proto)).toBe(false);
  });

  it("freezes the prototypes it is given and names them", () => {
    delete process.env.PROTOTYPE_FREEZE;

    const target = { name: "Example.prototype", proto: {} as Record<string, unknown> };

    expect(freezeCriticalPrototypes([target])).toEqual(["Example.prototype"]);
    expect(Object.isFrozen(target.proto)).toBe(true);
  });

  it("does not throw when a target cannot be sealed", () => {
    const hostile = {
      name: "Hostile.prototype",
      get proto(): object {
        throw new Error("cannot touch this");
      },
    };

    expect(() => freezeCriticalPrototypes([hostile as never])).not.toThrow();
  });

  // Runs last: after this, Object.prototype is sealed for the rest of the file.
  it("stops a successful pollution attempt from changing behaviour process-wide", () => {
    delete process.env.PROTOTYPE_FREEZE;

    const frozen = freezeCriticalPrototypes();
    expect(frozen).toContain("Object.prototype");
    expect(Object.isFrozen(Object.prototype)).toBe(true);

    // Non-strict assignment to a frozen prototype is silently discarded;
    // under "use strict" (which compiled TS modules are) it throws. Either
    // outcome is acceptable — what matters is that nothing is written.
    try {
      (Object.prototype as unknown as Record<string, unknown>).frozenProbe = "yes";
    } catch {
      /* strict-mode TypeError is the expected path */
    }
    expect(({} as Record<string, unknown>).frozenProbe).toBeUndefined();

    // And the safe helpers keep working against a frozen prototype.
    const merged = safeMerge({ a: 1 } as Record<string, unknown>, { b: 2 });
    expect(merged).toEqual({ a: 1, b: 2 });
  });
});
