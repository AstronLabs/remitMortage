// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { fireEvent, render, screen } from "@testing-library/react";
import { DataSaverProvider, useDataSaver } from "../DataSaverContext";

function Harness() {
  const { dataSaver, setDataSaver } = useDataSaver();
  return (
    <label>
      <input
        type="checkbox"
        aria-label="Data saver"
        checked={dataSaver}
        onChange={(event) => setDataSaver(event.target.checked)}
      />
      Data saver
    </label>
  );
}

describe("DataSaverProvider", () => {
  it("toggles and persists the manual data-saver choice", () => {
    render(
      <DataSaverProvider>
        <Harness />
      </DataSaverProvider>
    );
    const toggle = screen.getByRole("checkbox", { name: "Data saver" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(localStorage.getItem("remitmortgage-data-saver")).toBe("on");
  });
});
