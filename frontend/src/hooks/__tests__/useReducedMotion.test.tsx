import { renderHook, act } from "@testing-library/react";
import { useReducedMotion } from "../useReducedMotion";

describe("useReducedMotion", () => {
  it("reads and responds to the operating system preference", () => {
    let matches = true;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const matchMedia = jest.fn().mockReturnValue({
      matches,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
    } as unknown as MediaQueryList);
    Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });

    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);

    matches = false;
    act(() => listeners.forEach((listener) => listener({ matches } as MediaQueryListEvent)));
    expect(result.current).toBe(false);
    delete (window as { matchMedia?: unknown }).matchMedia;
  });
});
