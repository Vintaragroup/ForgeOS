"use client";

import { useState } from "react";
import { Button, SelectField } from "@/components/ui";
import { Modal } from "@/components/modal";

interface CategoryOption {
  id: string;
  name: string;
}

// Replaces the old plain `<form target="_blank">` "Preview PDF" button --
// same underlying route (estimates/[id]/versions/[versionId]/preview-pdf),
// just opened in a modal instead of a new tab, with real control over the
// three ephemeral, per-export view options that route.ts now accepts:
// categoryOrder, hidePricing, summary (see that file's own comment for the
// exact contract). None of this is persisted anywhere -- every control
// here resets the next time the modal opens, matching the route's own
// "live format check against unlocked version data" posture.
//
// `categories` is server-computed by the caller (VersionSummaryBar) to
// only the categories that actually have a real, visible item in this
// version -- never the full live Category catalog -- so this list always
// matches what the PDF could actually show.
export function ProposalPreviewModal({
  estimateId,
  versionId,
  proposalTemplates,
  categories,
}: {
  estimateId: string;
  versionId: string;
  // Caller only renders this component once proposalTemplates.length > 0
  // (see VersionSummaryBar's own empty-state Notice for the alternative).
  proposalTemplates: { id: string; name: string }[];
  categories: CategoryOption[];
}) {
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState(proposalTemplates[0]?.id ?? "");
  const [order, setOrder] = useState<string[]>(() => categories.map((c) => c.id));
  const [hidePricing, setHidePricing] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<Set<string>>(new Set());
  // The iframe only ever points at a src explicitly "applied" via Update
  // preview (or the initial open) -- not rebuilt on every keystroke/click,
  // since each change is a real server-side PDF render, not a cheap local
  // re-render.
  const [appliedSrc, setAppliedSrc] = useState<string | null>(null);

  const byId = new Map(categories.map((c) => [c.id, c]));

  function buildSrc(): string {
    const params = new URLSearchParams();
    params.set("templateId", templateId);
    params.set("categoryOrder", order.join(","));
    if (hidePricing.size > 0) params.set("hidePricing", [...hidePricing].join(","));
    if (summary.size > 0) params.set("summary", [...summary].join(","));
    return `/estimates/${estimateId}/versions/${versionId}/preview-pdf?${params.toString()}`;
  }

  // Deliberately does NOT set appliedSrc here -- opening the modal is
  // exactly the moment someone wants to adjust category order/pricing/
  // detail BEFORE spending a real server-side PDF render, not after.
  // Requiring the first render to also go through "Update preview" (same
  // as every later change) means opening the modal never pays for a
  // render the user might immediately discard.
  function openModal() {
    setOpen(true);
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  }

  function toggle(set: Set<string>, setSet: (s: Set<string>) => void, id: string) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSet(next);
  }

  return (
    <>
      <div className="flex items-end gap-3">
        <div className="w-56">
          <SelectField
            label="Proposal template"
            name="templateId"
            value={templateId}
            onChange={setTemplateId}
            options={proposalTemplates.map((t) => ({ value: t.id, label: t.name }))}
          />
        </div>
        <Button type="button" variant="secondary" onClick={openModal}>
          Preview PDF
        </Button>
      </div>

      {open && (
        <Modal title="Proposal PDF preview" onClose={() => setOpen(false)}>
          <div className="flex h-full min-h-[70vh]">
            <div className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-r border-neutral-200 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Categories -- order, pricing &amp; detail
              </h3>
              {order.length === 0 ? (
                <p className="text-xs text-neutral-400">No priced categories in this version yet.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {order.map((id, i) => {
                    const category = byId.get(id);
                    if (!category) return null;
                    return (
                      <li key={id} className="rounded-md border border-neutral-200 p-2">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">{category.name}</span>
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={() => move(i, -1)}
                              disabled={i === 0}
                              aria-label={`Move ${category.name} up`}
                              className="rounded px-1 text-neutral-500 hover:bg-neutral-100 disabled:opacity-25"
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              onClick={() => move(i, 1)}
                              disabled={i === order.length - 1}
                              aria-label={`Move ${category.name} down`}
                              className="rounded px-1 text-neutral-500 hover:bg-neutral-100 disabled:opacity-25"
                            >
                              ▼
                            </button>
                          </div>
                        </div>
                        <label className="flex items-center gap-1.5 text-xs text-neutral-600">
                          <input
                            type="checkbox"
                            checked={hidePricing.has(id)}
                            onChange={() => toggle(hidePricing, setHidePricing, id)}
                            className="h-3.5 w-3.5 rounded border-neutral-300"
                          />
                          Hide pricing
                        </label>
                        <label className="flex items-center gap-1.5 text-xs text-neutral-600">
                          <input
                            type="checkbox"
                            checked={summary.has(id)}
                            onChange={() => toggle(summary, setSummary, id)}
                            className="h-3.5 w-3.5 rounded border-neutral-300"
                          />
                          Summary only (no line items)
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              <Button type="button" onClick={() => setAppliedSrc(buildSrc())}>
                Update preview
              </Button>
            </div>
            <div className="flex-1">
              {appliedSrc ? (
                <iframe key={appliedSrc} src={appliedSrc} className="h-full w-full" title="Proposal PDF preview" />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-neutral-400">
                  Adjust categories, then click Update preview to generate the PDF.
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
