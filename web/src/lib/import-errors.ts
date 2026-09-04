// Shared by pricing-import-service.ts and vendor-quote-service.ts's two
// "already been imported into this estimate" guards -- broken out into its
// own dependency-free module (rather than defined in either service file
// and imported by the other) because pricing-import-service.ts already
// imports commitStandaloneVendorQuoteImport FROM vendor-quote-service.ts,
// so defining it in either one would make the other side of that import a
// cycle. Lets import-actions.ts's commitImportAction distinguish this one
// recoverable case (offer "Delete & re-import") from every other business
// rejection (no rows found, ...), where deleting nothing and retrying
// wouldn't help, without fragile string-matching on the message text.
export class AlreadyImportedError extends Error {
  constructor(filename: string) {
    super(`"${filename}" has already been imported into this estimate. Delete its existing line items first if you want to re-import.`);
    this.name = "AlreadyImportedError";
  }
}
