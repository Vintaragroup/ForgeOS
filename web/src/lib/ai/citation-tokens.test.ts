import { describe, expect, it } from "vitest";
import {
  buildCitationDirectory,
  companyCitation,
  documentCitation,
  lineItemCitation,
  renderCitationTokens,
} from "@/lib/ai/citation-tokens";

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
