// Cut-list phase 9 (item #3 of the security/hardening roadmap):
// centralizes what every action file in this app has done by hand up to
// now -- String(formData.get(x) ?? "").trim() / Number(...) / an
// unchecked `as EnumType` cast, each with its own hand-rolled if-throw
// validation. zod already ships transitively (openai's own SDK depends
// on it), so this adds it as a first-class dependency instead of
// reinventing schema validation.
//
// Deliberately scoped to a schema-per-field-set + one parse helper, not
// a framework: parseFormData throws a plain Error with the FIRST issue's
// message, the exact same shape every action's own hand-written
// `throw new Error(...)` already produces -- this changes the internal
// validation MECHANISM, not what a user sees when a field is invalid.
// Applied first to cut-list/actions.ts (this session's own code, already
// has thorough test coverage to catch any behavioral drift) rather than
// rewritten across every action file at once -- see this same roadmap
// item's plan for why a mass rewrite in one pass is the wrong call.
import type { z } from "zod";

export function parseFormData<T extends z.ZodType>(formData: FormData, schema: T): z.infer<T> {
  const raw: Record<string, FormDataEntryValue | null> = {};
  for (const key of new Set(formData.keys())) {
    raw[key] = formData.get(key);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(firstIssue?.message ?? "Invalid input");
  }
  return result.data;
}
