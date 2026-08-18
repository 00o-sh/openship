import { describe, expect, it } from "vitest";

import { parseComposeFile } from "../../../src/lib/compose-parser";
import {
  mergeServiceDeployEnv,
  type ServiceEnvLayers,
} from "../../../src/modules/deployments/compose/deploy.service";

/**
 * Fix for Issue #614:
 * Compose passthrough environment variables (${VAR:-} / ${VAR}) must not clobber
 * non-empty project-level environment variables during container deploy.
 */
describe("Issue #614 - Compose environment passthrough vs project env vars", () => {
  it("imports compose passthrough variable (${VAR:-}) as empty string in service environment", () => {
    const yaml = `
services:
  web:
    image: node:20
    environment:
      CONFIG_VAR: \${CONFIG_VAR:-}
      ANOTHER_VAR: \${ANOTHER_VAR}
      WITH_DEFAULT: \${WITH_DEFAULT:-default_fallback}
`;
    const parsed = parseComposeFile(yaml);
    const service = parsed.services[0];

    expect(service).toBeDefined();
    expect(service?.environment).toEqual({
      CONFIG_VAR: "",
      ANOTHER_VAR: "",
      WITH_DEFAULT: "default_fallback",
    });

    expect(service?.environmentMeta?.CONFIG_VAR).toMatchObject({
      source: "default",
      variable: "CONFIG_VAR",
      defaultValue: "",
    });
    expect(service?.environmentMeta?.ANOTHER_VAR).toMatchObject({
      source: "missing",
      variable: "ANOTHER_VAR",
    });
  });

  it("preserves non-empty project-level env vars when compose specifies empty passthrough placeholders", () => {
    const yaml = `
services:
  api:
    image: my-app:latest
    environment:
      DATABASE_URL: \${DATABASE_URL:-}
      API_SECRET: \${API_SECRET}
      PORT: "3000"
`;
    const parsed = parseComposeFile(yaml);
    const inlineEnv = parsed.services[0]?.environment ?? {};

    // Project-level environment variables configured by the operator:
    const projectEnv = {
      DATABASE_URL: "postgresql://user:pass@db:5432/production_db",
      API_SECRET: "super-secret-token-12345",
      PORT: "8080",
    };

    const layers: ServiceEnvLayers = {
      project: projectEnv,
      frozen: {},
      inline: inlineEnv,
      service: {},
    };

    const merged = mergeServiceDeployEnv(layers, false);

    // FIXED: Project-level environment variables are preserved
    expect(merged.DATABASE_URL).toBe("postgresql://user:pass@db:5432/production_db");
    expect(merged.API_SECRET).toBe("super-secret-token-12345");

    // Literal inline value (PORT: "3000") still overrides project (PORT: "8080")
    expect(merged.PORT).toBe("3000");
  });

  it("allows explicit service-scoped overrides to take precedence over project and inline", () => {
    const projectEnv = {
      DATABASE_URL: "postgresql://user:pass@db:5432/production_db",
      API_SECRET: "global-secret",
    };

    const inlineEnv = {
      DATABASE_URL: "",
      API_SECRET: "",
    };

    const serviceEnv = {
      DATABASE_URL: "postgresql://user:pass@db:5432/special_service_db",
    };

    const layers: ServiceEnvLayers = {
      project: projectEnv,
      frozen: {},
      inline: inlineEnv,
      service: serviceEnv,
    };

    const merged = mergeServiceDeployEnv(layers, false);

    // Service-scoped override wins for DATABASE_URL
    expect(merged.DATABASE_URL).toBe("postgresql://user:pass@db:5432/special_service_db");
    // Project-level value is preserved for API_SECRET
    expect(merged.API_SECRET).toBe("global-secret");
  });

  it("retains empty string when no project variable exists for the passthrough key", () => {
    const inlineEnv = {
      UNSET_PASSTHROUGH: "",
    };

    const layers: ServiceEnvLayers = {
      project: {},
      frozen: {},
      inline: inlineEnv,
      service: {},
    };

    const merged = mergeServiceDeployEnv(layers, false);
    expect(merged.UNSET_PASSTHROUGH).toBe("");
  });
});
