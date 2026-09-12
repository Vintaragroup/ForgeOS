// Thin Resend wrapper for the artwork pipeline's notification emails (spec
// Section 4's notification matrix). Provisioned via Vercel Marketplace,
// same precedent as @vercel/blob -- see .env.example.
//
// Deliberately NOT the same optional-degradation shape as openai-client.ts's
// AiNotConfiguredError (which throws, for an explicit user-triggered
// action where surfacing "not configured yet" is the right UX). An email
// notification is a side effect of a state transition that has ALREADY
// succeeded in the database -- a missing RESEND_API_KEY must never turn
// into a failed sign-off, proof approval, or any other real state change.
// sendEmail swallows its own failures (missing key, Resend API error) and
// just logs, so every call site can fire-and-forget it.
import { Resend } from "resend";

let client: Resend | null = null;

function getClient(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!client) client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

export const EMAIL_FROM = process.env.ARTWORK_EMAIL_FROM || "Expo Artwork <artwork@notifications.forgeos.app>";

// No prior code in this app ever needed an absolute URL (everything is
// same-origin <Link> navigation) -- an email body is the first thing that
// does. NEXT_PUBLIC_APP_URL wins when set (a real custom domain); Vercel's
// own auto-populated VERCEL_URL (no protocol) is the deploy-preview
// fallback; localhost covers local dev.
export function getAppBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

export async function sendEmail(params: { to: string; subject: string; text: string }): Promise<boolean> {
  const resend = getClient();
  if (!resend) {
    console.warn(`[email] RESEND_API_KEY not set -- skipping email "${params.subject}" to ${params.to}`);
    return false;
  }
  try {
    await resend.emails.send({ from: EMAIL_FROM, to: params.to, subject: params.subject, text: params.text });
    return true;
  } catch (err) {
    console.error(`[email] failed to send "${params.subject}" to ${params.to}:`, err);
    return false;
  }
}
