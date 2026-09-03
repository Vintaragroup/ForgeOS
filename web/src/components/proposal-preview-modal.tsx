"use client";

import { useState } from "react";
import { Button, SelectField } from "@/components/ui";
import { Modal } from "@/components/modal";

// Replaces the old plain `<form target="_blank">` "Preview PDF" button --
// same underlying route (estimates/[id]/versions/[versionId]/preview-pdf),
// just opened in a modal instead of a new tab.
//
// Used to also carry per-export category reorder/hide-pricing/summary-only
// controls (categoryOrder, hidePricing, summary on that route), but booth
// order, visibility ("Show on proposal"), and detail-summarization
// ("Summarize on proposal") are now persistent, real controls on the Line
// Items tab itself (see estimate-service.ts's updateSectionProposalOrder/
// updateSectionProposalVisibility/updateSectionProposalSummary) -- so this
// is just a straight PDF viewer now: whatever the Line Items tab currently
// shows is what renders here, no separate export-time configuration step.
export function ProposalPreviewModal({
  estimateId,
  versionId,
  proposalTemplates,
}: {
  estimateId: string;
  versionId: string;
  // Caller only renders this component once proposalTemplates.length > 0
  // (see VersionSummaryBar's own empty-state Notice for the alternative).
  proposalTemplates: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState(proposalTemplates[0]?.id ?? "");

  const src = `/estimates/${estimateId}/versions/${versionId}/preview-pdf?templateId=${encodeURIComponent(templateId)}`;

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
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Preview PDF
        </Button>
      </div>

      {open && (
        <Modal title="Proposal PDF preview" onClose={() => setOpen(false)}>
          <div className="flex h-full min-h-[70vh] flex-col">
            {/* The iframe's own embedded PDF viewer already has zoom/pan --
                "Open in new tab" gives the browser's full, un-cramped native
                PDF viewer instead, and `download` on a same-origin link
                saves the file directly regardless of the route's own inline
                Content-Disposition header. */}
            <div className="flex items-center justify-end gap-3 border-b border-neutral-200 px-3 py-1.5">
              <a href={src} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-brand-navy hover:underline">
                Open in new tab ↗
              </a>
              <a href={src} download className="text-xs font-medium text-brand-navy hover:underline">
                Download PDF
              </a>
            </div>
            <iframe key={src} src={src} className="h-full w-full flex-1" title="Proposal PDF preview" />
          </div>
        </Modal>
      )}
    </>
  );
}
