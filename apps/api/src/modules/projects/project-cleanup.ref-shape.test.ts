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
  keep: { images: new Set<string>(), containers: new Set<string>() },
  removeRoute: vi.fn(async () => {}),
}));

vi.mock("@repo/db", () => ({
  repos: {
    service: {
      // Empty on purpose: a non-empty project service list pulls in the
      // adopted-container host sweep and the service-route block, neither of
      // which classifies a ref.
      listByProject: vi.fn(async () => []),
      listByDeployment: vi.fn(async (depId: string) => h.serviceRows[depId] ?? []),
    },
    deployment: { listByProject: vi.fn(async () => ({ rows: h.deployments })) },
    domain: { listByProject: vi.fn(async () => []) },
    server: { getInOrganization: vi.fn(async () => null) },
  },
}));

vi.mock("../../lib/deployment-runtime", () => ({
  resolveDeploymentRuntime: vi.fn(async () => ({ runtime: h.runtime })),
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
vi.mock("../../lib/routing-domains", () => ({ buildServiceRouteDomain: () => null }));
vi.mock("../../lib/managed-edge-proxy", () => ({
  releaseManagedHostnames: vi.fn(async () => ({ failures: [] as string[] })),
}));
vi.mock("../../lib/server-reachability", () => ({
  createReachabilityProbe: () => ({ isReachable: async () => true }),
}));
vi.mock("../../lib/cloud/transport", () => ({ resolveOrgCloudUserId: vi.fn(async () => null) }));
vi.mock("../services/live-state", () => ({ resolveLiveServiceState: () => new Map() }));

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
  h.keep = { images: new Set<string>(), containers: new Set<string>() };
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
});
