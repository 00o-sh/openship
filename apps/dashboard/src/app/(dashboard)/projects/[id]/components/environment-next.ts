import { getApiErrorMessage } from "@/lib/api/client";

/**
 * The two decisions a "new environment" click makes. Extracted for the same reason
 * `signup-next.ts` was: the page got both of them wrong in ways no type could catch.
 *
 * 1. ON FAILURE it rendered `error.message`. For an `ApiError` that string is
 *    `` `API ${status}: ${statusText}` `` — so the operator saw "API 400: Bad
 *    Request" while the server had been returning an actionable sentence
 *    ("Connect Openship Cloud to use a free subdomain…") in the response body all
 *    along. `getApiErrorMessage` is the existing extractor for exactly that and
 *    simply was not being used here.
 *
 * 2. ON SUCCESS it pushed the project page, which then offered to finish the
 *    half-configured environment the click had just made. A new environment has
 *    nothing deployed, so the only useful destination is the deploy wizard — the
 *    same `?projectId=…&mode=config` entry `DraftProjectView` already uses to carry
 *    a draft into it.
 */

/** The wizard entry for an environment that exists but has never deployed. */
export function environmentWizardHref(env: { id: string; projectSlug: string }): string {
  const params = new URLSearchParams({ projectId: env.id, mode: "config" });
  return `/deploy/${encodeURIComponent(env.projectSlug)}?${params.toString()}`;
}

/** What to show the operator when the create is refused — the SERVER's reason. */
export function environmentErrorMessage(error: unknown, fallback: string): string {
  return getApiErrorMessage(error, fallback);
}
