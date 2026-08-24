import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  orphans: [] as Array<Record<string, unknown>>,
  listAll: vi.fn(),
  findProject: vi.fn(async (): Promise<Record<string, unknown> | undefined> => undefined),
  deleteOrphan: vi.fn(async () => {}),
  bumpAttempt: vi.fn(async () => {}),
  isReachable: vi.fn(async () => true),
  resolveDeploymentPlatform: vi.fn(),
  disposePlatform: vi.fn(),
  removeRoute: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  convergeClaims: vi.fn(async () => ({
    released: 0,
    retained: [] as Array<{ port: number }>,
  })),
  edgeProxyFor: vi.fn(),
  edgeProxy: { listLoopbackUpstreamPortsStrict: vi.fn() },
  executor: { exec: vi.fn() },
  releaseManagedHostnames: vi.fn(async () => ({ failures: [] as string[] })),
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: h.findProject },
    orphanedResource: {
      listAll: h.listAll,
      delete: h.deleteOrphan,
      bumpAttempt: h.bumpAttempt,
    },
  },
}));

vi.mock("@repo/adapters", () => ({
  DockerRuntime: class DockerRuntime {},
  edgeProxyFor: h.edgeProxyFor,
  isRuntimeNotFoundError: () => false,
  ownsBuiltImage: () => false,
}));

vi.mock("../../lib/server-reachability", () => ({
  createReachabilityProbe: () => ({ isReachable: h.isReachable }),
}));

vi.mock("../../lib/remote-state", () => ({ isConnectionLoss: () => false }));

vi.mock("../../lib/deployment-runtime", () => ({
  resolveDeploymentPlatform: h.resolveDeploymentPlatform,
  disposePlatform: h.disposePlatform,
}));

vi.mock("../deployments/pinned-host-ports", () => ({
  convergeTargetHostPortClaims: h.convergeClaims,
}));

vi.mock("../../lib/managed-edge-proxy", () => ({
  releaseManagedHostnames: h.releaseManagedHostnames,
}));

import { runOrphanSweep } from "./orphan-gc-schedule";

