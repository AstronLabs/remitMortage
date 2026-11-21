// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Illustration, ILLUSTRATION_NAMES } from "../illustrations/Illustration";

const THEMES = ["light", "dark"] as const;

// Matches any fill/stroke value that would punch a bright rectangle out of the
// dark theme: pure white, `white`, or an all-255 rgb*/rgba* trio.
const LIGHT_BACKGROUND_FILL = /(#ffffff\b|#fff\b|\bwhite\b|rgba?\(\s*255\s*,\s*255\s*,\s*255)/i;

describe("Illustration", () => {
  describe.each(ILLUSTRATION_NAMES)("%s", (name) => {
    it.each(THEMES)("renders a %s variant", (theme) => {
      const { container } = render(<Illustration name={name} theme={theme} />);

      const wrapper = container.querySelector(`[data-illustration="${name}"]`);
      expect(wrapper).not.toBeNull();
      expect(wrapper).toHaveAttribute("data-variant", theme);
      expect(wrapper!.querySelector("svg")).not.toBeNull();
    });

    it.each(THEMES)("matches the %s visual snapshot", (theme) => {
      const { container } = render(<Illustration name={name} theme={theme} />);
      expect(container.firstChild).toMatchSnapshot();
    });

    it("renders a dark variant without light-background artifacts", () => {
      const { container } = render(<Illustration name={name} theme="dark" />);
      expect(container.innerHTML).not.toMatch(LIGHT_BACKGROUND_FILL);
    });

    it("renders a light variant that differs from the dark variant", () => {
      const light = render(<Illustration name={name} theme="light" />).container.innerHTML;
      const dark = render(<Illustration name={name} theme="dark" />).container.innerHTML;
      expect(light).not.toEqual(dark);
    });
  });

  it("renders both variants for CSS-driven theme switching when no theme is forced", () => {
    const { container } = render(<Illustration name="empty-states" />);

    expect(container.querySelector('[data-variant="light"]')).not.toBeNull();
    expect(container.querySelector('[data-variant="dark"]')).not.toBeNull();
  });

  it("exposes an accessible name only when a title is provided", () => {
    const { container, rerender } = render(<Illustration name="empty-states" title="Empty inbox" />);
    expect(container.firstChild).toHaveAttribute("role", "img");
    expect(container.firstChild).toHaveAttribute("aria-label", "Empty inbox");

    rerender(<Illustration name="empty-states" />);
    expect(container.firstChild).not.toHaveAttribute("role");
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
