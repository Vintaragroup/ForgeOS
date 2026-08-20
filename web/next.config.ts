import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a self-contained .next/standalone/server.js with only the
  // node_modules files actually needed at runtime -- what the Docker
  // build's runner stage copies, instead of the full node_modules tree.
  // Vercel's own build pipeline does its own file-tracing/bundling for
  // serverless functions and expects Next's *non*-standalone output
  // layout -- with this unconditionally on, a real Vercel deploy fails at
  // its bundling step (ENOENT on .next/next-server.js.nft.json, since
  // standalone mode nests that trace file under .next/standalone/
  // instead). VERCEL is set by Vercel's build environment; only opt into
  // standalone when building for the Docker path.
  output: process.env.VERCEL ? undefined : "standalone",
  // @napi-rs/canvas (drawing-summary-service.ts's PDF-page rasterization)
  // ships a native .node binary loaded via a plain js-binding.js require
  // -- Turbopack can't place that as an ESM chunk module, so the build
  // fails unless this package is excluded from bundling and left for
  // Node's own require/import to resolve from node_modules at runtime.
  serverExternalPackages: ["@napi-rs/canvas"],
  // canvas-fonts.ts registers these two .ttf files by an explicit
  // process.cwd()-relative path, not a plain import -- Next's tracer
  // can miss files reached that way, and this is exactly the class of
  // "works locally, silently absent on Vercel" gap that already caused
  // a real production outage today (jsdom). Forced in explicitly here
  // rather than trusted to implicit tracing.
  outputFileTracingIncludes: {
    "/*": ["src/assets/fonts/*.ttf"],
  },
  experimental: {
    // Next's default Server Action body limit is 1MB. A real RFP package
    // dropped in all at once (the drag-and-drop multi-upload) runs ~12MB
    // total across 6 files -- see data/RFP/superbowl. 40MB leaves real
    // headroom above that without being unbounded.
    serverActions: {
      bodySizeLimit: "40mb",
    },
    // A SEPARATE 10MB default from the one above: every route passes
    // through src/proxy.ts (Next 16's renamed middleware), which buffers
    // the request body independently before it ever reaches the Server
    // Action. Missing this, uploads over ~10MB got silently truncated at
    // the proxy layer, then failed with a confusing "Unexpected end of
    // form" from the now-malformed multipart body -- not a body-size
    // error, so it didn't point at the real cause. Matches
    // serverActions.bodySizeLimit above so both layers agree.
    proxyClientMaxBodySize: "40mb",
  },
  // Item #5 of the security/hardening roadmap: the safe, low-risk header
  // wins only. Deliberately excludes a Content-Security-Policy here -- a
  // wrong CSP can silently break the chat widget, the PDF/DXF viewers, or
  // Next's own dev-mode inline scripts, and needs its own careful,
  // separately-tested pass rather than bundling into this change.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Stops a browser from MIME-sniffing a response into a
          // different content type than the server declared (e.g.
          // treating an uploaded document as executable script).
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Blocks this app from being framed by another SITE, but not by
          // itself -- the document /view page iframes its own raw
          // byte-serving route to show a PDF inline (view/page.tsx's
          // `<iframe src={inlineUrl}>`, same-origin, no third party
          // involved), which DENY blocks unconditionally regardless of
          // origin. Confirmed live: every PDF view failed with "Refused
          // to display ... because it set 'X-Frame-Options' to 'deny'"
          // once this rolled out. SAMEORIGIN still blocks every actual
          // clickjacking scenario (a different site framing this app);
          // it just stops blocking the app framing itself.
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // Sends the full referrer on a same-origin navigation, only the
          // origin (no path/query) cross-origin -- balances analytics/
          // debugging usefulness against leaking this app's internal URL
          // structure (estimate/opportunity IDs live in paths) to
          // external sites a user navigates to from here.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Denies every browser feature this app never uses, rather
          // than leaving the browser default (which varies feature by
          // feature and is broader than this app needs).
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
