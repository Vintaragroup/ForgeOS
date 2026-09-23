import { describe, expect, it } from "vitest";
import {
  buildRevisionChains,
  revisionNumber,
  revisionPair,
  validateSupersedes,
  type RevisionNode,
} from "@/lib/document-revisions";

let clock = 0;
function doc(id: string, supersedesId: string | null = null): RevisionNode {
  clock += 1000;
  return { id, filename: `${id}.pdf`, supersedesId, createdAt: new Date(clock) };
}

describe("chains", () => {
  it("numbers a chain oldest first, so position reads as the version", () => {
    const v1 = doc("v1");
    const v2 = doc("v2", "v1");
    const v3 = doc("v3", "v2");
    const [chain] = buildRevisionChains([v3, v1, v2]);
    expect(chain.documents.map((d) => d.id)).toEqual(["v1", "v2", "v3"]);
    expect(chain.current.id).toBe("v3");
    expect(revisionNumber(chain, "v1")).toBe(1);
    expect(revisionNumber(chain, "v3")).toBe(3);
  });

  it("treats a document standing alone as its own chain at V1", () => {
    const [chain] = buildRevisionChains([doc("only")]);
    expect(chain.documents).toHaveLength(1);
    expect(revisionNumber(chain, "only")).toBe(1);
  });

  it("keeps unrelated documents in separate chains", () => {
    const chains = buildRevisionChains([doc("av1"), doc("av2", "av1"), doc("graphics1")]);
    expect(chains).toHaveLength(2);
    expect(chains.map((c) => c.current.id).sort()).toEqual(["av2", "graphics1"]);
  });

  it("never loses a document, even from a cycle that has no head", () => {
    // Impossible through the UI, but worth holding: in a cycle every
    // document is superseded by another, so walking heads alone found
    // nothing and both documents would have rendered on no screen at
    // all. A wrong version label is recoverable; a vanished document
    // is not.
    const a = doc("a", "b");
    const b = doc("b", "a");
    const chains = buildRevisionChains([a, b]);
    const seen = chains.flatMap((c) => c.documents.map((d) => d.id)).sort();
    expect(seen).toEqual(["a", "b"]);
  });

  it("puts every document in exactly one chain", () => {
    const docs = [doc("v1"), doc("v2", "v1"), doc("solo"), doc("x"), doc("y", "x")];
    const chains = buildRevisionChains(docs);
    const seen = chains.flatMap((c) => c.documents.map((d) => d.id));
    expect(seen.sort()).toEqual(["solo", "v1", "v2", "x", "y"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("ignores a supersedes pointing outside the set", () => {
    const orphan = doc("orphan", "not-here");
    const [chain] = buildRevisionChains([orphan]);
    expect(chain.documents.map((d) => d.id)).toEqual(["orphan"]);
  });
});

describe("the pair a diff runs on", () => {
  it("is the document and the one it replaced", () => {
    const docs = [doc("v1"), doc("v2", "v1")];
    expect(revisionPair(docs, "v2")).toMatchObject({ current: { id: "v2" }, previous: { id: "v1" } });
  });

  it("is nothing for an original", () => {
    expect(revisionPair([doc("v1")], "v1")).toBeNull();
  });
});

describe("validateSupersedes", () => {
  it("refuses a document superseding itself", () => {
    const docs = [doc("a")];
    expect(validateSupersedes(docs, "a", "a")).toMatch(/itself/i);
  });

  it("refuses a link that would make a loop", () => {
    const docs = [doc("a"), doc("b", "a")];
    // b already replaces a; pointing a at b closes the circle.
    expect(validateSupersedes(docs, "a", "b")).toMatch(/at each other/i);
  });

  it("refuses two documents claiming the same predecessor", () => {
    // A chain has to stay a line, or "which is current" has no answer.
    const docs = [doc("v1"), doc("v2", "v1"), doc("other")];
    expect(validateSupersedes(docs, "other", "v1")).toMatch(/already replaces/i);
  });

  it("refuses a document from another opportunity", () => {
    expect(validateSupersedes([doc("a")], "a", "elsewhere")).toMatch(/isn't on this opportunity/i);
  });

  it("allows a clean link", () => {
    const docs = [doc("v1"), doc("v2")];
    expect(validateSupersedes(docs, "v2", "v1")).toBeNull();
  });

  it("allows clearing the link", () => {
    expect(validateSupersedes([doc("a")], "a", null)).toBeNull();
  });
});
