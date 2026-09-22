import { describe, expect, it } from "vitest";
import { artworkCitation, buildCitationDirectory, companyCitation, documentCitation, lineItemCitation, renderCitationTokens } from "@/lib/ai/citation-tokens";

const doc = documentCitation("opp1", { id: "doc1", filename: "Schedule A - SBLXI - 006. Final.pdf" });
const item = lineItemCitation({ id: "li1", estimateId: "est1", description: '36 x 84" Compliant Door' });
const company = companyCitation({ id: "co1", name: "Club Glove" });
const targets = [doc, item, company];

describe("renderCitationTokens", () => {
  it("turns a token into a real link however the model phrased the sentence around it", () => {
    const reply = 'The RFP titled "SBLXI - Temporary Booth Build RFP Final" [[doc:doc1]] sets the move-in date.';
    expect(renderCitationTokens(reply, targets)).toBe(
      'The RFP titled "SBLXI - Temporary Booth Build RFP Final" [Schedule A - SBLXI - 006. Final.pdf](/opportunities/opp1/documents/doc1/view) sets the move-in date.',
    );
  });

  it("handles several tokens, including repeats", () => {
    const reply = "Both [[item:li1]] and [[company:co1]] relate to [[item:li1]].";
    const rendered = renderCitationTokens(reply, targets);
    expect(rendered).toContain("[36 x 84\" Compliant Door](/estimates/est1#line-item-li1)");
    expect(rendered).toContain("[Club Glove](/companies/co1)");
    expect(rendered.match(/#line-item-li1/g)).toHaveLength(2);
  });

  it("drops a token that isn't in the directory rather than linking nowhere", () => {
    expect(renderCitationTokens("See [[doc:made-up-id]] for details.", targets)).toBe("See  for details.");
  });

  it("leaves text without tokens untouched", () => {
    const plain = "No citations here — just prose about [brackets] and (parens).";
    expect(renderCitationTokens(plain, targets)).toBe(plain);
  });

  it("strips brackets from a label so the markdown link can't break", () => {
    const odd = documentCitation("opp1", { id: "d2", filename: "Plan [rev2].pdf" });
    expect(renderCitationTokens("See [[doc:d2]].", [odd])).toBe("See [Plan rev2.pdf](/opportunities/opp1/documents/d2/view).");
  });
});

describe("buildCitationDirectory", () => {
  it("lists each citable thing with its token, and is empty when there's nothing to cite", () => {
    const directory = buildCitationDirectory(targets);
    expect(directory).toContain("[[doc:doc1]] Schedule A - SBLXI - 006. Final.pdf");
    expect(directory).toContain("[[company:co1]] Club Glove");
    expect(buildCitationDirectory([])).toBe("");
  });
});

describe("artworkCitation", () => {
  it("names a client's piece by the client", () => {
    const c = artworkCitation({ id: "a1", jobCode: "9f3c", companyName: "Club Glove", showName: "PGA Show 2026" });
    expect(c.label).toBe("Club Glove — 9f3c");
    expect(c.href).toBe("/artwork/a1");
    expect(c.token).toBe("art:a1");
  });

  it("names a show piece by its show -- it has no client to name", () => {
    // A Hub/hanging-sign piece has no opportunity at all; labelling it
    // after a client would attribute it to whoever happened to be nearby.
    const c = artworkCitation({ id: "a2", jobCode: "1122", companyName: null, showName: "Seatrade Cruise Global 2027" });
    expect(c.label).toBe("Seatrade Cruise Global 2027 (show piece) — 1122");
  });

  it("leads with the graphic code when there is one -- 'A1' is how the floor refers to it", () => {
    const c = artworkCitation({ id: "a3", jobCode: "1122", companyName: "Acme", graphicCode: "A1" });
    expect(c.label).toBe("Acme — A1 · 1122");
  });

  it("still produces a usable label when nothing is known but the job code", () => {
    expect(artworkCitation({ id: "a4", jobCode: "dead" }).label).toBe("Unattributed piece — dead");
  });
});
