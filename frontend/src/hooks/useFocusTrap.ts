// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

// Open traps, innermost last. Only the innermost one handles keys, so a
// dialog opened from inside another dialog owns Tab and Escape.
const openTraps: object[] = [];

function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.closest('[aria-hidden="true"]')
  );
}

type Options = {
  /** Called on Escape. Omit to leave Escape unhandled. */
  onEscape?: () => void;
  /** Element to focus on open. Defaults to the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
};

/**
 * Marks siblings of every ancestor between `container` and `document.body`
 * as `inert` and `aria-hidden="true"` so screen readers and pointer/focus
 * traversal cannot reach background content while the dialog is open.
 */
function markBackgroundInert(container: HTMLElement): () => void {
  const restored: Array<{
    el: HTMLElement;
    hadInert: boolean;
    prevAriaHidden: string | null;
  }> = [];
  const seen = new Set<HTMLElement>();

  let node: HTMLElement | null = container;
  while (node && node !== document.body && node.parentElement) {
    const parent: HTMLElement = node.parentElement;
    for (const child of Array.from(parent.children)) {
      if (!(child instanceof HTMLElement) || child === node || seen.has(child)) {
        continue;
      }
      const tag = child.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "link") {
        continue;
      }
      if (child.getAttribute("aria-live") || child.querySelector("[aria-live]")) {
        continue;
      }
      seen.add(child);
      restored.push({
        el: child,
        hadInert: child.hasAttribute("inert"),
        prevAriaHidden: child.getAttribute("aria-hidden"),
      });
      child.setAttribute("inert", "");
      child.setAttribute("aria-hidden", "true");
    }
    node = parent;
  }

  return () => {
    for (const { el, hadInert, prevAriaHidden } of restored) {
      if (!hadInert) {
        el.removeAttribute("inert");
      }
      if (prevAriaHidden === null) {
        el.removeAttribute("aria-hidden");
      } else {
        el.setAttribute("aria-hidden", prevAriaHidden);
      }
    }
  };
}

/**
 * Keeps keyboard focus inside `containerRef` while `active`, closes on Escape,
 * marks background content `inert` and `aria-hidden="true"`, and returns focus
 * to the element that opened the dialog when it closes.
 * The container should have `tabIndex={-1}` so it can hold focus when it has
 * no focusable children.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  { onEscape, initialFocusRef }: Options = {}
) {
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) return;

    const trap = {};
    openTraps.push(trap);
    const opener = document.activeElement as HTMLElement | null;
    const restoreBackground = markBackgroundInert(container);

    if (!container.contains(document.activeElement)) {
      (initialFocusRef?.current ?? focusableIn(container)[0] ?? container).focus();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (openTraps[openTraps.length - 1] !== trap || !container) return;

      if (event.key === "Escape" && onEscapeRef.current) {
        event.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const items = focusableIn(container);
      if (items.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      const outside = !container.contains(current);

      if (event.shiftKey && (current === first || current === container || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreBackground();
      openTraps.splice(openTraps.indexOf(trap), 1);
      if (opener && opener !== document.body && document.contains(opener)) {
        opener.focus();
      }
    };
  }, [active, containerRef, initialFocusRef]);
}
