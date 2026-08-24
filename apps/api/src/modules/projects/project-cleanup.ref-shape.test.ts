import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

/**
 * A cleanup resource's TYPE comes from the REF's SHAPE, never from the column it
 * was read out of (issue #640).
 *
 * `deployment.image_ref` / `container_id` and `service_deployment.image_ref` each
 * hold EITHER a Docker tag/id OR a host DIRECTORY — a static deploy's build output
 * or its release dir. The manifest collectors used to decide by runtime class
 * alone, so a directory was manifested as `type: "image"` and `destroyResourceOnce`
 * handed it to `runtime.removeImage`. Docker cannot delete a directory and that
 * failure is not a 404, so it was rethrown, `runtime_cleanup` failed, the
 * teardown's atomicity gate kept the row — and the project could never be deleted
 * again. Every static project was one delete away from being permanently stuck.
 *
 * Pinned here:
 *   • a leading-slash ref is an `artifact`, a tag stays an `image` — for the
 *     deployment's own columns AND for each service row's
 *   • a path-shaped containerId is an `artifact`, not a `container`
 *   • `wipeVolumes` never inspects a directory for named volumes (a directory owns
 *     none, and the inspect burns the whole 10s ceiling on a docker-over-SSH bridge)
 *   • the verbs those types select, through the real `executeCleanup`
 *   • a single-deployment teardown honours the keep set for a PATH too — the
 *     doc-root the edge is currently serving must survive a sibling's deletion
 *
 * The runtime double is a REAL `DockerRuntime`: the classification branch is
 * literally `runtime instanceof DockerRuntime`, and spying the real class means
 * `destroy` / `removeImage` are the real method names rather than names a fake
 * class agreed with itself on. Nothing reaches a daemon — the socket transport's
 * `establish()` only returns `{ socketPath }`, and every daemon-touching method is
 * spied below.
 */

const h = vi.hoisted(() => ({
  /** The DockerRuntime every deployment resolves to. Assigned in beforeAll. */
  runtime: null as unknown,
  deployments: [] as Record<string, unknown>[],
  /** deployment id → its service_deployment rows. */
  serviceRows: {} as Record<string, Record<string, unknown>[]>,
  projectServices: [] as Record<string, unknown>[],
  domains: [] as Record<string, unknown>[],
  derivedServiceRoutes: [] as Array<{ hostname: string }>,
  resolvedByDeployment: {} as Record<string, Record<string, unknown>>,
  resolveErrors: {} as Record<string, Error>,
  keep: { images: new Set<string>(), containers: new Set<string>() },
  removeRoute: vi.fn(async () => {}),
  convergeClaims: vi.fn(async () => ({
    released: 0,
    retained: [] as Array<{ port: number }>,
  })),
  isReachable: vi.fn(async () => true),
  getServer: vi.fn(async () => null as Record<string, unknown> | null),
}));

vi.mock("@repo/db", () => ({
  repos: {
    service: {
      listByProject: vi.fn(async () => h.projectServices),
      listByDeployment: vi.fn(async (depId: string) => h.serviceRows[depId] ?? []),
    },
    deployment: { listByProject: vi.fn(async () => ({ rows: h.deployments })) },
    domain: { listByProject: vi.fn(async () => h.domains) },
    server: { getInOrganization: h.getServer },
  },
}));

vi.mock("../../lib/deployment-runtime", () => ({
  resolveDeploymentRuntime: vi.fn(async (dep: { id: string }) =>
    h.resolveErrors[dep.id]
      ? Promise.reject(h.resolveErrors[dep.id])
      : h.resolvedByDeployment[dep.id]
        ? { runtime: h.runtime, ...h.resolvedByDeployment[dep.id] }
        : { runtime: h.runtime },
  ),
  disposeRuntime: vi.fn(),
  resolveDeploymentPlatform: vi.fn(async () => {
    throw new Error("no cloud workspace in these fixtures");
  }),
}));

// `platform().runtime` must NOT be a DockerRuntime, or the local-host sweep adds a
// second, unspied runtime that would talk to a real daemon.
vi.mock("../../lib/controller-helpers", () => ({
  platform: () => ({ runtime: { name: "bare" }, routing: { removeRoute: h.removeRoute } }),
}));

