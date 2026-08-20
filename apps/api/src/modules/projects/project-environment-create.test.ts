import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Creating an environment must leave NOTHING behind when it fails.
 *
 * The reported bug was one click producing three symptoms. `createProjectEnvironment`
 * called `repos.project.create()` and only then derived a free subdomain and ran
 * `assertFreeEndpointsAllowed`, which throws on a Cloud-disconnected instance. The
 * row was already committed, so:
 *
 *   1. the request answered 400 while the environment existed;
 *   2. the retry hit the "already exists" guard;
 *   3. a reload offered a switchable, half-built environment with no routing.
 *
 * `createProject` states the rule a few hundred lines up — gate "BEFORE any
 * group/project row is written … so a rejected create leaves nothing behind" — and
 * also exempts auto-derived endpoints from that gate entirely, because "that path
 * must keep working on a self-hosted instance". The environment path did neither.
 *
 * So the properties pinned here are: nothing is written when validation fails, and
 * the create path never touches routing at all.
 */

const h = vi.hoisted(() => ({
  base: {
    id: "proj_prod",
    organizationId: "org_1",
    groupId: "grp_1",
    name: "Site",
    slug: "site",
    environmentSlug: "production",
    environmentType: "production",
    gitProvider: "github",
    gitOwner: "acme",
    gitRepo: "site",
    gitBranch: "main",
    isApp: false,
    activeDeploymentId: null as string | null,
    serverId: null as string | null,
    resources: null,
    buildResources: null,
  },
  siblings: [] as Array<Record<string, unknown>>,
  branches: [{ name: "main" }, { name: "staging" }] as Array<{ name: string }>,
  creates: [] as Array<Record<string, unknown>>,
  freeGateCalls: 0,
  persistedRoutes: [] as Array<unknown>,
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findById: async () => ({ ...h.base }),
      listByGroup: async () => h.siblings,
      findBySlugInOrg: async () => null,
      create: async (input: Record<string, unknown>) => {
        h.creates.push(input);
        return { ...h.base, ...input, id: "proj_new" };
      },
      listByOrganization: async () => ({ rows: [], total: 0 }),
    },
    projectGroup: {
      findById: async () => ({ id: "grp_1", name: "Site", slug: "site" }),
      findBySlugInOrg: async () => null,
    },
    deployment: { findById: async () => null, listByProject: async () => ({ rows: [] }) },
    service: { listByProject: async () => [] },
    domain: { listByProject: async () => [] },
    server: { getInOrganization: async () => null },
    dockerMigrationRun: { findActiveForProject: async () => null },
  },
}));

// The seams that prove property 2: the create path must not reach any of them.
vi.mock("../domains/project-route.service", () => ({
  syncProjectRouteState: async () => ({ projectDomains: [], publicEndpoints: [] }),
  reapplyProjectLiveRoutes: async () => {},
  resolveProjectRouteState: async () => ({ projectDomains: [], publicEndpoints: [] }),
  listProjectRouteRows: async () => [],
  persistProjectRouteState: async (_id: string, endpoints: unknown) => {
    h.persistedRoutes.push(endpoints);
  },
  deriveNextProjectRouteState: () => ({ projectDomains: [], publicEndpoints: [] }),
  deriveEnvironmentPublicEndpoints: () => [{ domain: "site-staging.opsh.io", domainType: "free" }],
}));
vi.mock("../../lib/free-domain-guard", () => ({
  assertFreeEndpointsAllowed: async () => {
    h.freeGateCalls += 1;
  },
}));

vi.mock("../domains/routing-apply.service", () => ({ applyProjectRouting: async () => {} }));
vi.mock("./project-runtime.service", () => ({ syncProjectManagedEdge: async () => {} }));
vi.mock("../../lib/controller-helpers", () => ({
  assertResourceInOrg: () => {},
  platform: () => ({ runtime: { name: "docker" } }),
}));
vi.mock("../github/github.service", () => ({
  resolveDefaultBranch: async () => "main",
  listBranches: async () => h.branches,
  getLatestCommit: async () => null,
  resolveWebhookStrategy: async () => ({}),
}));
vi.mock("../github/github.auth", () => ({
  getInstallationIdByOrg: async () => undefined,
  getInstallUrl: () => "",
}));
vi.mock("./project-git-webhook", () => ({
  ensureSharedWebhook: async () => null,
  findSharedWebhookId: async () => null,
}));
vi.mock("../../lib/release-resolver", () => ({
  resolveLatestVersion: async () => null,
  resolveLatestReleaseTag: async () => null,
  readApiVersion: () => "0.0.0",
}));
vi.mock("../../lib/image-registry", () => ({ resolveLatestImageDigest: async () => null }));
vi.mock("./folder/session-store", () => ({ getFolderSession: () => null }));
vi.mock("../../config", () => ({ env: { CLOUD_MODE: false, CLOUD_MAX_PROJECTS_PER_USER: 20 } }));

const load = () => import("./project-crud.service");
const ctx = { userId: "user_1", organizationId: "org_1" } as never;

describe("createProjectEnvironment", () => {
  beforeEach(() => {
    h.siblings = [{ ...h.base }];
    h.branches = [{ name: "main" }, { name: "staging" }];
    h.creates = [];
    h.freeGateCalls = 0;
    h.persistedRoutes = [];
  });

  it("writes NO row when the branch does not exist", async () => {
    const { createProjectEnvironment } = await load();
    await expect(
      createProjectEnvironment("proj_prod", ctx, {
        environmentName: "Ghost",
        gitBranch: "no-such-branch",
        sourceMode: "branch",
      } as never),
    ).rejects.toThrow(/was not found/);

    // The whole cascade started with a failed create that had already committed.
    expect(h.creates).toEqual([]);
  });

  it("never touches routing on the create path", async () => {
    const { createProjectEnvironment } = await load();
    await createProjectEnvironment("proj_prod", ctx, {
      environmentName: "Staging",
      gitBranch: "staging",
      sourceMode: "branch",
    } as never);

    expect(h.creates).toHaveLength(1);
    // Not gated, and nothing persisted: an environment is born with no endpoints and
    // `build.service` mints `defaultFreeEndpoint` on deploy instead — on the path that
    // actually carries the Cloud and quota checks.
    expect(h.freeGateCalls).toBe(0);
    expect(h.persistedRoutes).toEqual([]);
    expect(h.creates[0]).not.toHaveProperty("publicEndpoints");
  });

  it("still refuses a duplicate environment slug", async () => {
    h.siblings = [{ ...h.base }, { ...h.base, id: "proj_stg", environmentSlug: "staging" }];
    const { createProjectEnvironment } = await load();
    await expect(
      createProjectEnvironment("proj_prod", ctx, {
        environmentName: "Staging",
        gitBranch: "staging",
        sourceMode: "branch",
      } as never),
    ).rejects.toThrow(/already exists/);
    expect(h.creates).toEqual([]);
  });

  it("carries the branch onto the new environment row", async () => {
    const { createProjectEnvironment } = await load();
    const env = await createProjectEnvironment("proj_prod", ctx, {
      environmentName: "Staging",
      gitBranch: "staging",
      sourceMode: "branch",
    } as never);

    expect(h.creates[0]!.gitBranch).toBe("staging");
    expect(h.creates[0]!.groupId).toBe("grp_1");
    expect(env.gitBranch).toBe("staging");
  });
});
