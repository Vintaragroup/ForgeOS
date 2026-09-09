// Shared between company-field-with-create.tsx ("use client") and
// opportunities/actions.ts ("use server") -- deliberately its own plain
// module rather than exported from the client component: a value crossing
// the client/server boundary needs to live somewhere neither side's own
// "use client"/"use server" directive applies to. Confirmed live as a
// real bug, not a theoretical one -- exporting this from the client
// component and importing it into the server action produced a
// foreign-key violation on every "+ New client" submission (the server
// action's own comparison against the imported value never matched,
// leaving companyId as the literal sentinel string instead of resolving
// to a real Company row).
export const NEW_COMPANY_VALUE = "__new__";
