import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_MASK } from "@repo/core";

const projectRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const serviceRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
  listByProject: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: { ...actual.repos, project: projectRepo, service: serviceRepo },
  };
});

import { updateService } from "../../../src/modules/services/service.service";

const ctx = { organizationId: "org_1" } as never;
const project = { id: "proj_1", organizationId: "org_1", internalAlias: null };

const initialEnv = {
  GEMINI_API_KEY: "secret-gemini-key-12345",
  TEST_AUTH: "true",
  DATABASE_URL: "postgres://user:pass@db:5432/inventar",
  MARKET_ENDPOINT: "https://market.inventar.example.com",
  BUILD_REVISION: "v1.2.0",
};

const row = (over: Record<string, unknown> = {}) => ({
  id: "svc_inventar",
  projectId: project.id,
  name: "inventar",
  kind: "compose",
  image: "inventar:latest",
  environment: { ...initialEnv },
  ports: [],
  restart: "unless-stopped",
  enabled: true,
  exposed: false,
  ...over,
});

const written = () => serviceRepo.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;

beforeEach(() => {
  projectRepo.findById.mockReset().mockResolvedValue(project);
  serviceRepo.findById.mockReset().mockResolvedValue(row());
  serviceRepo.update.mockReset().mockResolvedValue(undefined);
  serviceRepo.listByProject.mockReset().mockResolvedValue([]);
});

describe("updateService — environment partial updates merge rather than replace", () => {
  it("preserves untouched environment variables when applying a single-field probe or partial update", async () => {
    await updateService(ctx, project.id, "svc_inventar", {
      environment: {
        PROBE_FIELD: "test",
      },
    } as never);

    expect(written().environment).toEqual({
      ...initialEnv,
      PROBE_FIELD: "test",
    });
  });

  it("updates existing variable while preserving all other variables", async () => {
    await updateService(ctx, project.id, "svc_inventar", {
      environment: {
        BUILD_REVISION: "v1.2.1",
      },
    } as never);

    expect(written().environment).toEqual({
      ...initialEnv,
      BUILD_REVISION: "v1.2.1",
    });
  });

  it("deletes a variable when explicitly set to null while preserving other variables", async () => {
    await updateService(ctx, project.id, "svc_inventar", {
      environment: {
        BUILD_REVISION: null,
      },
    } as never);

    expect(written().environment).toEqual({
      GEMINI_API_KEY: "secret-gemini-key-12345",
      TEST_AUTH: "true",
      DATABASE_URL: "postgres://user:pass@db:5432/inventar",
      MARKET_ENDPOINT: "https://market.inventar.example.com",
    });
  });

  it("restores masked secret sentinels to their stored values", async () => {
    await updateService(ctx, project.id, "svc_inventar", {
      environment: {
        GEMINI_API_KEY: ENV_MASK,
        NEW_KEY: "new_value",
      },
    } as never);

    expect(written().environment).toEqual({
      ...initialEnv,
      NEW_KEY: "new_value",
    });
  });

  it("clears the entire environment map when explicitly passed null", async () => {
    await updateService(ctx, project.id, "svc_inventar", {
      environment: null,
    } as never);

    expect(written().environment).toEqual({});
  });

  it("leaves environment unchanged when environment is not mentioned in patch", async () => {
    await updateService(ctx, project.id, "svc_inventar", {
      restart: "always",
    } as never);

    expect(written()).not.toHaveProperty("environment");
  });
});
