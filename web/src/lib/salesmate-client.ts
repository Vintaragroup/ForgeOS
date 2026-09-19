// Thin read-only client for Salesmate's v4 search API -- the only calls the
// sync (salesmate-sync.ts) makes. Field names were confirmed live against
// the real account (2026-09-19); nested objects (owner, primaryCompany,
// primaryContact) only come back when their sub-fields are requested by
// name ("deal.owner.name"), not as a whole ("deal.owner").
//
// Auth: SALESMATE_ACCESS_TOKEN is the Session Key (My Account -> Access
// Key in Salesmate), sent as `accessToken` + `x-linkname` headers -- same
// as scripts/import-salesmate-users.ts.

export interface SalesmateCompanyRow {
  id: number;
  name: string | null;
  type: string | null;
  phone: string | null;
  website: string | null;
  billingAddressLine1: string | null;
  billingAddressLine2: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZipCode: string | null;
  billingCountry: string | null;
  owner: { id?: number; name?: string } | null;
  lastCommunicationAt: number | null; // unix seconds
  lastCommunicationMode: string | null;
  lastCommunicationBy: string | null;
}

export interface SalesmateContactRow {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  designation: string | null;
  company: { id?: number; name?: string } | null;
  lastCommunicationAt: number | null;
  lastCommunicationMode: string | null;
  lastCommunicationBy: string | null;
}

export interface SalesmateDealRow {
  id: number;
  title: string | null;
  status: string | null;
  pipeline: string | null;
  stage: string | null;
  dealValue: string | number | null;
  owner: { id?: number; name?: string } | null;
  primaryCompany: { id?: number; name?: string } | null;
  primaryContact: { id?: number; name?: string } | null;
  createdAt: number | null; // unix seconds
  closedDate: number | null; // unix seconds
  estimatedCloseDate: string | null; // ISO date string
  lastCommunicationAt: number | null;
}

const COMPANY_FIELDS = [
  "id", "name", "type", "phone", "website",
  "billingAddressLine1", "billingAddressLine2", "billingCity", "billingState", "billingZipCode", "billingCountry",
  "owner.id", "owner.name",
  "lastCommunicationAt", "lastCommunicationMode", "lastCommunicationBy",
].map((f) => `company.${f}`);

const CONTACT_FIELDS = [
  "id", "name", "email", "phone", "mobile", "designation",
  "company.id", "company.name",
  "lastCommunicationAt", "lastCommunicationMode", "lastCommunicationBy",
].map((f) => `contact.${f}`);

const DEAL_FIELDS = [
  "id", "title", "status", "pipeline", "stage", "dealValue",
  "owner.id", "owner.name", "primaryCompany.id", "primaryCompany.name", "primaryContact.id", "primaryContact.name",
  "createdAt", "closedDate", "estimatedCloseDate", "lastCommunicationAt",
].map((f) => `deal.${f}`);

export class SalesmateConfigError extends Error {}

export interface SalesmateFetcher {
  companies(): Promise<SalesmateCompanyRow[]>;
  contacts(): Promise<SalesmateContactRow[]>;
  deals(): Promise<SalesmateDealRow[]>;
}

function config() {
  const rawDomain = process.env.SALESMATE_DOMAIN;
  const accessToken = process.env.SALESMATE_ACCESS_TOKEN;
  if (!rawDomain || !accessToken) {
    throw new SalesmateConfigError(
      "Salesmate isn't configured on this server -- SALESMATE_DOMAIN and SALESMATE_ACCESS_TOKEN must both be set.",
    );
  }
  const domain = rawDomain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.salesmate\.io$/, "");
  return { domain, accessToken };
}

// Salesmate caps a page at 250 rows (asking for more silently returns 250).
const PAGE_SIZE = 250;
// Offset paging isn't stable on Salesmate's side: confirmed live
// (2026-09-19) that paging the 359 real deals returned only 315-346
// distinct ids per pass -- some rows repeat, others never appear -- even
// with an explicit sort. Its filter API (which would allow proper "id >
// last" keyset paging) rejected every rule format tried. So: page through
// repeatedly, union by id, and stop once we've seen as many distinct rows
// as Salesmate's own totalRows (two passes sufficed in practice). If that
// never happens, fail loudly -- a sync that silently misses rows would also
// wrongly mark them "removed".
const MAX_PASSES = 8;
const MAX_PAGES_PER_PASS = 100;

async function searchAll<T extends { id: number }>(module: "company" | "contact" | "deal", fields: string[]): Promise<T[]> {
  const { domain, accessToken } = config();
  const byId = new Map<number, T>();
  let totalRows = 0;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    for (let page = 0; page < MAX_PAGES_PER_PASS; page++) {
      const res = await fetch(
        `https://${domain}.salesmate.io/apis/${module}/v4/search?rows=${PAGE_SIZE}&from=${page * PAGE_SIZE}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            accessToken,
            "x-linkname": `${domain}.salesmate.io`,
          },
          body: JSON.stringify({
            displayingFields: fields,
            filterQuery: { group: { operator: "AND", rules: [] } },
            sort: { fieldName: `${module}.id`, order: "asc" },
            moduleId: 0,
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const body = await res.text();
      let json: { Data?: { data?: T[]; totalRows?: number }; Error?: { Message?: string; message?: string; Name?: string } };
      try {
        json = JSON.parse(body);
      } catch {
        throw new Error(`Salesmate ${module} search returned HTTP ${res.status} with a non-JSON body.`);
      }
      if (!res.ok || !json.Data?.data) {
        const reason = json.Error?.Message ?? json.Error?.message ?? json.Error?.Name ?? `HTTP ${res.status}`;
        throw new Error(`Salesmate ${module} search failed: ${reason}`);
      }
      totalRows = Math.max(totalRows, json.Data.totalRows ?? 0);
      for (const row of json.Data.data) byId.set(row.id, row);
      if (json.Data.data.length < PAGE_SIZE) break;
    }
    if (byId.size >= totalRows) return [...byId.values()];
  }
  throw new Error(
    `Salesmate ${module} search only returned ${byId.size} of ${totalRows} records after ${MAX_PASSES} passes -- ` +
      "stopping rather than syncing an incomplete list.",
  );
}

export const salesmateApi: SalesmateFetcher = {
  companies: () => searchAll<SalesmateCompanyRow>("company", COMPANY_FIELDS),
  contacts: () => searchAll<SalesmateContactRow>("contact", CONTACT_FIELDS),
  deals: () => searchAll<SalesmateDealRow>("deal", DEAL_FIELDS),
};

export function isSalesmateConfigured(): boolean {
  return Boolean(process.env.SALESMATE_DOMAIN && process.env.SALESMATE_ACCESS_TOKEN);
}
