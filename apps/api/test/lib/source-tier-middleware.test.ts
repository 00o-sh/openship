import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { RequestContext } from "../../src/lib/request-context";

/**
 * The middleware → handler SEAM.
 *
 * `requirePermission` resolves the caller's path allow-list once and stashes it
 * (`c.set("sourceReadPaths")`); the /files handler reads it back to filter the
 * entries it returns. Both sides are unit-tested in isolation, but nothing proved
 * they agree — misspell the key on either side and every other test still passes
 * while directory listings silently return nothing.
 *
 * These cover the crossing: the stash arrives, the query param the tier reads is
 * the right one, and a denial is an IDOR-safe 404 naming the path.
 */

const { canUseGitHubRepo, checkSourceTier } = vi.hoisted(() => ({
  canUseGitHubRepo: vi.fn(),
  checkSourceTier: vi.fn(),
}));

vi.mock("../../src/modules/github/github-access", () => ({
  canUseGitHubRepo,
  checkSourceTier,
}));

import { requirePermission } from "../../src/lib/route-permission";

const fakeCtx = { userId: "u1", organizationId: "org1" } as unknown as RequestContext;

/** A Hono app shaped like the real one: ctx present, NotFoundError → 404. */
function appWith(spec: Parameters<typeof requirePermission>[0], path: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("ctx" as never, fakeCtx as never);
    await next();
  });
  app.onError((err, c) =>
    c.json(
      { error: err.message, code: (err as { code?: string }).code },
      ((err as { statusCode?: number }).statusCode ?? 500) as 404,
    ),
  );
  app.get(path, requirePermission(spec), (c) =>
    // Echo what the handler actually received from the middleware.
    c.json({ stash: c.get("sourceReadPaths" as never) ?? null }),
  );
  return app;
}

beforeEach(() => {
  // Reset call counts, not just return values — the "never consulted" assertions
  // below are about call counts and would otherwise see earlier tests' calls.
  vi.clearAllMocks();
  canUseGitHubRepo.mockResolvedValue(true);
  checkSourceTier.mockResolvedValue({ ok: true, readPaths: ["src/**"] });
});

describe("the allow-list reaches the handler", () => {
  it("stashes readPaths under the key the /files handler reads", async () => {
    const app = appWith(
      { tag: "github:list", source: "content-tree" },
      "/repos/:owner/:repo/files",
    );
    const res = await app.request("/repos/hydralerne/charts/files?path=src");
    expect(res.status).toBe(200);
    // If the set/get keys ever diverge, this is null and listings return nothing.
    expect(await res.json()).toEqual({ stash: ["src/**"] });
  });

  it("does not stash anything for a metadata route", async () => {
    const app = appWith({ tag: "github:read" }, "/repos/:owner/:repo");
    const res = await app.request("/repos/hydralerne/charts");
    expect(await res.json()).toEqual({ stash: null });
    expect(checkSourceTier).not.toHaveBeenCalled();
  });
});

describe("the path the tier is checked against", () => {
  it("reads ?path= on a tree route", async () => {
    const app = appWith(
      { tag: "github:list", source: "content-tree" },
      "/repos/:owner/:repo/files",
    );
    await app.request("/repos/hydralerne/charts/files?path=src/deep");
    expect(checkSourceTier).toHaveBeenCalledWith(
      expect.anything(),
      { owner: "hydralerne", repo: "charts" },
      "content-tree",
      "src/deep",
    );
  });

  it("reads ?file= on a single-file route", async () => {
    const app = appWith({ tag: "github:read", source: "content" }, "/repos/:owner/:repo/file");
    await app.request("/repos/hydralerne/charts/file?file=src/a.ts");
    expect(checkSourceTier).toHaveBeenCalledWith(
      expect.anything(),
      { owner: "hydralerne", repo: "charts" },
      "content",
      "src/a.ts",
    );
  });

  it("an absent path means the repo ROOT, which is what /files with no path lists", async () => {
    const app = appWith(
      { tag: "github:list", source: "content-tree" },
      "/repos/:owner/:repo/files",
    );
    await app.request("/repos/hydralerne/charts/files");
    expect(checkSourceTier).toHaveBeenCalledWith(
      expect.anything(),
      { owner: "hydralerne", repo: "charts" },
      "content-tree",
      "",
    );
  });
});

describe("denial", () => {
  it("is a 404 naming the path, not a 403", async () => {
    // IDOR-safe: a caller who holds the repo but not this subtree must not be able
    // to tell "exists but forbidden" from "does not exist".
    checkSourceTier.mockResolvedValue({ ok: false, readPaths: ["src/**"] });
    const app = appWith({ tag: "github:read", source: "content" }, "/repos/:owner/:repo/file");
    const res = await app.request("/repos/hydralerne/charts/file?file=secrets.env");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe("NOT_FOUND");
    expect(body.error).toContain("hydralerne/charts/secrets.env");
  });

  it("the handler never runs when the tier is denied", async () => {
    checkSourceTier.mockResolvedValue({ ok: false, readPaths: [] });
    const app = appWith(
      { tag: "github:list", source: "content-tree" },
      "/repos/:owner/:repo/files",
    );
    const res = await app.request("/repos/hydralerne/charts/files?path=docs");
    expect(res.status).toBe(404);
    // A handler that ran would have returned { stash: ... }.
    expect(await res.json()).not.toHaveProperty("stash");
  });

  it("repo-level denial short-circuits before the tier is consulted", async () => {
    canUseGitHubRepo.mockResolvedValue(false);
    const app = appWith({ tag: "github:read", source: "content" }, "/repos/:owner/:repo/file");
    const res = await app.request("/repos/hydralerne/charts/file?file=src/a.ts");
    expect(res.status).toBe(404);
    expect(checkSourceTier).not.toHaveBeenCalled();
  });
});
