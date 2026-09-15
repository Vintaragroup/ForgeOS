import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { requireArtworkOrderAccess } from "@/lib/opportunity-access";

// Token-issuance endpoint for the direct-to-Blob upload path, same pattern
// as opportunities/[id]/documents/upload-token/route.ts (see that file's
// own comment for the full "why not a Server Action" story). Internal
// staff only -- unlike ArtworkFile's other two kinds (CLIENT_ARTWORK,
// PROOF), a POST_SHOW_CONDITION_PHOTO is never supplied by an external
// client or vendor, so this deliberately does NOT live under either
// portal's own token route.
const MAX_PHOTO_BYTES = 20 * 1024 * 1024; // 20MB -- a phone photo, not a print file
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".heic", ".webp"];

export async function POST(
  request: Request,
  { params }: RouteContext<"/artwork/[artworkOrderId]/post-show-photo-upload-token">,
) {
  const { artworkOrderId } = await params;
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        // requireArtworkOrderAccess throws if there's no session or the
        // caller can't reach this order -- same gate the artwork detail
        // page itself already uses, checked here since a token route isn't
        // a Server Action either.
        await requireArtworkOrderAccess(artworkOrderId);

        if (!pathname.startsWith(`${artworkOrderId}/post-show/`)) {
          throw new Error("Storage path must be scoped to this artwork order's post-show photos.");
        }
        const lowerPathname = pathname.toLowerCase();
        if (!ALLOWED_EXTENSIONS.some((ext) => lowerPathname.endsWith(ext))) {
          throw new Error(`Only image files (${ALLOWED_EXTENSIONS.join(", ")}) are accepted for condition photos.`);
        }

        return {
          maximumSizeInBytes: MAX_PHOTO_BYTES,
          addRandomSuffix: false,
        };
      },
    });
    return Response.json(jsonResponse);
  } catch (error) {
    console.error("post-show-photo-upload-token route rejected:", error);
    return Response.json({ error: error instanceof Error ? error.message : "Upload authorization failed." }, {
      status: 400,
    });
  }
}
