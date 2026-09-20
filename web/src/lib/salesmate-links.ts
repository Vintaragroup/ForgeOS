// Deep links into Salesmate's own web app, so a row on a ForgeOS page can
// hand the rep straight to the record they need to update. ForgeOS only
// reads from Salesmate (see salesmate-sync.ts), so "do the thing" still
// happens over there until write-back exists.
//
// SALESMATE_DOMAIN is server-only, and these links are built in server
// components -- returning "" when it isn't configured lets a caller drop
// the button rather than render a broken link.
const PATHS = {
  company: "companies",
  contact: "contacts",
  deal: "deals",
  activity: "activities",
} as const;

export function salesmateRecordUrl(kind: keyof typeof PATHS, salesmateId: string): string {
  const raw = process.env.SALESMATE_DOMAIN;
  if (!raw || !salesmateId) return "";
  const domain = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.salesmate\.io$/, "");
  return `https://${domain}.salesmate.io/${PATHS[kind]}/${salesmateId}`;
}
