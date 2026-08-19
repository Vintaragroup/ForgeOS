import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { requireOpportunityAccess } from "@/lib/opportunity-access";
import { MAX_UPLOAD_BYTES, UNSUPPORTED_EXTENSIONS } from "@/lib/document-service";

// Token-issuance endpoint for the direct-to-Blob upload path -- the
// browser calls @vercel/blob/client's upload() with this route as
// handleUploadUrl, gets back a short-lived client token scoped to one
// pathname, then PUTs the file's bytes straight to Blob storage, never
// through this app's own server at all. That's the entire point: Vercel
// Functions enforce their own request-body ceiling ahead of anything
// next.config.ts's serverActions.bodySizeLimit can promise, which is what
// silently 413'd a 7.2MB / 6-file upload that should have been well
// within the app's configured 40MB Server Action limit -- see
// document-upload-form.tsx's header comment for the full story.
//
// opportunityId comes from the URL param (the same way every other
// action under opportunities/[id]/documents/ gets it), not from the
// upload's clientPayload -- one fewer client-controllable input feeding
// an authorization check.
export async function POST(
  request: Request,
  { params }: RouteContext<"/opportunities/[id]/documents/upload-token">,
) {
  const { id: opportunityId } = await params;
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        // Server Actions elsewhere in this directory call
        // requireOpportunityAccess themselves (see documents/actions.ts) --
        // this route isn't a Server Action, so the same check has to
        // happen here instead, before a token is ever issued for this
        // opportunity's storage prefix.
        await requireOpportunityAccess(opportunityId);

        if (!pathname.startsWith(`${opportunityId}/`)) {
          throw new Error("Storage path must be scoped to this opportunity.");
        }
        const lowerPathname = pathname.toLowerCase();
        if (UNSUPPORTED_EXTENSIONS.some((ext) => lowerPathname.endsWith(ext))) {
          throw new Error(
            `Native CAD files (${UNSUPPORTED_EXTENSIONS.join(", ")}) can't be read by this app. Upload a PDF or image export of the drawing instead.`,
          );
        }

        return {
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          // pathname is already unique (document-upload-form.tsx builds it
          // with its own random suffix, same convention as
          // storage.ts's buildStorageKey) -- a second suffix from Blob
          // itself would just make finalizeUploadedDocument's storageKey
          // not match what the client already recorded.
          addRandomSuffix: false,
        };
      },
    });
    return Response.json(jsonResponse);
  } catch (error) {
    // Logged, not just returned -- the client only ever sees @vercel/blob/
    // client's own generic "Failed to retrieve the client token" wrapper
    // around whatever this route responds with, so the real reason
    // (auth, extension, size, or a Blob-side credential problem) has to
    // be visible server-side or it's undiagnosable from a bug report alone.
    console.error("upload-token route rejected:", error);
    return Response.json({ error: error instanceof Error ? error.message : "Upload authorization failed." }, {
      status: 400,
    });
  }
}
