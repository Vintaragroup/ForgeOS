import { describe, expect, it } from "vitest";
import { getAppBaseUrl, sendEmail } from "@/lib/email";

// RESEND_API_KEY is deliberately unset in .env.test (see that file's own
// comment) -- this is the actual environment every other test in this
// suite already runs under, not a mock. Confirms the core promise: a
// missing key never throws, it just no-ops.
describe("sendEmail", () => {
  it("no-ops (returns false, does not throw) when RESEND_API_KEY is unset", async () => {
    await expect(sendEmail({ to: "someone@example.com", subject: "Test", text: "Test body" })).resolves.toBe(false);
  });
});

describe("getAppBaseUrl", () => {
  it("falls back to localhost when nothing is set", () => {
    const original = { appUrl: process.env.NEXT_PUBLIC_APP_URL, vercelUrl: process.env.VERCEL_URL };
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_URL;
    try {
      expect(getAppBaseUrl()).toBe("http://localhost:3000");
    } finally {
      if (original.appUrl) process.env.NEXT_PUBLIC_APP_URL = original.appUrl;
      if (original.vercelUrl) process.env.VERCEL_URL = original.vercelUrl;
    }
  });

  it("prefers NEXT_PUBLIC_APP_URL and strips a trailing slash", () => {
    const original = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://example.com/";
    try {
      expect(getAppBaseUrl()).toBe("https://example.com");
    } finally {
      if (original) process.env.NEXT_PUBLIC_APP_URL = original;
      else delete process.env.NEXT_PUBLIC_APP_URL;
    }
  });

  it("falls back to VERCEL_URL (adding https://) when NEXT_PUBLIC_APP_URL is unset", () => {
    const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    const originalVercelUrl = process.env.VERCEL_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.VERCEL_URL = "my-app-git-branch.vercel.app";
    try {
      expect(getAppBaseUrl()).toBe("https://my-app-git-branch.vercel.app");
    } finally {
      if (originalAppUrl) process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
      if (originalVercelUrl) process.env.VERCEL_URL = originalVercelUrl;
      else delete process.env.VERCEL_URL;
    }
  });
});