vi.mock("./cleanup-keep-set", () => ({ computeCleanupKeepSet: vi.fn(async () => h.keep) }));
vi.mock("../../lib/routing-domains", () => ({
  buildServiceRouteDomains: () => h.derivedServiceRoutes,
}));
vi.mock("../../lib/managed-edge-proxy", () => ({
  releaseManagedHostnames: vi.fn(async () => ({ failures: [] as string[] })),
}));
vi.mock("../../lib/server-reachability", () => ({
  createReachabilityProbe: () => ({ isReachable: h.isReachable }),
}));
vi.mock("../../lib/cloud/transport", () => ({ resolveOrgCloudUserId: vi.fn(async () => null) }));
vi.mock("../services/live-state", () => ({ resolveLiveServiceState: () => new Map() }));
vi.mock("../deployments/pinned-host-ports", () => ({
  convergeTargetHostPortClaims: h.convergeClaims,
}));

import { DockerRuntime } from "@repo/adapters";
import {
  collectDeploymentManifest,
  collectProjectManifest,
  executeCleanup,
  type CleanupManifest,
} from "./project-cleanup.service";

/** A compose static sub-app's doc-root, as written into `service_deployment.image_ref`. */
const STATIC_BUILD_DIR = "/opt/openship/static/.builds/bld_1-svc_1";
/** A single-app static release dir, as written into `deployment.container_id`. */
const STATIC_RELEASE_DIR = "/opt/openship/static/releases/dep_1";
/** A tag: slashes inside, never a LEADING one — which is exactly the test. */
const IMAGE_TAG = "openship/app-web:bld_1";
/** Pulled registry content belongs to the registry/daemon cache, not one deployment. */
const FOREIGN_IMAGE = `ghcr.io/acme/release@sha256:${"a".repeat(64)}`;

const project = {
  id: "p1",
  slug: "app",
  organizationId: "org1",
  cloudWorkspaceId: null,
  activeDeploymentId: null,
};

const deployment = (over: Record<string, unknown> = {}) => ({
  id: "dep_1",
  projectId: "p1",
  organizationId: "org1",
  containerId: null,
  imageRef: null,
  meta: { runtimeMode: "docker" },
  ...over,
});

const serviceRow = (over: Record<string, unknown> = {}) => ({
  serviceId: "svc_1",
  containerId: null,
  imageRef: null,
  ...over,
});

const typesOf = (manifest: CleanupManifest, ref: string) =>
  manifest.resources.filter((r) => r.ref === ref).map((r) => r.type);

let docker: DockerRuntime;

beforeAll(async () => {
  docker = await DockerRuntime.create({ transport: "socket" });
  h.runtime = docker;
  vi.spyOn(docker, "destroy").mockResolvedValue(undefined);
  vi.spyOn(docker, "removeImage").mockResolvedValue(undefined);
  vi.spyOn(docker, "removeNetwork").mockResolvedValue(undefined);
  vi.spyOn(docker, "removeVolume").mockResolvedValue(undefined);
  vi.spyOn(docker, "inspectNamedVolumes").mockResolvedValue([]);
  vi.spyOn(docker, "listProjectContainerIds").mockResolvedValue([]);
  vi.spyOn(docker, "listAllContainers").mockResolvedValue([]);
  vi.spyOn(docker, "listProjectImages").mockResolvedValue([]);
});

beforeEach(() => {
  vi.clearAllMocks();
  h.deployments = [];
  h.serviceRows = {};
  h.projectServices = [];
  h.domains = [];
  h.derivedServiceRoutes = [];
  h.resolvedByDeployment = {};
  h.resolveErrors = {};
  h.keep = { images: new Set<string>(), containers: new Set<string>() };
  h.isReachable.mockResolvedValue(true);
  h.getServer.mockResolvedValue(null);
});

