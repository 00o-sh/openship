import { describe, it, expect } from "vitest";
import { getRouteRegistry, isPublicSpec } from "../../src/lib/route-permission";

/**
 * THE CONTENT-TIER RATCHET.
 *
 * A repo grant is metadata-only by default: it authorises deploying the repo,
 * reading its branches, and detecting its stack — NOT crawling its files. That
 * only holds while every content-serving route declares `source`. Ship one
 * without it and a deploy-only token silently regains full read access, because
 * `requirePermission` has nothing to enforce.
 *
 * So this asserts two directions:
 *   1. Any github route whose path LOOKS content-serving must declare a tier.
 *      The marker list catches conventionally-named future routes (/tree,
 *      /archive, /tarball …) rather than only the three that exist today.
 *   2. The tiers of the routes that exist today are pinned exactly, so a retag
 *      from `content` to nothing — or from `content-whole` down to `content` —
 *      fails here instead of in production.
 */

/**
 * Path shapes that serve repository bytes or directory entries. Deliberately
 * broader than what exists: the point is to catch a route added later.
 */
const CONTENT_PATH_MARKERS: RegExp[] = [
  /\/files?$/, //           /files (tree), /file (bytes)
  /\/clone-token$/, //      a clone reads everything
  /\/contents?\b/, //       GitHub's own naming
  /\/tree\b/,
  /\/blob\b/,
  /\/(tar|zip)ball\b/,
  /\/archive\b/,
];

/** The tier each content route must carry. Update deliberately, never casually. */
const EXPECTED_TIERS: Record<string, string> = {
  "GET /api/github/repos/:owner/:repo/files": "content-tree",
  "GET /api/github/repos/:owner/:repo/tree": "content-tree",
  "GET /api/github/repos/:owner/:repo/file": "content",
  "GET /api/github/repos/:owner/:repo/clone-token": "content-whole",
};

async function githubRoutes() {
  // Importing the module is what populates the registry.
  await import("../../src/modules/github/github.routes");
  return getRouteRegistry().filter((r) => r.path.startsWith("/api/github/"));
}

describe("every content-serving github route declares a source tier", () => {
  it("leaves no content route ungated", async () => {
    const routes = await githubRoutes();
    // Guard the guard: an empty registry would make this vacuously pass.
    expect(routes.length).toBeGreaterThanOrEqual(10);

    const contentish = routes.filter((r) => CONTENT_PATH_MARKERS.some((m) => m.test(r.path)));
    expect(contentish.length).toBeGreaterThanOrEqual(3);

    for (const route of contentish) {
      const spec = route.spec;
      const source = isPublicSpec(spec) ? undefined : spec.source;
      expect(
        source,
        `${route.method} ${route.path} serves repository content but declares no ` +
          `\`source\` tier — a deploy-only token would be able to read it`,
      ).toBeDefined();
    }
  });

  it("pins the tier of each content route", async () => {
    const routes = await githubRoutes();
    for (const [key, expected] of Object.entries(EXPECTED_TIERS)) {
      const [method, path] = key.split(" ");
      const route = routes.find((r) => r.method === method && r.path === path);
      expect(route, `${key} is missing from the registry`).toBeDefined();
      const spec = route!.spec;
      const source = isPublicSpec(spec) ? undefined : spec.source;
      expect(source, `${key} must be tier "${expected}"`).toBe(expected);
    }
  });

  it("clone-token requires UNRESTRICTED content, not merely content", async () => {
    // A clone hands over every byte and cannot be path-filtered, so a caller
    // scoped to a subtree must not be able to mint one. If this ever relaxes to
    // "content", a src/**-scoped token could clone the whole repo.
    const routes = await githubRoutes();
    const cloneToken = routes.find((r) => r.path.endsWith("/clone-token"));
    const spec = cloneToken!.spec;
    expect(isPublicSpec(spec) ? undefined : spec.source).toBe("content-whole");
  });

  it("metadata routes stay untiered so deploy-only keeps working", async () => {
    // The whole point of deploy-only is that these still work with no content
    // grant. Tiering one of them by mistake would break configuring a deploy.
    const routes = await githubRoutes();
    for (const path of [
      "/api/github/repos/:owner/:repo",
      "/api/github/repos/:owner/:repo/branches",
      "/api/github/repos/:owner/:repo/detect",
      "/api/github/orgs/:org/repos",
    ]) {
      const route = routes.find((r) => r.method === "GET" && r.path === path);
      expect(route, `${path} is missing from the registry`).toBeDefined();
      const spec = route!.spec;
      expect(
        isPublicSpec(spec) ? undefined : spec.source,
        `${path} is metadata tier and must NOT require content access`,
      ).toBeUndefined();
    }
  });

  it("detect exists and is advertised — it is what makes deploy-only usable", async () => {
    // Without a derived-config endpoint, an agent on a deploy-only grant could not
    // configure a deploy at all and would be forced to ask for content access.
    const routes = await githubRoutes();
    const detect = routes.find((r) => r.path === "/api/github/repos/:owner/:repo/detect");
    expect(detect).toBeDefined();
    const spec = detect!.spec;
    expect(isPublicSpec(spec)).toBe(false);
    expect((spec as { mcp?: unknown }).mcp, "detect must be exposed as an MCP tool").toBeDefined();
  });
});
