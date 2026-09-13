// This app's first scheduled job -- the artwork pipeline's SLA-warning
// email (see ArtworkOrder.slaWarningNotifiedAt's own comment). Hourly is
// plenty granular for a window measured in hours (24h normally, 4h in a
// show's final week); the route itself is idempotent (guarded by
// slaWarningNotifiedAt), so a missed or doubled tick is harmless.
import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  crons: [{ path: "/api/cron/artwork-sla-warnings", schedule: "0 * * * *" }],
};
