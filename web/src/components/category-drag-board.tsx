"use client";

import { useRef, useState, type DragEvent } from "react";

// Eighth client component (see document-upload-form.tsx's header comment
// on the fourth; project-type-fields.tsx, labor-rate-line-item-picker.tsx,
// and line-item-row.tsx on the fifth/sixth/seventh). Native HTML5
// drag-and-drop, same choice as document-upload-form.tsx's file drop zone
// -- no DnD library is a project dependency, and this app already has a
// working hand-rolled precedent.
//
// Reorganizes/regroups by CATEGORY specifically (the proposal-facing
// grouping line-item-category.ts defines), not by EstimateSection (the
// production/build-tracking grouping COMPONENT 1 etc. still uses) -- see
// the schema comment on LineItem.sortOrder. Dragging a card to a new
// column sets that item's `category`; dragging within/between columns
// reorders live in local state, and only the destination column's final
// order is persisted on drop (reorderCategoryLineItemsAction).
export interface BoardItem {
  id: string;
  description: string;
  totalCostDisplay: string;
}

type Board = Record<string, BoardItem[]>;

export function CategoryDragBoard({
  categories,
  initialBoard,
  reorderAction,
}: {
  categories: string[];
  initialBoard: Board;
  reorderAction: (category: string, orderedLineItemIds: string[]) => void | Promise<void>;
}) {
  const [board, setBoard] = useState(initialBoard);
  // dragover fires many times per second during a real drag, and a fast
  // (e.g. automated) drag can deliver dragover then drop in the same
  // browser task, before React has committed the re-render that would
  // hand handleDrop a fresh closure over `board`. boardRef is updated
  // synchronously alongside every setBoard call specifically so
  // handleDrop (and the dragover handlers themselves) always read the
  // true current state instead of a possibly-stale one -- this is not
  // just style, it was a real bug: the persisted category/order didn't
  // match what the board visually showed at drop time.
  const boardRef = useRef(initialBoard);
  const dragRef = useRef<{ id: string } | null>(null);

  function setBoardSynced(next: Board) {
    boardRef.current = next;
    setBoard(next);
  }

  function findItem(source: Board, id: string): { category: string; index: number } | null {
    for (const category of Object.keys(source)) {
      const index = source[category].findIndex((item) => item.id === id);
      if (index !== -1) return { category, index };
    }
    return null;
  }

  function moveItem(id: string, toCategory: string, toIndex: number) {
    const prev = boardRef.current;
    const next: Board = {};
    let dragged: BoardItem | null = null;
    for (const category of Object.keys(prev)) {
      next[category] = prev[category].filter((item) => {
        if (item.id === id) {
          dragged = item;
          return false;
        }
        return true;
      });
    }
    if (!dragged) return;
    const target = [...next[toCategory]];
    target.splice(toIndex, 0, dragged);
    next[toCategory] = target;
    setBoardSynced(next);
  }

  function handleDragStart(e: DragEvent, id: string) {
    dragRef.current = { id };
    e.dataTransfer.effectAllowed = "move";
    // Required for Firefox to allow the drag to start at all.
    e.dataTransfer.setData("text/plain", id);
  }

  function handleDragOverItem(e: DragEvent, category: string, index: number) {
    e.preventDefault();
    const dragging = dragRef.current;
    if (!dragging) return;
    const current = findItem(boardRef.current, dragging.id);
    if (current && current.category === category && current.index === index) return;
    moveItem(dragging.id, category, index);
  }

  function handleDragOverColumn(e: DragEvent, category: string) {
    e.preventDefault();
    const dragging = dragRef.current;
    if (!dragging) return;
    // Dropping on empty column space -- append to the end, but only when
    // not already the last item there (avoids fighting per-item handlers).
    const current = findItem(boardRef.current, dragging.id);
    const items = boardRef.current[category];
    if (current && current.category === category && current.index === items.length - 1) return;
    moveItem(dragging.id, category, items.length);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    const dragging = dragRef.current;
    dragRef.current = null;
    if (!dragging) return;
    const landed = findItem(boardRef.current, dragging.id);
    if (!landed) return;
    reorderAction(
      landed.category,
      boardRef.current[landed.category].map((item) => item.id),
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {categories.map((category) => (
        <div
          key={category}
          onDragOver={(e) => handleDragOverColumn(e, category)}
          onDrop={handleDrop}
          className="flex w-56 shrink-0 flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-2"
        >
          <div className="px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            {category} <span className="font-normal text-neutral-400">({board[category]?.length ?? 0})</span>
          </div>
          <div className="flex min-h-[2rem] flex-col gap-1.5">
            {(board[category] ?? []).map((item, index) => (
              <div
                key={item.id}
                draggable
                onDragStart={(e) => handleDragStart(e, item.id)}
                onDragOver={(e) => handleDragOverItem(e, category, index)}
                onDrop={handleDrop}
                className="cursor-grab rounded border border-neutral-200 bg-white px-2 py-1.5 text-xs shadow-sm active:cursor-grabbing"
              >
                <div className="line-clamp-2 text-neutral-700">{item.description}</div>
                <div className="mt-0.5 font-medium text-neutral-500">{item.totalCostDisplay}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
