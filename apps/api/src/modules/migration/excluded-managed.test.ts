import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The idempotency gate's two jobs, which pull in opposite directions:
 *
 *  1. REFUSE a genuine re-import — re-adopting a live project's containers mints a
 *     duplicate project over them (`-2` services, routes on the wrong port).
 *  2. Never refuse because of OPENSHIP'S OWN containers. `linkSelfAppServices` binds
 *     the control plane's compose stack (`api`, `dashboard`, `edge`, `postgres`,
 *     `redis`) to the control-plane project, and those containers carry no
 *     `openship.*` labels — so a name-based selection matched them and the gate
 *     refused the user's whole migration, unretryably (#584).
 *
 * Job 2 is why this excludes rather than throws: adopting Openship into a user
 * project is forbidden outright (`assertNotControlPlane`), so there is no decision
 * for the operator — drop it and migrate the rest.
 */

const { findByContainerIds, findDeployment, findProject } = vi.hoisted(() => ({
  findByContainerIds: vi.fn(),
  findDeployment: vi.fn(),
  findProject: vi.fn(),
}));

// managed-containers is a leaf (repos + one pure helper), so a narrow mock is enough.
vi.mock("@repo/db", () => ({
  repos: {
    service: { findByContainerIds },
    deployment: { findById: findDeployment },
    project: { findById: findProject },
  },
}));

import { excludeAlreadyManaged } from "./managed-containers";
import type { DiscoveredService } from "./docker-reconcile";

const svc = (name: string, containerId: string): DiscoveredService =>
  ({
    name,
    source: "compose",
    containerId,
    running: true,
    ports: [],
    env: {},
    volumes: [],
    networks: [],
    dependsOn: [],
  }) as unknown as DiscoveredService;

const ORG = "org_1";
const USER_STACK = [svc("web", "c-web"), svc("postgres", "c-dependabot-pg")];
/** What a NAME-only client still sends: the user's stack plus our own postgres. */
const WITH_OURS = [...USER_STACK, svc("postgres", "c-openship-pg")];

/** `service_deployment`-shaped row. */
const row = (containerId: string, deploymentId: string) => ({ containerId, deploymentId });

beforeEach(() => {
  vi.clearAllMocks();
  findByContainerIds.mockResolvedValue([]);
  findDeployment.mockImplementation(async (id: string) =>
    id === "dep_openship"
      ? { id, organizationId: ORG, projectId: "prj_openship" }
      : { id, organizationId: ORG, projectId: "prj_user" },
  );
  findProject.mockImplementation(async (id: string) =>
    id === "prj_openship"
      ? { id, name: "Openship", appTemplateId: "openship", deletedAt: null }
      : { id, name: "dependabot", appTemplateId: null, deletedAt: null },
  );
});

describe("excludeAlreadyManaged — the control plane is not a re-import (#584)", () => {
  it("drops Openship's own container and keeps the user's stack", async () => {
    findByContainerIds.mockResolvedValue([row("c-openship-pg", "dep_openship")]);
    const kept = await excludeAlreadyManaged(WITH_OURS, ORG);
    expect(kept.map((s) => s.containerId)).toEqual(["c-web", "c-dependabot-pg"]);
  });

  it("does not throw when only Openship's container matched", async () => {
    // The exact #584 failure: this used to abort the whole migration.
    findByContainerIds.mockResolvedValue([row("c-openship-pg", "dep_openship")]);
    await expect(excludeAlreadyManaged(WITH_OURS, ORG)).resolves.toHaveLength(2);
  });

  it("errors usefully when the selection matched NOTHING but Openship", async () => {
    findByContainerIds.mockResolvedValue([row("c-openship-pg", "dep_openship")]);
    await expect(
      excludeAlreadyManaged([svc("postgres", "c-openship-pg")], ORG),
    ).rejects.toThrow(/Openship manages its own runtime/);
  });
});

describe("excludeAlreadyManaged — a genuine re-import is still refused", () => {
  it("throws when a user project already manages a selected container", async () => {
    findByContainerIds.mockResolvedValue([row("c-web", "dep_user")]);
    await expect(excludeAlreadyManaged(USER_STACK, ORG)).rejects.toThrow(
      /already managed here by project "dependabot"/,
    );
  });

  it("names the offending service and container", async () => {
    // "These containers are already managed" gave no way to tell which of six
    // services collided — the reason #584 read as "everything is already managed".
    findByContainerIds.mockResolvedValue([row("c-web", "dep_user")]);
    await expect(excludeAlreadyManaged(USER_STACK, ORG)).rejects.toThrow(
      /Service "web" \(container c-web\) is already managed/,
    );
  });

  it("refuses even when an Openship container matched in the same batch", async () => {
    // Excluding ours must not swallow a real conflict found alongside it.
    findByContainerIds.mockResolvedValue([
      row("c-openship-pg", "dep_openship"),
      row("c-web", "dep_user"),
    ]);
    await expect(excludeAlreadyManaged(WITH_OURS, ORG)).rejects.toThrow(/already managed here/);
  });
});

describe("excludeAlreadyManaged — rows that must not block anything", () => {
  it("ignores a row from another organization", async () => {
    findDeployment.mockResolvedValue({ id: "dep_x", organizationId: "org_other", projectId: "prj_user" });
    findByContainerIds.mockResolvedValue([row("c-web", "dep_x")]);
    await expect(excludeAlreadyManaged(USER_STACK, ORG)).resolves.toHaveLength(2);
  });

  it("ignores a soft-deleted project's row", async () => {
    findProject.mockResolvedValue({ id: "prj_user", name: "old", appTemplateId: null, deletedAt: new Date() });
    findByContainerIds.mockResolvedValue([row("c-web", "dep_user")]);
    await expect(excludeAlreadyManaged(USER_STACK, ORG)).resolves.toHaveLength(2);
  });

  it("ignores a row whose deployment is gone", async () => {
    findDeployment.mockResolvedValue(null);
    findByContainerIds.mockResolvedValue([row("c-web", "dep_gone")]);
    await expect(excludeAlreadyManaged(USER_STACK, ORG)).resolves.toHaveLength(2);
  });

  it("does not query at all when nothing has a container id", async () => {
    const declared = [{ name: "redis", source: "compose" } as unknown as DiscoveredService];
    await expect(excludeAlreadyManaged(declared, ORG)).resolves.toEqual(declared);
    expect(findByContainerIds).not.toHaveBeenCalled();
  });
});
