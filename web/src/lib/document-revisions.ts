// Document revision chains: which document replaces which, and what that
// makes each one.
//
// The ask was to tag documents "V1" and "V2" by hand. Modelling the
// RELATIONSHIP instead and deriving the label means it cannot drift: type
// the numbers yourself and the first person to upload a third revision
// and call it V2 leaves two documents both claiming V2, with nothing able
// to say which is newer. From a supersedes link, all of it falls out --
// the version number is the depth of the chain, the current document is
// the one nothing supersedes, and the pair to diff is any document and
// its predecessor.
//
// A leaf module: pure functions over plain rows, no db import.

export interface RevisionNode {
  id: string;
  filename: string;
  supersedesId: string | null;
  createdAt: Date;
}

export interface RevisionChain<T extends RevisionNode> {
  // Oldest first, so index + 1 is the version number a person would say.
  documents: T[];
  current: T;
}

// Every chain among these documents, keyed by the id of the newest
// document in each. A document with no supersedes link and nothing
// superseding it is a chain of one, which is the normal case and not a
// special one.
export function buildRevisionChains<T extends RevisionNode>(documents: T[]): RevisionChain<T>[] {
  const byId = new Map(documents.map((d) => [d.id, d]));
  // A document can only be superseded once; if two claim the same
  // predecessor, the older claim wins and the other is treated as its own
  // chain rather than silently dropped.
  const successorOf = new Map<string, T>();
  for (const doc of [...documents].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (!doc.supersedesId) continue;
    if (!byId.has(doc.supersedesId)) continue;
    if (successorOf.has(doc.supersedesId)) continue;
    successorOf.set(doc.supersedesId, doc);
  }

  // A head is a document nothing in this set supersedes.
  const isSuperseded = new Set(successorOf.keys());
  const chains: RevisionChain<T>[] = [];

  for (const doc of documents) {
    if (isSuperseded.has(doc.id)) continue;
    // Walk back to the original, then reverse: the caller wants oldest
    // first so position reads as a version number.
    const backwards: T[] = [doc];
    const seen = new Set<string>([doc.id]);
    let cursor: T | undefined = doc;
    while (cursor?.supersedesId) {
      const prev: T | undefined = byId.get(cursor.supersedesId);
      // A cycle cannot happen through the UI, but a chain that ate its
      // own tail would hang the loop rather than produce a bad label.
      if (!prev || seen.has(prev.id)) break;
      backwards.push(prev);
      seen.add(prev.id);
      cursor = prev;
    }
    backwards.reverse();
    chains.push({ documents: backwards, current: doc });
  }

  // Every document has to come out somewhere. A cycle has no head at all
  // -- each of its documents is superseded by another -- so walking heads
  // alone returned nothing and the documents would have rendered on no
  // screen. Anything not yet placed becomes its own chain: a wrong
  // version label is recoverable, a document that disappears from the
  // page is not.
  const placed = new Set(chains.flatMap((c) => c.documents.map((d) => d.id)));
  for (const doc of documents) {
    if (placed.has(doc.id)) continue;
    placed.add(doc.id);
    chains.push({ documents: [doc], current: doc });
  }

  return chains;
}

// "V2" -- one-based position in its own chain. A document standing alone
// is V1, which is true and not worth hiding.
export function revisionNumber<T extends RevisionNode>(chain: RevisionChain<T>, documentId: string): number | null {
  const index = chain.documents.findIndex((d) => d.id === documentId);
  return index === -1 ? null : index + 1;
}

// The pair a diff runs on: a document and the one it replaced. Null for
// an original, which has nothing to be compared against.
export function revisionPair<T extends RevisionNode>(
  documents: T[],
  documentId: string,
): { current: T; previous: T } | null {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const current = byId.get(documentId);
  if (!current?.supersedesId) return null;
  const previous = byId.get(current.supersedesId);
  return previous ? { current, previous } : null;
}

// Refuses a link that would corrupt the chain. Returned as a message
// rather than thrown so the caller can show it on the form.
export function validateSupersedes<T extends RevisionNode>(
  documents: T[],
  documentId: string,
  supersedesId: string | null,
): string | null {
  if (!supersedesId) return null;
  if (supersedesId === documentId) return "A document can't supersede itself.";

  const byId = new Map(documents.map((d) => [d.id, d]));
  if (!byId.has(supersedesId)) return "That document isn't on this opportunity.";

  // Walking forward from the target must not arrive back at this
  // document, which would make the chain a loop with no original.
  let cursor = byId.get(supersedesId);
  const seen = new Set<string>();
  while (cursor?.supersedesId) {
    if (cursor.supersedesId === documentId) return "That would point the two documents at each other.";
    if (seen.has(cursor.supersedesId)) break;
    seen.add(cursor.supersedesId);
    cursor = byId.get(cursor.supersedesId);
  }

  const alreadyTaken = documents.find((d) => d.id !== documentId && d.supersedesId === supersedesId);
  if (alreadyTaken) {
    return `${alreadyTaken.filename} already replaces that document -- supersede that one instead, so the chain stays a line.`;
  }
  return null;
}
