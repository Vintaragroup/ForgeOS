import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { isBlankPageImage } from "@/lib/ai/blank-page-detection";

function solidDataUrl(width: number, height: number, color: string): string {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return canvas.toDataURL();
}

function contentDataUrl(width: number, height: number): string {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "black";
  ctx.lineWidth = 4;
  ctx.strokeRect(40, 40, width - 80, height - 80);
  ctx.fillStyle = "black";
  ctx.font = "48px sans-serif";
  ctx.fillText("12'-6\" TYP", 60, 120);
  return canvas.toDataURL();
}

describe("isBlankPageImage", () => {
  // The confirmed real shape of the JPX-decode-failure incident this
  // catches (Titleist "Concept V1E", Sept 2026) -- @napi-rs/canvas's PDF.js
  // leaves the canvas completely untouched (solid white) when it can't
  // decode a page's embedded image, rather than throwing.
  it("flags a solid white page as blank", async () => {
    expect(await isBlankPageImage(solidDataUrl(2200, 1232, "white"))).toBe(true);
  });

  it("flags any uniform-color page as blank, not just white", async () => {
    expect(await isBlankPageImage(solidDataUrl(2200, 1232, "#3366aa"))).toBe(true);
  });

  it("does not flag a page with real drawn content as blank", async () => {
    expect(await isBlankPageImage(contentDataUrl(2200, 1232))).toBe(false);
  });
});
