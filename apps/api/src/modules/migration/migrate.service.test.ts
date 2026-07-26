import { describe, it, expect } from "vitest";
import type { DiscoveredService } from "./docker-reconcile";
import { buildAdoptedServiceRows } from "./migrate.service";

/** Minimal DiscoveredService fixture — only the fields buildAdoptedServiceRows reads. */
const svc = (over: Partial<DiscoveredService> & { name: string }): DiscoveredService =>
  ({
    source: "container",
    running: true,
    ports: [],
    env: {},
    volumes: [],
    networks: [],
    dependsOn: [],
    warnings: [],
    ...over,
  }) as DiscoveredService;

describe("buildAdoptedServiceRows — repo-service rename (migration mapping)", () => {
  it("names the adopted row after the mapped repo service AND preserves the live volume + image", () => {
    // The exact same-server case: a moved `postgres` container mapped to the
    // repo's compose service `db`. It must adopt AS `db` (so the later reconcile
    // matches it in place, no duplicate) while KEEPING the original data volume.
    const chosen = [
      svc({
        name: "postgres",
        image: "postgres:16-alpine",
        volumes: [
          { type: "volume", source: "openship-openship-postgres", target: "/var/lib/postgresql/data", rw: true },
        ] as DiscoveredService["volumes"],
      }),
    ];
    const { rows, renames } = buildAdoptedServiceRows(
      chosen,
      new Set(["postgres"]),
      undefined,
      { postgres: "db" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("db"); // adopted under the repo service name
    expect(rows[0]!.volumes).toEqual(["openship-openship-postgres:/var/lib/postgresql/data"]); // volume verbatim
    expect(rows[0]!.image).toBe("postgres:16-alpine"); // running image reused, no build
    expect(rows[0]!.build).toBeUndefined();
    expect(renames).toEqual({ postgres: "db" });
  });

  it("remaps dependsOn onto the renamed rows", () => {
    const chosen = [svc({ name: "api", dependsOn: ["postgres"] }), svc({ name: "postgres" })];
    const { rows } = buildAdoptedServiceRows(chosen, new Set(["api", "postgres"]), undefined, {
      postgres: "db",
    });
    const api = rows.find((r) => r.name === "api");
    expect(api?.dependsOn).toEqual(["db"]); // dep points at the RENAMED row, not "postgres"
  });

  it("falls back to the discovered name when unmapped (identity renames)", () => {
    const { rows, renames } = buildAdoptedServiceRows([svc({ name: "web" })], new Set(["web"]), undefined, undefined);
    expect(rows[0]!.name).toBe("web");
    expect(renames).toEqual({ web: "web" });
  });
});
