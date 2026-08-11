import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which container "the project's logs" mean.
 *
 * `deployment.container_id` holds ONE service's container, written by the compose
 * deploy loop — and that loop walks services in dependency order, so for an app
 * that `dependsOn` postgres the column named POSTGRES. Project logs therefore
 * streamed the database while the app served traffic (#498), and no migration can
 * fix the rows already written that way.
 *
 * So the id is resolved LIVE from the host through the shared service matcher,
 * against the PRIMARY service — the one the access URL points at. Colocated in
 * `src/` deliberately: `apps/api/tsconfig.json` includes only `src/**`, so a test
 * under `test/**` is never typechecked and its fixtures can drift from the real
 * shapes.
 */

const h = vi.hoisted(() => ({
  containerId: "cid-db" as string | null,
  services: [] as Array<{ id: string; name: string; enabled: boolean; exposed: boolean }>,
  serviceRows: [] as Array<{ id: string; serviceId: string; containerId: string | null }>,
  live: [] as Array<{ id: string; names: string[]; state: string; labels: Record<string, string> }>,
  logTargets: [] as string[],
  healed: [] as Array<{ rowId: string; containerId: string }>,
  listByProjectCalls: 0,
  listByDeploymentCalls: 0,
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findById: async () => ({
        id: "proj_1",
        slug: "stack",
        organizationId: "org_1",
        activeDeploymentId: "dep_1",
      }),
    },
    deployment: {
      findById: async () => ({
        id: "dep_1",
        projectId: "proj_1",
        organizationId: "org_1",
        containerId: h.containerId,
        status: "ready",
        meta: { deployTarget: "server", serverId: "srv_1" },
      }),
    },
    service: {
      listByProject: async () => {
        h.listByProjectCalls += 1;
        return h.services;
      },
      listByDeployment: async () => {
        h.listByDeploymentCalls += 1;
        return h.serviceRows;
      },
      updateServiceDeployment: async (rowId: string, patch: { containerId?: string }) => {
        if (patch.containerId) h.healed.push({ rowId, containerId: patch.containerId });
      },
    },
    domain: { listByProject: async () => [] },
  },
}));

// The seam: a runtime that can enumerate the host's containers. The real matcher
// (services/live-state) runs against it unmocked — the label tiers are the thing
// under test as much as the picker is.
vi.mock("../../lib/deployment-runtime", () => ({
  withDeploymentRuntime: async (_dep: unknown, fn: (runtime: unknown) => Promise<unknown>) =>
    fn({
      supports: (cap: string) => cap === "hostContainerQuery",
      listAllContainers: async () => h.live,
      getRuntimeLogs: async (id: string) => {
        h.logTargets.push(id);
        return [];
      },
    }),
  resolveDeploymentRuntimeForRead: async () => {
    throw new Error("not used by getRuntimeLogs");
  },
  deploymentContainerIds: async () => [],
  withDeploymentPlatform: async () => {
    throw new Error("not used by getRuntimeLogs");
  },
}));

vi.mock("@repo/adapters", () => ({
  checkEdge: async () => ({ healthy: true, message: "" }),
  edgeProxy: async () => null,
  isRuntimeNotFoundError: () => false,
}));

const { getRuntimeLogs } = await import("./project-runtime.service");

/** `openship.service` carries the service NAME, not its id — see live-state's
 *  label tier. */
const container = (serviceName: string, id: string) => ({
  id,
  names: [`/openship-stack-${serviceName}`],
  state: "running",
  labels: { "openship.project": "proj_1", "openship.service": serviceName },
});

beforeEach(() => {
  h.containerId = "cid-db";
  h.services = [];
  h.serviceRows = [];
  h.live = [];
  h.logTargets = [];
  h.healed = [];
  h.listByProjectCalls = 0;
  h.listByDeploymentCalls = 0;
});

describe("project logs target the primary service, not the recorded database", () => {
  it("streams the exposed app even though the deployment row records the db", async () => {
    h.services = [
      { id: "svc_db", name: "db", enabled: true, exposed: false },
      { id: "svc_app", name: "app", enabled: true, exposed: true },
    ];
    h.serviceRows = [
      { id: "row_db", serviceId: "svc_db", containerId: "cid-db" },
      { id: "row_app", serviceId: "svc_app", containerId: "cid-app" },
    ];
    h.live = [container("db", "cid-db"), container("app", "cid-app")];

    await getRuntimeLogs("proj_1", "org_1");

    expect(h.logTargets).toEqual(["cid-app"]);
  });

  it("heals a stale service row from the live host instead of handing docker a dead id", async () => {
    h.services = [{ id: "svc_app", name: "app", enabled: true, exposed: true }];
    h.serviceRows = [{ id: "row_app", serviceId: "svc_app", containerId: "cid-old" }];
    h.live = [container("app", "cid-new")];

    await getRuntimeLogs("proj_1", "org_1");

    expect(h.logTargets).toEqual(["cid-new"]);
    expect(h.healed).toEqual([{ rowId: "row_app", containerId: "cid-new" }]);
  });

  it("uses the recorded id for a single-app deployment and never reads service rows", async () => {
    h.containerId = "cid-single";

    await getRuntimeLogs("proj_1", "org_1");

    expect(h.logTargets).toEqual(["cid-single"]);
    // One project-services read to establish there are none, and nothing further:
    // opening logs must not fan out per call.
    expect(h.listByProjectCalls).toBe(1);
    expect(h.listByDeploymentCalls).toBe(0);
  });

  it("refuses the compose sentinel rather than dialling a container named 'compose'", async () => {
    h.containerId = "compose";

    await expect(getRuntimeLogs("proj_1", "org_1")).rejects.toThrow(
      /No running container for project/,
    );
    expect(h.logTargets).toEqual([]);
  });
});
