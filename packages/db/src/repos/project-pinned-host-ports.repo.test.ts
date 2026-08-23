import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createProjectRepo } from "./project.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

async function freshDb() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;");
  return { db, repo: createProjectRepo(db) };
}

type Db = Awaited<ReturnType<typeof freshDb>>["db"];

async function seedProject(
  db: Db,
  id: string,
  opts: {
    organizationId?: string;
    serverId?: string | null;
    legacyMetaServerId?: string | null;
    hostPort?: number | null;
    active?: boolean;
    deleted?: boolean;
  } = {},
) {
  const organizationId = opts.organizationId ?? "org_1";
  const active = opts.active ?? true;
  const deploymentId = `dep_${id}`;
  if (active) {
    await db.insert(schema.deployment).values({
      id: deploymentId,
      projectId: id,
      organizationId,
      branch: "main",
      status: "ready",
      meta: opts.legacyMetaServerId ? { serverId: opts.legacyMetaServerId } : {},
    });
  }
  await db.insert(schema.project).values({
    id,
    organizationId,
    groupId: `app_${id}`,
    name: id,
    slug: id,
    serverId: opts.serverId ?? null,
    activeDeploymentId: active ? deploymentId : null,
    hostPort: opts.hostPort ?? null,
    deletedAt: opts.deleted ? new Date() : null,
  });
  return deploymentId;
}

async function seedServicePin(db: Db, deploymentId: string, serviceId: string, hostPort: number) {
  await db.insert(schema.serviceDeployment).values({
    id: `sd_${serviceId}`,
    deploymentId,
    serviceId,
    serviceName: serviceId,
    status: "success",
    hostPort,
  });
}

describe("project.listActivePinnedHostPorts", () => {
  let db: Db;
  let repo: ReturnType<typeof createProjectRepo>;

  beforeEach(async () => {
    ({ db, repo } = await freshDb());
  }, 30_000);

  it("returns single-service and compose claims on the requested server only", async () => {
    await seedProject(db, "single-a", { serverId: "srv-a", hostPort: 20001 });
    const composeA = await seedProject(db, "compose-a", { serverId: "srv-a" });
    await seedServicePin(db, composeA, "api-a", 20002);
    await seedProject(db, "single-b", { serverId: "srv-b", hostPort: 20001 });
    const composeB = await seedProject(db, "compose-b", { serverId: "srv-b" });
    await seedServicePin(db, composeB, "api-b", 20002);

    expect(await repo.listActivePinnedHostPorts("org_1", "srv-a")).toEqual(
      expect.arrayContaining([
        { projectId: "single-a", serviceId: null, port: 20001 },
        { projectId: "compose-a", serviceId: "api-a", port: 20002 },
      ]),
    );
    expect(await repo.listActivePinnedHostPorts("org_1", "srv-a")).toHaveLength(2);
  });

  it("uses the active deployment metadata fallback for legacy server bindings", async () => {
    await seedProject(db, "legacy", {
      serverId: null,
      legacyMetaServerId: "srv-a",
      hostPort: 20003,
    });

    expect(await repo.listActivePinnedHostPorts("org_1", "srv-a")).toEqual([
      { projectId: "legacy", serviceId: null, port: 20003 },
    ]);
  });

  it("treats null as the local host and excludes remote, inactive, deleted, and foreign rows", async () => {
    await seedProject(db, "local", { hostPort: 20004 });
    await seedProject(db, "remote", { serverId: "srv-a", hostPort: 20005 });
    await seedProject(db, "inactive", { hostPort: 20006, active: false });
    await seedProject(db, "deleted", { hostPort: 20007, deleted: true });
    await seedProject(db, "foreign", { organizationId: "org_2", hostPort: 20008 });

    expect(await repo.listActivePinnedHostPorts("org_1", null)).toEqual([
      { projectId: "local", serviceId: null, port: 20004 },
    ]);
  });
});
