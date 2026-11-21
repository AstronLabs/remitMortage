// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface SortableWidgetProps {
  id: string;
  /** Human-readable widget name, used for the drag and hide controls' labels. */
  label?: string;
  /** When provided, shows a hide control next to the drag handle. */
  onHide?: () => void;
  children: React.ReactNode;
}

export function SortableWidget({ id, label, onHide, children }: SortableWidgetProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : 1,
    position: 'relative' as const,
  };

  return (
    <div ref={setNodeRef} style={style} className="relative group w-full">
      {onHide && (
        <button
          type="button"
          onClick={onHide}
          aria-label={label ? `Hide ${label}` : 'Hide widget'}
          title="Hide widget"
          className="absolute top-2 right-11 p-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity z-20 text-slate-400 hover:text-white bg-slate-800/90 border border-slate-700 rounded shadow-lg backdrop-blur"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <path d="M1 1l22 22" />
          </svg>
        </button>
      )}
      <div
        {...attributes}
        {...listeners}
        aria-label={label ? `Reorder ${label}` : undefined}
        className="absolute top-2 right-2 p-1.5 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity z-20 text-slate-400 hover:text-white bg-slate-800/90 border border-slate-700 rounded shadow-lg backdrop-blur"
        title="Drag to reorder"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="9" cy="5" r="1"/>
          <circle cx="9" cy="12" r="1"/>
          <circle cx="9" cy="19" r="1"/>
          <circle cx="15" cy="5" r="1"/>
          <circle cx="15" cy="12" r="1"/>
          <circle cx="15" cy="19" r="1"/>
        </svg>
      </div>
      {children}
    </div>
  );
}
