"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

interface VirtualizedTableProps<T> {
  items: T[];
  getItemKey: (item: T) => string;
  ariaLabel: string;
  header: React.ReactNode;
  renderRow: (
    item: T,
    index: number,
    tabIndex: number,
    ariaRowIndex: number,
    selected: boolean
  ) => React.ReactElement;
  columnCount: number;
  selectedKeys?: ReadonlySet<string>;
  rowHeight?: number;
  viewportHeight?: number;
  overscan?: number;
  className?: string;
}

export default function VirtualizedTable<T>({
  items,
  getItemKey,
  ariaLabel,
  header,
  renderRow,
  columnCount,
  selectedKeys,
  rowHeight = 58,
  viewportHeight = 576,
  overscan = 5,
  className,
}: VirtualizedTableProps<T>) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const previousItemsRef = useRef(items);
  const pendingFocusIndexRef = useRef<number | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const visibleHeight = viewportHeight;
  const firstVisibleIndex = Math.floor(scrollTop / rowHeight);
  const startIndex = Math.max(0, firstVisibleIndex - overscan);
  const endIndex = Math.min(
    items.length,
    Math.ceil((scrollTop + visibleHeight) / rowHeight) + overscan
  );
  const tabStopIndex =
    activeIndex !== null && activeIndex >= startIndex && activeIndex < endIndex
      ? activeIndex
      : startIndex;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const updateScrollPosition = () => setScrollTop(viewport.scrollTop);
    viewport.addEventListener("scroll", updateScrollPosition, { passive: true });
    return () => viewport.removeEventListener("scroll", updateScrollPosition);
  }, []);

  useLayoutEffect(() => {
    const previousItems = previousItemsRef.current;
    if (previousItems !== items) {
      const viewport = viewportRef.current;
      if (viewport && previousItems.length > 0) {
        const oldIndex = Math.min(
          Math.floor(viewport.scrollTop / rowHeight),
          previousItems.length - 1
        );
        const anchorKey = getItemKey(previousItems[oldIndex]);
        const newIndex = items.findIndex((item) => getItemKey(item) === anchorKey);
        if (newIndex >= 0 && newIndex !== oldIndex) {
          const offset = viewport.scrollTop - oldIndex * rowHeight;
          viewport.scrollTop = newIndex * rowHeight + offset;
          setScrollTop(viewport.scrollTop);
        }
      }

      if (activeIndex !== null && previousItems[activeIndex]) {
        const activeKey = getItemKey(previousItems[activeIndex]);
        const nextActiveIndex = items.findIndex((item) => getItemKey(item) === activeKey);
        setActiveIndex(nextActiveIndex >= 0 ? nextActiveIndex : null);
      }
      previousItemsRef.current = items;
    }
  }, [activeIndex, getItemKey, items, rowHeight]);

  useLayoutEffect(() => {
    const pendingFocusIndex = pendingFocusIndexRef.current;
    if (pendingFocusIndex === null) return;

    const target = viewportRef.current?.querySelector<HTMLElement>(
      `[data-virtualized-row-index="${pendingFocusIndex}"]`
    );
    target?.focus();
    pendingFocusIndexRef.current = null;
  }, [activeIndex, endIndex, startIndex]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const target = event.target as HTMLElement;
    const currentIndex = Number(target.dataset.virtualizedRowIndex);
    if (!Number.isInteger(currentIndex)) return;

    const nextIndex = currentIndex + (event.key === "ArrowDown" ? 1 : -1);
    if (nextIndex < 0 || nextIndex >= items.length) return;

    event.preventDefault();
    pendingFocusIndexRef.current = nextIndex;
    setActiveIndex(nextIndex);

    const viewport = viewportRef.current;
    if (viewport) {
      const rowTop = nextIndex * rowHeight;
      if (rowTop < viewport.scrollTop) {
        viewport.scrollTop = rowTop;
      } else if (rowTop + rowHeight > viewport.scrollTop + visibleHeight) {
        viewport.scrollTop = rowTop + rowHeight - visibleHeight;
      }
      setScrollTop(viewport.scrollTop);
    }
  }

  return (
    <div
      ref={viewportRef}
      onKeyDown={handleKeyDown}
      className="overflow-auto"
      style={{ height: viewportHeight }}
      data-testid="virtualized-table-viewport"
    >
      <table
        aria-label={ariaLabel}
        aria-rowcount={items.length + 1}
        className={className}
      >
        {header}
        <tbody>
          {startIndex > 0 && (
            <tr aria-hidden="true" role="presentation">
              <td
                colSpan={columnCount}
                style={{ height: startIndex * rowHeight, padding: 0, border: 0 }}
              />
            </tr>
          )}
          {items.slice(startIndex, endIndex).map((item, offset) => {
            const index = startIndex + offset;
            const tabIndex = index === tabStopIndex ? 0 : -1;
            return (
              <React.Fragment key={getItemKey(item)}>
                {renderRow(
                  item,
                  index,
                  tabIndex,
                  index + 2,
                  selectedKeys?.has(getItemKey(item)) ?? false
                )}
              </React.Fragment>
            );
          })}
          {endIndex < items.length && (
            <tr aria-hidden="true" role="presentation">
              <td
                colSpan={columnCount}
                style={{
                  height: (items.length - endIndex) * rowHeight,
                  padding: 0,
                  border: 0,
                }}
              />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
