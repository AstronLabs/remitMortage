// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { renderHook, act } from "@testing-library/react";
import { useTypingIndicator } from "../useTypingIndicator";

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe("useTypingIndicator (issue #781)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("local typing (debounced outbound signal)", () => {
    it("fires onLocalTypingChange(true) once for a burst of rapid keystrokes", async () => {
      const onLocalTypingChange = jest.fn();
      const { result } = renderHook(() => useTypingIndicator({ onLocalTypingChange }));

      act(() => result.current.notifyTyping());
      await advance(200);
      act(() => result.current.notifyTyping());
      await advance(200);
      act(() => result.current.notifyTyping());

      expect(onLocalTypingChange).toHaveBeenCalledTimes(1);
      expect(onLocalTypingChange).toHaveBeenCalledWith(true);
    });

    it("fires onLocalTypingChange(false) once debounceMs elapses without further keystrokes", async () => {
      const onLocalTypingChange = jest.fn();
      const { result } = renderHook(() =>
        useTypingIndicator({ onLocalTypingChange, debounceMs: 1500 })
      );

      act(() => result.current.notifyTyping());
      await advance(1499);
      expect(onLocalTypingChange).toHaveBeenCalledTimes(1); // just the initial (true)
      await advance(1);
      expect(onLocalTypingChange).toHaveBeenCalledTimes(2);
      expect(onLocalTypingChange).toHaveBeenLastCalledWith(false);
    });

    it("restarts the debounce window on every keystroke, delaying the stop signal", async () => {
      const onLocalTypingChange = jest.fn();
      const { result } = renderHook(() =>
        useTypingIndicator({ onLocalTypingChange, debounceMs: 1000 })
      );

      act(() => result.current.notifyTyping());
      await advance(900);
      act(() => result.current.notifyTyping()); // resets the 1000ms window
      await advance(900);
      expect(onLocalTypingChange).toHaveBeenCalledTimes(1); // still only the initial (true)
      await advance(100);
      expect(onLocalTypingChange).toHaveBeenCalledTimes(2);
      expect(onLocalTypingChange).toHaveBeenLastCalledWith(false);
    });

    it("fires a final stop signal on unmount if still mid-typing", async () => {
      const onLocalTypingChange = jest.fn();
      const { result, unmount } = renderHook(() => useTypingIndicator({ onLocalTypingChange }));

      act(() => result.current.notifyTyping());
      expect(onLocalTypingChange).toHaveBeenLastCalledWith(true);

      unmount();
      expect(onLocalTypingChange).toHaveBeenLastCalledWith(false);
      expect(onLocalTypingChange).toHaveBeenCalledTimes(2);
    });

    it("does not fire a spurious stop signal on unmount when never typing", () => {
      const onLocalTypingChange = jest.fn();
      const { unmount } = renderHook(() => useTypingIndicator({ onLocalTypingChange }));
      unmount();
      expect(onLocalTypingChange).not.toHaveBeenCalled();
    });
  });

  describe("remote typing (rendered indicator)", () => {
    it("shows the indicator as soon as a remote typing event arrives", () => {
      const { result } = renderHook(() => useTypingIndicator());
      expect(result.current.isOtherPartyTyping).toBe(false);

      act(() => result.current.receiveRemoteTypingEvent(true));
      expect(result.current.isOtherPartyTyping).toBe(true);
    });

    it("clears the indicator immediately on an explicit stop event", () => {
      const { result } = renderHook(() => useTypingIndicator());

      act(() => result.current.receiveRemoteTypingEvent(true));
      expect(result.current.isOtherPartyTyping).toBe(true);

      act(() => result.current.receiveRemoteTypingEvent(false));
      expect(result.current.isOtherPartyTyping).toBe(false);
    });

    it("auto-clears the indicator after remoteTimeoutMs if the stop event is missed", async () => {
      const { result } = renderHook(() => useTypingIndicator({ remoteTimeoutMs: 5000 }));

      act(() => result.current.receiveRemoteTypingEvent(true));
      expect(result.current.isOtherPartyTyping).toBe(true);

      await advance(4999);
      expect(result.current.isOtherPartyTyping).toBe(true);
      await advance(1);
      expect(result.current.isOtherPartyTyping).toBe(false);
    });

    it("a fresh typing event refreshes the timeout window instead of clearing early", async () => {
      const { result } = renderHook(() => useTypingIndicator({ remoteTimeoutMs: 5000 }));

      act(() => result.current.receiveRemoteTypingEvent(true));
      await advance(4000);
      act(() => result.current.receiveRemoteTypingEvent(true)); // refresh, e.g. another burst

      await advance(4000);
      // Would have expired at 5000ms from the FIRST event (already past), but
      // the refresh at t=4000 restarts the window — still typing at t=8000.
      expect(result.current.isOtherPartyTyping).toBe(true);

      await advance(1000);
      expect(result.current.isOtherPartyTyping).toBe(false);
    });
  });
});
