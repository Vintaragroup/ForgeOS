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
  },
};

export default nextConfig;
