import path from "node:path";
import { GlobalFonts } from "@napi-rs/canvas";

// @napi-rs/canvas auto-discovers whatever system fonts are actually
// installed (GlobalFonts.families) -- 300+ of them on a real macOS dev
// machine, which is why every PDF/drawing rasterization here "just
// worked" in local testing. Vercel's serverless Lambda has none: no
// system font directory at all. Skia (the rendering engine underneath
// @napi-rs/canvas) doesn't error when it can't find a font to draw
// glyphs with -- it silently skips them, so a rasterized PDF page comes
// back with every non-text element (images, table borders, backgrounds)
// intact and every character of text missing. Confirmed live: a
// production /view page showed "just the graphics of the page" with the
// referenced text entirely absent.
//
// Registered once at module load (not lazily per-call) -- GlobalFonts is
// a process-global registry, and Fluid Compute reuses the same Node
// process across invocations, so this only actually runs once per cold
// start, the same "do it once at import time" posture storage.ts's own
// module-level setup already uses elsewhere in this codebase.
//
// DejaVu Sans, not a pixel-perfect match for whatever font a given PDF
// embeds (Century Gothic, Arial, etc.) -- this is a fallback for text
// Skia has no embedded-font data to draw from at all, where "readable"
// beats "unavailable." Freely redistributable (Bitstream Vera license,
// see DEJAVU-LICENSE.txt next to the font files) and bundled directly in
// this repo rather than pulled from node_modules at runtime, so there's
// no dependency on Vercel's file-tracing correctly following a path into
// a package's internals -- the same kind of bundling uncertainty that
// already caused one production outage today (jsdom).
let registered = false;

export function ensureCanvasFontsRegistered(): void {
  if (registered) return;
  const fontsDir = path.join(process.cwd(), "src/assets/fonts");
  GlobalFonts.registerFromPath(path.join(fontsDir, "DejaVuSans.ttf"), "DejaVu Sans");
  GlobalFonts.registerFromPath(path.join(fontsDir, "DejaVuSans-Bold.ttf"), "DejaVu Sans Bold");

  // pdf.js's own font-substitution logic (the source of "Cannot
  // substitute the font because of its name" warnings) falls back to a
  // generic CSS family -- sans-serif/serif/monospace -- when it can't
  // identify or embed a PDF's actual font, and hands THAT name to the
  // canvas context. Registering DejaVu Sans under its own name isn't
  // enough on its own: nothing in the render call ever asks for "DejaVu
  // Sans" by name, so without these aliases Skia still has nothing to
  // resolve "sans-serif" to and silently draws no glyphs at all, same as
  // if no font were registered in the first place.
  GlobalFonts.setAlias("DejaVu Sans", "sans-serif");
  GlobalFonts.setAlias("DejaVu Sans", "serif");
  GlobalFonts.setAlias("DejaVu Sans", "monospace");
  registered = true;
}
