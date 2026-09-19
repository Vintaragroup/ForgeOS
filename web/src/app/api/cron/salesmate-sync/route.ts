// Daily Salesmate -> ForgeOS sync (see vercel.ts), same Vercel Cron auth as
// artwork-sla-warnings/route.ts: only `Authorization: Bearer $CRON_SECRET`
// is accepted, and a missing secret fails closed. The sync itself records
// every attempt (success or failure) as a SalesmateSyncRun, which
// /admin/integrations/salesmate shows.
import { runSalesmateSync } from "@/lib/salesmate-sync";

// A full sync is a few hundred upserts against Render Postgres -- well
// inside this, but more than a default short function timeout.
export const maxDuration = 300;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const run = await runSalesmateSync({ trigger: "CRON" });
  return Response.json({ success: run.status === "SUCCEEDED", runId: run.id, status: run.status, error: run.error });
}
