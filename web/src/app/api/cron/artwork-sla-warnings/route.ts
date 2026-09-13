// The artwork pipeline's SLA-warning sweep, triggered hourly by Vercel Cron
// (see vercel.ts). Standard Vercel Cron auth: only a request carrying
// `Authorization: Bearer $CRON_SECRET` is accepted -- see
// https://vercel.com/docs/cron-jobs/manage-cron-jobs. CRON_SECRET must be
// set in the deployment's environment for this route to ever succeed; a
// missing secret fails closed (401), not open.
import { runSlaWarningSweep } from "@/lib/artwork-sla-sweep";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await runSlaWarningSweep();
  return Response.json({ success: true, ...result });
}
