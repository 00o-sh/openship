import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createDomainRepo } from "./domain.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

describe("domain.findOrCreateWithStatus", () => {
  let repo: ReturnType<typeof createDomainRepo>;

  beforeAll(async () => {
    const client = new PGlite("memory://");
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    // This repository contract does not depend on parent-row behavior. Disabling
    // FK triggers keeps the fixture focused and mirrors the other repo tests.
    await client.exec("SET session_replication_role = replica;");
    repo = createDomainRepo(db);
  }, 30_000);

  it("reports true only for the call that inserted the hostname", async () => {
    const input = {
      projectId: "proj_a",
      hostname: "App.Example.com",
      domainType: "custom",
      status: "pending",
      verified: false,
      isPrimary: false,
    };

    const first = await repo.findOrCreateWithStatus(input);
    const second = await repo.findOrCreateWithStatus(input);

    expect(first).toMatchObject({ created: true, domain: { hostname: "app.example.com" } });
    expect(second).toMatchObject({ created: false, domain: { id: first.domain.id } });
  });

  it("keeps the compatibility method returning the domain row", async () => {
    const row = await repo.findOrCreate({
      projectId: "proj_a",
      hostname: "other.example.com",
      domainType: "custom",
    });

    expect(row).toMatchObject({ hostname: "other.example.com", projectId: "proj_a" });
  });
});
