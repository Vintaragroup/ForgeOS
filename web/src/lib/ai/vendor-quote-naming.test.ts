import { describe, expect, it } from "vitest";
import { sectionNameFromQuote } from "@/lib/ai/vendor-quote-service";

// Importing a vendor quote used to create a section named after the file,
// and that string printed as a heading on the client's proposal. The
// estimating lead flagged exactly this on ABC Chicago, where
// "369711-VERSION-2-EXPO-CCI--FULL-SWING...PDF" was a visible H2.
describe("sectionNameFromQuote", () => {
  it("turns a real Fuse quote filename into something a client can read", () => {
    expect(sectionNameFromQuote("371520-Expo-CCI--Pharmacy-Hub--HLTH-2026--LED-V1.pdf")).toBe(
      "Pharmacy Hub HLTH 2026 LED V1",
    );
    expect(sectionNameFromQuote("371527-Expo-CCI--Pharmacy-Hub--HLTH-2026--LX-V1.pdf")).toBe(
      "Pharmacy Hub HLTH 2026 LX V1",
    );
  });

  // Better a filename than an empty heading.
  it("falls back to the name rather than returning nothing", () => {
    expect(sectionNameFromQuote("371520.pdf")).toBe("371520");
    expect(sectionNameFromQuote("Expo-CCI.pdf")).toBe("Expo-CCI");
  });

  it("leaves an already-readable name alone", () => {
    expect(sectionNameFromQuote("Hanging Sign Quote.pdf")).toBe("Hanging Sign Quote");
  });
});
