import { describe, expect, it } from "vitest";
import { copyState, copyStateLabel, summarySourceKey } from "@/lib/proposal-copy-staleness";

const FUSE_THEN = ['LED Screen 8\'h x 11.39\'w', "Cantilever mounts", "Video programming"];
const FUSE_NOW = ['60" LED monitors attached to areas of the exhibit'];

describe("summarySourceKey", () => {
  it("ignores order and spacing, which change nothing about what a booth is", () => {
    expect(summarySourceKey(["B  row", "a row"])).toBe(summarySourceKey(["a row", "B row"]));
  });

  it("changes when a row is removed", () => {
    expect(summarySourceKey(FUSE_THEN)).not.toBe(summarySourceKey(FUSE_NOW));
  });

  it("ignores empty descriptions", () => {
    expect(summarySourceKey(["a", "", "  "])).toBe(summarySourceKey(["a"]));
  });
});

describe("copyState", () => {
  // ABC Chicago's AV booth: a summary describing an 8ft LED wall, against
  // a section cut down to one row of 60" monitors.
  it("calls a summary stale once its line items have changed", () => {
    const state = copyState({
      summary: "This booth will feature a large LED screen measuring 8 feet high...",
      recordedKey: summarySourceKey(FUSE_THEN),
      currentDescriptions: FUSE_NOW,
    });
    expect(state).toBe("STALE");
    expect(copyStateLabel(state)).toMatch(/changed after this text was written/);
  });

  it("leaves a summary alone while its line items still match", () => {
    expect(
      copyState({ summary: "text", recordedKey: summarySourceKey(FUSE_NOW), currentDescriptions: FUSE_NOW }),
    ).toBe("CURRENT");
  });

  // A price change does not make the sentence wrong, and a flag that
  // fires on every edit is a flag people learn to ignore.
  it("does not fire when only prices moved", () => {
    expect(
      copyState({ summary: "text", recordedKey: summarySourceKey(FUSE_NOW), currentDescriptions: [...FUSE_NOW] }),
    ).toBe("CURRENT");
  });

  it("says nothing about a summary written before this check existed", () => {
    expect(copyState({ summary: "text", recordedKey: null, currentDescriptions: FUSE_NOW })).toBe("UNKNOWN");
    expect(copyStateLabel("UNKNOWN")).toBeNull();
  });

  it("says nothing when there is no summary at all", () => {
    expect(copyState({ summary: null, recordedKey: null, currentDescriptions: [] })).toBe("NONE");
  });
});
