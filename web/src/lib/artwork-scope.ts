// Which artwork orders count as live work.
//
// A leaf module -- it imports nothing, so the SLA sweep and the calendar
// can use it without pulling in the Graphics Hub.
//
// The distinction exists because importing a past show put its graphics
// into the system looking like today's jobs. After the PGA control-log
// import, production held 370 orders sitting in PACKAGED_READY ("packed,
// waiting to ship") and 25 more spread across IN_PRODUCTION and friends --
// every one of them created on the import date, none of them real work.
//
// See ArtworkOrder.archivedAt for why this is a separate field rather than
// a terminal status.

// Spread into the `where` of any query that answers "what is there to do?"
// -- the Graphics Hub listing, the artwork list, the SLA sweep, the
// calendar feed.
export const ACTIVE_ARTWORK_ORDER = { deletedAt: null, archivedAt: null } as const;

// Deliberately NOT applied to:
//
//   - the post-show page, which says in its own comment that it wants
//     bulk-imported history alongside live pieces;
//   - analytics, where past shows are the comparison being drawn;
//   - any /artwork/[id] detail page or portal view, since an archived
//     piece still has to open;
//   - rollover's source lookups, because rolling last year's piece into
//     this year's occurrence is the entire point of keeping the history.
//
// If a new "what's outstanding" surface appears, it spreads
// ACTIVE_ARTWORK_ORDER. If a new history surface appears, it does not.
export const ARCHIVED_ARTWORK_ORDER = { deletedAt: null, archivedAt: { not: null } } as const;
