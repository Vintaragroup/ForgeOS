import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { validatePortalToken } from "@/lib/artwork-portal-auth";
import { ARTWORK_UPLOAD_EXTENSIONS, MAX_ARTWORK_UPLOAD_BYTES } from "@/lib/artwork-file-service";

// Mirrors client-portal/[token]/upload-token/route.ts, scoped to VENDOR.
export async function POST(request: Request, { params }: RouteContext<"/vendor-portal/[token]/upload-token">) {
  const { token } = await params;
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const identity = await validatePortalToken(token);
        if (!identity || identity.role !== "VENDOR") throw new Error("Portal access denied.");

        if (!pathname.startsWith(`${identity.artworkOrderId}/`)) {
          throw new Error("Storage path must be scoped to this artwork order.");
        }
        const lowerPathname = pathname.toLowerCase();
        if (!ARTWORK_UPLOAD_EXTENSIONS.some((ext) => lowerPathname.endsWith(ext))) {
          throw new Error(`Only ${ARTWORK_UPLOAD_EXTENSIONS.join(", ")} files are accepted.`);
        }

        return { maximumSizeInBytes: MAX_ARTWORK_UPLOAD_BYTES, addRandomSuffix: false };
      },
    });
    return Response.json(jsonResponse);
  } catch (error) {
    console.error("vendor-portal upload-token route rejected:", error);
    return Response.json({ error: error instanceof Error ? error.message : "Upload authorization failed." }, { status: 400 });
  }
}
