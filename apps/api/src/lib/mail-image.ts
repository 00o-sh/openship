import { existsSync } from "node:fs";
import { join } from "node:path";

import { buildMailImageRef } from "@repo/core";

import { APP_VERSION } from "./app-version";
import { apiRootPath } from "./release-resolver";

/**
 * The mail-engine container image this API is allowed to run.
 *
 * Pinned to APP_VERSION by default so the engine's baked config + first-boot
 * entrypoint match the API driving it (the admin layer execs into the container
 * assuming a known layout). An operator can still float the engine independently
 * via OPENSHIP_MAIL_TAG / OPENSHIP_MAIL_IMAGE — the precedence lives in ONE place,
 * buildMailImageRef (@repo/core), shared with adapters' resolveMailImage so the pin
 * this produces and the ref that consumes it can't drift.
 */
export function pinnedMailImage(): string {
  return buildMailImageRef({ fallbackTag: APP_VERSION });
}

/**
 * apps/email/ holds the engine's Dockerfile; the image it produces is published as
 * `openship-mail`. That rename is the one place the image↔directory mapping isn't
 * 1:1, and .github/workflows/docker-images.yml encodes the same exception in its
 * build matrix — keep the two in step if either side ever moves.
 */
const MAIL_DOCKERFILE = join("apps", "email", "Dockerfile");

/**
 * The from-source BUILD context for the engine image, or undefined when there's no
 * checkout to build from. Consumed by `ensureContainerMail`'s `build` path, which
 * builds `apps/email/Dockerfile` on the executor in place of pulling the tag.
 *
 * TEMPORARY, by design: `openship-mail` is not published yet, so building locally is
 * the only way to exercise the containerized engine. Once the image ships with a
 * release, this stops being load-bearing for normal installs and stays only as the
 * dev/from-source escape hatch — the pull path in `ensureContainerMail` becomes the
 * one every published install takes.
 *
 *   1. OPENSHIP_MAIL_BUILD_CONTEXT — an explicit repo root. Also the ONLY way to
 *      point at a checkout on a REMOTE box: auto-detect only sees this API's own disk.
 *   2. Auto: the repo root above this API package, via the single on-disk anchor
 *      ({@link apiRootPath}) rather than a second `import.meta.url` derivation.
 *      Guarded by the Dockerfile existing there, so a compiled binary or a bundled
 *      install — where that anchor points nowhere useful — returns undefined and
 *      bring-up falls through to the registry pull.
 *
 * The tag is unaffected — it stays driven by {@link pinnedMailImage}, so a built
 * image carries exactly the ref bring-up resolves.
 */
export function mailBuildSpec(): { context: string } | undefined {
  const explicit = process.env.OPENSHIP_MAIL_BUILD_CONTEXT?.trim();
  if (explicit) return { context: explicit };

  const repoRoot = apiRootPath("..", "..");
  return existsSync(join(repoRoot, MAIL_DOCKERFILE)) ? { context: repoRoot } : undefined;
}