describe("collectProjectManifest — a ref is classified by its shape", () => {
  it("a service row's static build DIRECTORY is an artifact, never an image", async () => {
    h.deployments = [deployment()];
    h.serviceRows.dep_1 = [serviceRow({ imageRef: STATIC_BUILD_DIR })];

    const manifest = await collectProjectManifest(project as never);

    expect(typesOf(manifest, STATIC_BUILD_DIR)).toEqual(["artifact"]);
    expect(manifest.resources.some((r) => r.type === "image")).toBe(false);
  });

  it("a real tag on a sibling service row is still an image", async () => {
    h.deployments = [deployment()];
    h.serviceRows.dep_1 = [
      serviceRow({ serviceId: "svc_1", imageRef: STATIC_BUILD_DIR }),
      serviceRow({ serviceId: "svc_2", imageRef: IMAGE_TAG }),
    ];

    const manifest = await collectProjectManifest(project as never);

    expect(typesOf(manifest, IMAGE_TAG)).toEqual(["image"]);
    expect(typesOf(manifest, STATIC_BUILD_DIR)).toEqual(["artifact"]);
  });

  it("never claims pulled registry images as project-owned cleanup resources", async () => {
    h.deployments = [deployment({ imageRef: FOREIGN_IMAGE })];
    h.serviceRows.dep_1 = [serviceRow({ imageRef: "postgres:17" })];

    const manifest = await collectProjectManifest(project as never);

    expect(typesOf(manifest, FOREIGN_IMAGE)).toEqual([]);
    expect(typesOf(manifest, "postgres:17")).toEqual([]);
  });

  it("the deployment's OWN image_ref is an artifact when it holds a directory", async () => {
    const singleAppOutput = "/opt/openship/static/.builds/bld_2";
    h.deployments = [deployment({ imageRef: singleAppOutput })];

    const manifest = await collectProjectManifest(project as never);

    expect(typesOf(manifest, singleAppOutput)).toEqual(["artifact"]);
  });

  it("a path-shaped container_id is an artifact, not a container", async () => {
    h.deployments = [deployment({ containerId: STATIC_RELEASE_DIR })];

    const manifest = await collectProjectManifest(project as never);

    expect(typesOf(manifest, STATIC_RELEASE_DIR)).toEqual(["artifact"]);
    // The type is what the force-orphan `resourceType` column and the deletion
    // preview read — a directory filed as a container is an orphan row the GC
    // then hands to the container resolver.
    expect(manifest.resources.some((r) => r.type === "container")).toBe(false);
  });

  it("wipeVolumes never asks the daemon for a directory's named volumes", async () => {
    h.deployments = [
      deployment({ id: "dep_1", containerId: STATIC_RELEASE_DIR }),
      deployment({ id: "dep_2", containerId: "9f1c2b3a4d5e" }),
    ];

    const manifest = await collectProjectManifest(project as never, { wipeVolumes: true });

    // The real container IS inspected — so the exclusion below is a wired spy
    // saying "not for the directory", not a vacuously silent one.
    expect(docker.inspectNamedVolumes).toHaveBeenCalledTimes(1);
    expect(docker.inspectNamedVolumes).toHaveBeenCalledWith("9f1c2b3a4d5e");
    expect(typesOf(manifest, STATIC_RELEASE_DIR)).toEqual(["artifact"]);
  });

  it("keeps identical artifact refs distinct across historical server targets", async () => {
    h.deployments = [
      deployment({ id: "dep_a", imageRef: STATIC_BUILD_DIR }),
      deployment({ id: "dep_b", imageRef: STATIC_BUILD_DIR }),
    ];
    h.resolvedByDeployment = {
      dep_a: {
        serverId: "server-a",
        hostPortTarget: {
          targetKey: `host:${"a".repeat(64)}`,
          legacyTargetKeys: [],
          stable: true,
        },
        executor: null,
      },
      dep_b: {
        serverId: "server-b",
        hostPortTarget: {
          targetKey: `host:${"b".repeat(64)}`,
          legacyTargetKeys: [],
          stable: true,
        },
        executor: null,
      },
    };

    const manifest = await collectProjectManifest(project as never);
    const artifacts = manifest.resources.filter(
      (resource) => resource.type === "artifact" && resource.ref === STATIC_BUILD_DIR,
    );

    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((resource) => resource.serverId).sort()).toEqual(["server-a", "server-b"]);
    expect(artifacts.every((resource) => resource.runtimeMode === "docker")).toBe(true);
  });

  it("carries an unreachable historical server as a deferred route target", async () => {
    h.deployments = [
      deployment({
        id: "dep_remote",
        containerId: "remote-container",
        meta: { serverId: "server-remote", runtimeMode: "bare" },
      }),
    ];
    h.isReachable.mockResolvedValueOnce(false);
    h.getServer.mockResolvedValueOnce({ id: "server-remote" });

    const manifest = await collectProjectManifest(project as never);

    expect(manifest.unreachableRouteTargets).toEqual([
      { serverId: "server-remote", runtimeMode: "bare" },
    ]);
    expect(manifest.resources).toContainEqual(
      expect.objectContaining({
        type: "unreachable",
        ref: "remote-container",
        serverId: "server-remote",
        runtimeMode: "bare",
      }),
    );
  });

  it("fails closed when a local deployment with known resources cannot resolve", async () => {
    h.deployments = [deployment({ id: "dep_local", containerId: "local-container" })];
    h.resolveErrors.dep_local = new Error("local runtime unavailable");

    await expect(collectProjectManifest(project as never)).rejects.toThrow(
      "Could not resolve cleanup target for deployment dep_local",
    );
  });

  it("deduplicates stored and derived service routes while keeping every endpoint", async () => {
    h.projectServices = [{ id: "svc_1", name: "web" }];
    h.domains = [{ hostname: "WEB.EXAMPLE.COM" }];
    h.derivedServiceRoutes = [{ hostname: "web.example.com" }, { hostname: "api.example.com" }];

    const manifest = await collectProjectManifest(project as never);
    const routes = manifest.resources.filter((resource) => resource.type === "route");

    expect(routes.map((route) => route.ref).sort()).toEqual(["api.example.com", "web.example.com"]);
  });
});

