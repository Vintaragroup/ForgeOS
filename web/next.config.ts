import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a self-contained .next/standalone/server.js with only the
  // node_modules files actually needed at runtime -- what the Docker
  // build's runner stage copies, instead of the full node_modules tree.
  output: "standalone",
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
};

export default nextConfig;
