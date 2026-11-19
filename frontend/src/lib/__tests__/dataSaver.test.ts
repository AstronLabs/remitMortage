// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { dataSaverInterval, getDataSaverDefault } from "../dataSaver";

describe("data saver", () => {
  it("prefers an explicit choice over the Save-Data hint", () => {
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: { saveData: true },
    });
    localStorage.setItem("remitmortgage-data-saver", "off");
    expect(getDataSaverDefault()).toBe(false);
  });

  it("uses a slower polling cadence when enabled", () => {
    expect(dataSaverInterval(5_000, 20_000, true)).toBe(20_000);
    expect(dataSaverInterval(5_000, 20_000, false)).toBe(5_000);
  });
});