const routeOrphan = (over: Record<string, unknown> = {}) => ({
  id: "orphan-route-1",
  organizationId: "org-1",
  serverId: "server-1",
  resourceType: "route",
  ref: "app.example.com",
  projectId: "project-1",
  label: "project route",
  runtimeMode: "docker",
  payload: null,
  attempts: 0,
  lastAttemptAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

const resolvedPlatform = (over: Record<string, unknown> = {}) => ({
  platform: {
    target: "selfhosted",
    runtime: { name: "docker", destroy: h.destroy },
    routing: { removeRoute: h.removeRoute },
    ssl: {},
    system: null,
    executor: h.executor,
    localHost: false,
  },
  effectiveTarget: "server",
  runtimeMode: "docker",
  usesManagedRouting: false,
  serverId: "server-1",
  hostPortTarget: {
    targetKey: `host:${"a".repeat(64)}`,
    legacyTargetKeys: ["server:server-1"],
    stable: true,
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.orphans = [];
  h.listAll.mockImplementation(async () => h.orphans);
  h.resolveDeploymentPlatform.mockResolvedValue(resolvedPlatform());
  h.findProject.mockResolvedValue(undefined);
  h.convergeClaims.mockResolvedValue({ released: 0, retained: [] });
  h.edgeProxyFor.mockReturnValue(h.edgeProxy);
});

describe("runOrphanSweep route claim lifecycle", () => {
  it("removes the route, freshly converges its target claims, then deletes the orphan row", async () => {
    h.orphans = [routeOrphan()];

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 1, deferred: 0 });

    expect(h.isReachable).toHaveBeenCalledWith("server-1");
    expect(h.resolveDeploymentPlatform).toHaveBeenCalledWith(
      { deployTarget: "server", runtimeMode: "docker", serverId: "server-1" },
      { organizationId: "org-1" },
    );
    expect(h.removeRoute).toHaveBeenCalledWith("app.example.com");
    expect(h.edgeProxyFor).toHaveBeenCalledWith(h.executor, "openresty", { ours: true });
    expect(h.convergeClaims).toHaveBeenCalledWith({
      target: {
        targetKey: `host:${"a".repeat(64)}`,
        legacyTargetKeys: ["server:server-1"],
        stable: true,
      },
      projectId: "project-1",
      desiredPublishes: [],
      edgeProxy: h.edgeProxy,
    });
    expect(h.deleteOrphan).toHaveBeenCalledWith("orphan-route-1");
    expect(h.bumpAttempt).not.toHaveBeenCalled();

    expect(h.removeRoute.mock.invocationCallOrder[0]).toBeLessThan(
      h.convergeClaims.mock.invocationCallOrder[0]!,
    );
    expect(h.convergeClaims.mock.invocationCallOrder[0]).toBeLessThan(
      h.deleteOrphan.mock.invocationCallOrder[0]!,
    );
  });

  it("defers the orphan and keeps its row when fresh claim convergence fails", async () => {
    h.orphans = [routeOrphan()];
    h.convergeClaims.mockRejectedValueOnce(new Error("strict edge scan failed"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 0, deferred: 1 });

    expect(h.removeRoute).toHaveBeenCalledWith("app.example.com");
    expect(h.convergeClaims).toHaveBeenCalledOnce();
    expect(h.bumpAttempt).toHaveBeenCalledWith("orphan-route-1");
    expect(h.deleteOrphan).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      "[orphan-gc] route app.example.com failed:",
      "strict edge scan failed",
    );

    errorLog.mockRestore();
  });

  it("defers while the originating project row still exists", async () => {
    h.orphans = [routeOrphan()];
    h.findProject.mockResolvedValueOnce({ id: "project-1", deletionInProgress: true });

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 0, deferred: 1 });

    expect(h.bumpAttempt).toHaveBeenCalledWith("orphan-route-1");
    expect(h.resolveDeploymentPlatform).not.toHaveBeenCalled();
    expect(h.removeRoute).not.toHaveBeenCalled();
    expect(h.convergeClaims).not.toHaveBeenCalled();
    expect(h.deleteOrphan).not.toHaveBeenCalled();
  });

  it("keeps the route orphan while another vhost still protects a project claim", async () => {
    h.orphans = [routeOrphan()];
    h.convergeClaims.mockResolvedValueOnce({
      released: 0,
      retained: [{ port: 23_000 }],
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 0, deferred: 1 });

    expect(h.bumpAttempt).toHaveBeenCalledWith("orphan-route-1");
    expect(h.deleteOrphan).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      "[orphan-gc] route app.example.com failed:",
      expect.stringContaining("23000"),
    );

    errorLog.mockRestore();
  });

  it("does not remove a route or release claims while a same-target workload cleanup failed", async () => {
    h.orphans = [
      routeOrphan({
        id: "orphan-container-1",
        resourceType: "container",
        ref: "container-1",
        label: "container 1",
      }),
      routeOrphan(),
    ];
    h.destroy.mockRejectedValueOnce(new Error("container destroy failed"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 0, deferred: 2 });

    expect(h.bumpAttempt).toHaveBeenCalledWith("orphan-container-1");
    expect(h.bumpAttempt).toHaveBeenCalledWith("orphan-route-1");
    expect(h.removeRoute).not.toHaveBeenCalled();
    expect(h.convergeClaims).not.toHaveBeenCalled();
    expect(h.deleteOrphan).not.toHaveBeenCalled();

    errorLog.mockRestore();
  });
});

describe("runOrphanSweep target selection", () => {
  it("resolves a null-server docker orphan as local self-hosted, never cloud", async () => {
    h.orphans = [
      routeOrphan({
        id: "orphan-container-1",
        serverId: null,
        resourceType: "container",
        ref: "container-1",
        projectId: null,
      }),
    ];
    h.resolveDeploymentPlatform.mockResolvedValue(
      resolvedPlatform({
        effectiveTarget: "local",
        serverId: null,
        hostPortTarget: { targetKey: "local", legacyTargetKeys: [], stable: true },
        platform: {
          ...resolvedPlatform().platform,
          localHost: true,
        },
      }),
    );

    await expect(runOrphanSweep()).resolves.toEqual({ reclaimed: 1, deferred: 0 });

    expect(h.resolveDeploymentPlatform).toHaveBeenCalledOnce();
    expect(h.resolveDeploymentPlatform).toHaveBeenCalledWith(
      { deployTarget: "local", runtimeMode: "docker" },
      { organizationId: "org-1" },
    );
    expect(h.isReachable).not.toHaveBeenCalled();
    expect(h.destroy).toHaveBeenCalledWith("container-1");
    expect(h.releaseManagedHostnames).not.toHaveBeenCalled();
    expect(h.deleteOrphan).toHaveBeenCalledWith("orphan-container-1");
  });
});
