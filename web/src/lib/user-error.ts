// An expected, user-fixable validation failure ("a note is required",
// "upload a photo first") -- as opposed to a bug, an access denial, or an
// infrastructure failure. The distinction matters because Next.js redacts
// every error thrown out of a Server Action in production: the user sees
// only a generic error-boundary message plus a digest, never the text we
// wrote. So a validation message that's meant to be READ has to come back
// as a return value instead (see Next's own error-handling guide: "model
// expected errors as return values"), and this class is how a service
// function marks which of its throws are safe and useful to show.
//
// Service functions keep throwing (the posture every function in
// artwork-order-service.ts etc. already has, and what their tests assert
// on) -- only the Server Action boundary converts, via catchUserError
// below. Anything that ISN'T a UserError still propagates to the nearest
// error.tsx, deliberately: an unexpected failure's message may contain
// internals and shouldn't be echoed into a form.
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

// What a form-facing Server Action returns -- undefined on success, so a
// successful submit clears any previous error. Shape matches what
// ActionForm (src/components/action-form.tsx) reads.
export type ActionResult = { error: string } | undefined;

export async function catchUserError(fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    // redirect()/notFound() throw their own control-flow errors -- those
    // aren't UserErrors, so they fall through to the rethrow untouched.
    if (err instanceof UserError) return { error: err.message };
    throw err;
  }
}
