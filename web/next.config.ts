import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a self-contained .next/standalone/server.js with only the
  // node_modules files actually needed at runtime -- what the Docker
  // build's runner stage copies, instead of the full node_modules tree.
  output: "standalone",
  experimental: {
    // Next's default Server Action body limit is 1MB. Phase 7 document
    // uploads (RFP packages, CAD-exported bid sets) run up to ~10MB in
    // real samples -- see data/RFP/superbowl. 20MB leaves headroom above
    // that without being unbounded.
    serverActions: {
      bodySizeLimit: "20mb",
    },
    // A SEPARATE 10MB default from the one above: every route passes
    // through src/proxy.ts (Next 16's renamed middleware), which buffers
    // the request body independently before it ever reaches the Server
    // Action. Missing this, uploads over ~10MB got silently truncated at
    // the proxy layer, then failed with a confusing "Unexpected end of
    // form" from the now-malformed multipart body -- not a body-size
    // error, so it didn't point at the real cause. Matches
    // serverActions.bodySizeLimit above so both layers agree.
    proxyClientMaxBodySize: "20mb",
  },
};

export default nextConfig;