describe("executeCleanup — the resource type selects the verb", () => {
  it("removeImage gets the tag and only the tag; destroy gets the directory", async () => {
    h.deployments = [deployment({ imageRef: IMAGE_TAG })];
    h.serviceRows.dep_1 = [serviceRow({ imageRef: STATIC_BUILD_DIR })];

    const manifest = await collectProjectManifest(project as never);
    const result = await executeCleanup(manifest);

    expect(result.failed).toEqual([]);
    expect(docker.removeImage).toHaveBeenCalledTimes(1);
    expect(docker.removeImage).toHaveBeenCalledWith(IMAGE_TAG);
    // The pre-#640 manifest handed this exact directory to removeImage, whose
    // failure is not a 404 and so blocked the delete forever.
    for (const [ref] of vi.mocked(docker.removeImage).mock.calls) {
      expect(ref.startsWith("/")).toBe(false);
    }
    expect(docker.destroy).toHaveBeenCalledTimes(1);
    expect(docker.destroy).toHaveBeenCalledWith(STATIC_BUILD_DIR);
  });

  it("removes a route from every resolved physical deployment target", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const manifest: CleanupManifest = {
      projectId: "p1",
      organizationId: "org1",
      resources: [
        { type: "route", ref: "app.example.com", label: "route app.example.com", runtime: null },
      ],
      routeContexts: [
        {
          key: "host:a",
          routing: { removeRoute: first } as never,
          hostPortTarget: {
            targetKey: `host:${"a".repeat(64)}`,
            legacyTargetKeys: [],
            stable: true,
          },
          serverId: "srv-a",
          runtimeMode: "docker",
          edgeProxy: { listLoopbackUpstreamPortsStrict: vi.fn(async () => new Set<number>()) },
        },
        {
          key: "host:b",
          routing: { removeRoute: second } as never,
          hostPortTarget: {
            targetKey: `host:${"b".repeat(64)}`,
            legacyTargetKeys: [],
            stable: true,
          },
          serverId: "srv-b",
          runtimeMode: "docker",
          edgeProxy: { listLoopbackUpstreamPortsStrict: vi.fn(async () => new Set<number>()) },
        },
      ],
    };

    const result = await executeCleanup(manifest);

    expect(result.failed).toEqual([]);
    expect(first).toHaveBeenCalledWith("app.example.com");
    expect(second).toHaveBeenCalledWith("app.example.com");
    expect(h.convergeClaims).toHaveBeenCalledTimes(2);
    expect(h.convergeClaims).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: expect.objectContaining({ targetKey: `host:${"a".repeat(64)}` }),
        projectId: "p1",
        desiredPublishes: [],
      }),
    );
    expect(h.convergeClaims).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: expect.objectContaining({ targetKey: `host:${"b".repeat(64)}` }),
        projectId: "p1",
        desiredPublishes: [],
      }),
    );
  });

  it("keeps cleanup incomplete while the target edge still protects a project claim", async () => {
    h.convergeClaims.mockResolvedValueOnce({
      released: 0,
      retained: [{ port: 20_123 }],
    });
    const manifest: CleanupManifest = {
      projectId: "p1",
      resources: [],
      routeContexts: [
        {
          key: "local",
          routing: { removeRoute: vi.fn(async () => {}) } as never,
          hostPortTarget: { targetKey: "local", legacyTargetKeys: [], stable: true },
          serverId: null,
          runtimeMode: "docker",
          edgeProxy: { listLoopbackUpstreamPortsStrict: vi.fn(async () => new Set<number>()) },
        },
      ],
    };

    const result = await executeCleanup(manifest);

    expect(result.failed).toEqual([
      expect.objectContaining({
        ref: "local",
        type: "route",
        error: expect.stringContaining("20123"),
      }),
    ]);
  });

  it("never releases claims after any workload or route cleanup failure", async () => {
    vi.useFakeTimers();
    try {
      h.convergeClaims.mockClear();
      const removeRoute = vi.fn(async () => {
        throw new Error("remote edge reload failed");
      });
      const manifest: CleanupManifest = {
        projectId: "p1",
        resources: [
          { type: "route", ref: "app.example.com", label: "route app.example.com", runtime: null },
        ],
        routeContexts: [
          {
            key: "local",
            routing: { removeRoute } as never,
            hostPortTarget: { targetKey: "local", legacyTargetKeys: [], stable: true },
            serverId: null,
            runtimeMode: "docker",
            edgeProxy: { listLoopbackUpstreamPortsStrict: vi.fn(async () => new Set<number>()) },
          },
        ],
      };

      const pending = executeCleanup(manifest);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.failed).toEqual([
        expect.objectContaining({ ref: "app.example.com", type: "route" }),
      ]);
      expect(removeRoute).toHaveBeenCalledTimes(2);
      expect(h.convergeClaims).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not misdirect an unreachable remote route removal to the process edge", async () => {
    const manifest: CleanupManifest = {
      projectId: "p1",
      organizationId: "org1",
      resources: [
        { type: "route", ref: "app.example.com", label: "route app.example.com", runtime: null },
      ],
      routeContexts: [],
      unreachableRouteTargets: [{ serverId: "server-remote", runtimeMode: "docker" }],
    };

    const result = await executeCleanup(manifest);

    expect(result.failed).toEqual([]);
    expect(h.removeRoute).not.toHaveBeenCalled();
    expect(h.convergeClaims).not.toHaveBeenCalled();
  });
});

describe("collectDeploymentManifest — protectRetained covers directories too", () => {
  it("omits a doc-root a live release still serves, emits the one it doesn't", async () => {
    const liveDocRoot = "/opt/openship/static/.builds/bld_live-svc_1";
    h.keep = { images: new Set([liveDocRoot]), containers: new Set<string>() };
    h.serviceRows.dep_9 = [
      serviceRow({ serviceId: "svc_1", imageRef: liveDocRoot }),
      serviceRow({ serviceId: "svc_2", imageRef: STATIC_BUILD_DIR }),
    ];

    const manifest = await collectDeploymentManifest(
      deployment({ id: "dep_9" }) as never,
      project as never,
      { protectRetained: true },
    );

    expect(typesOf(manifest, liveDocRoot)).toEqual([]);
    expect(typesOf(manifest, STATIC_BUILD_DIR)).toEqual(["artifact"]);
  });

  it("never schedules a pulled release image for removal", async () => {
    const manifest = await collectDeploymentManifest(
      deployment({ id: "dep_release", imageRef: FOREIGN_IMAGE }) as never,
      project as never,
      { protectRetained: false },
    );

    expect(typesOf(manifest, FOREIGN_IMAGE)).toEqual([]);
  });
});
