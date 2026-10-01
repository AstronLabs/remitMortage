"use client";
import React, { useMemo } from "react";
import { DndContext, DragEndEvent, useDraggable, useDroppable } from "@dnd-kit/core";

export interface KanbanLoan {
  id: string;
  borrower: string;
  principal: number;
  verificationScore: number;
  status: string;
  daysInStatus: number;
}

interface KanbanBoardProps {
  loans: KanbanLoan[];
  onStatusChange: (loanId: string, newStatus: string) => void;
}

const COLUMNS = ["submitted", "underwriting", "approved", "disbursing"];

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatUsdc(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function LoanKanbanBoard({ loans, onStatusChange }: KanbanBoardProps) {
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    
    const loanId = String(active.id);
    const newStatus = String(over.id);
    
    const loan = loans.find(l => l.id === loanId);
    if (loan && loan.status !== newStatus) {
      onStatusChange(loanId, newStatus);
    }
  };

  const columnsMap = useMemo(() => {
    const map: Record<string, KanbanLoan[]> = {};
    COLUMNS.forEach(col => {
      map[col] = [];
    });
    loans.forEach(loan => {
      const s = loan.status.toLowerCase();
      if (map[s]) {
        map[s].push(loan);
      } else {
        // Fallback for loans with unknown statuses
        map["submitted"].push(loan);
      }
    });
    return map;
  }, [loans]);

  return (
    <DndContext onDragEnd={handleDragEnd}>
      <div className="flex gap-4 overflow-x-auto pb-4">
        {COLUMNS.map((col) => (
          <KanbanColumn key={col} id={col} title={col} loans={columnsMap[col]} />
        ))}
      </div>
    </DndContext>
  );
}

function KanbanColumn({ id, title, loans }: { id: string; title: string; loans: KanbanLoan[] }) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col w-72 shrink-0 rounded-xl border p-3 min-h-[500px] transition-colors ${
        isOver ? "bg-slate-800/80 border-cyan-500/50" : "bg-slate-900/50 border-slate-800"
      }`}
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-slate-300 uppercase text-xs tracking-wider">{title}</h3>
        <span className="text-xs font-semibold bg-slate-800 px-2 py-0.5 rounded-full text-slate-400">
          {loans.length}
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {loans.map(loan => (
          <KanbanCard key={loan.id} loan={loan} />
        ))}
      </div>
    </div>
  );
}

function KanbanCard({ loan }: { loan: KanbanLoan }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: loan.id,
  });

  const style = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        zIndex: 50,
      }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={style}
      className={`p-3 rounded-lg border bg-slate-800/80 hover:bg-slate-800 cursor-grab active:cursor-grabbing ${
        isDragging ? "opacity-50 ring-2 ring-cyan-500" : "border-slate-700 shadow-sm"
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-xs text-slate-200 font-semibold">{shortenAddress(loan.borrower)}</span>
        <span className="text-[10px] text-slate-400 font-medium">{loan.daysInStatus} days in stage</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-white">{formatUsdc(loan.principal)}</span>
        <span className="text-xs font-semibold px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400">
          Score: {loan.verificationScore}
        </span>
      </div>
    </div>
  );
}
