"use client";

import { ActionForm } from "@/components/action-form";
import { Popover, ROW_BUTTON_CLASS as BUTTON_CLASS } from "@/components/row-popover";
import { SNOOZE_PRESETS, TOUCH_MODES, type SalesQueueKey } from "@/lib/sales-queue";
import { confirmActivityAction, logTouchAction, snoozeAction } from "@/app/(app)/sales/actions";

// The buttons that let a rep clear a queue row from the row itself. The
// popover they open lives in row-popover.tsx, shared with Graphics.
//
// These render inside a DashRow's `actions` slot.

export function LogTouchButton({ companyId, companyName }: { companyId: string; companyName: string }) {
  return (
    <Popover label="Log touch" title={`Log contact with ${companyName}`}>
      {(close) => (
        <ActionForm action={logTouchAction} className="flex flex-col gap-2" resetOnSuccess>
          <input type="hidden" name="companyId" value={companyId} />
          <select name="mode" className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm" defaultValue="Call">
            {TOUCH_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <textarea
            name="note"
            rows={2}
            placeholder="What was said? (optional)"
            className="resize-none rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
          />
          <button type="submit" onClick={() => setTimeout(close, 0)} className="rounded-md bg-brand-black px-3 py-1.5 text-sm font-medium text-white">
            Log it
          </button>
        </ActionForm>
      )}
    </Popover>
  );
}

export function SnoozeButton({ queue, targetKey }: { queue: SalesQueueKey; targetKey: string }) {
  return (
    <Popover label="Snooze" title="Hide this until">
      {(close) => (
        <ActionForm action={snoozeAction} className="flex flex-col gap-2">
          <input type="hidden" name="queue" value={queue} />
          <input type="hidden" name="targetKey" value={targetKey} />
          <div className="grid grid-cols-2 gap-1.5">
            {SNOOZE_PRESETS.map((p) => (
              <button
                key={p.days}
                type="submit"
                name="days"
                value={p.days}
                onClick={() => setTimeout(close, 0)}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-xs font-medium text-neutral-700 hover:border-neutral-500"
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] leading-snug text-neutral-500">Only hidden for you. It comes back on its own.</p>
        </ActionForm>
      )}
    </Popover>
  );
}

export function ConfirmActivityButton({ salesmateId }: { salesmateId: string }) {
  return (
    <ActionForm action={confirmActivityAction}>
      <input type="hidden" name="salesmateId" value={salesmateId} />
      <button type="submit" className={BUTTON_CLASS} title="Mark this as done and record it as contact">
        It happened
      </button>
    </ActionForm>
  );
}
