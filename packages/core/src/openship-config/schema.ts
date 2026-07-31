/**
 * `openship.json` — the native, declarative deploy config (à la vercel.json /
 * railway.toml). A repo-root file that tells Openship how to build, run, route,
 * and scale a project, covering the deploy wizard's options. It's an
 * AUTHORITATIVE OVERLAY: auto-detection runs first, then each field present here
 * overrides it (absent fields keep the detected value). It seeds the wizard and
 * is authoritative for headless deploys (auto-deploy on push, `openship deploy`).
 *
 * This is the typed shape. `parse.ts` validates/coerces raw JSON into it; the
 * published JSON Schema (for editor autocomplete) is generated from the same
 * field set. Every field maps 1:1 to an existing API option — see the docs
 * reference page for the mapping table.
 */

import type { StackId } from "../stacks";
import type { RoutingConfig } from "../metadata/types";

export type OpenshipRuntime = "bare" | "docker";
export type OpenshipProductionMode = "host" | "static" | "standalone";
export type OpenshipDomainType = "free" | "custom";
export type OpenshipRestart = "no" | "always" | "on-failure" | "unless-stopped";
/** Cloud sizing presets, plus "unlimited" — no caps, the self-hosted default
 *  (the machine itself is the ceiling). */
export type OpenshipResourceTier = "unlimited" | "micro" | "low" | "medium" | "high";

export const OPENSHIP_RUNTIMES: readonly OpenshipRuntime[] = ["bare", "docker"];
export const OPENSHIP_PRODUCTION_MODES: readonly OpenshipProductionMode[] = [
  "host",
  "static",
  "standalone",
];
export const OPENSHIP_DOMAIN_TYPES: readonly OpenshipDomainType[] = ["free", "custom"];
export const OPENSHIP_RESTARTS: readonly OpenshipRestart[] = [
  "no",
  "always",
  "on-failure",
  "unless-stopped",
];
export const OPENSHIP_RESOURCE_TIERS: readonly OpenshipResourceTier[] = [
  "unlimited",
  "micro",
  "low",
  "medium",
  "high",
];

/** Env value: a plain string, or `{ value, secret }` to encrypt it at rest. */
export type OpenshipEnvValue = { value: string; secret?: boolean };
export type OpenshipEnv = Record<string, string | OpenshipEnvValue>;

export interface OpenshipDomain {
  /** Hostname. A `.opsh.io`-style label = a free subdomain; anything with a dot = custom. */
  domain: string;
  /** Which service/exposed port this hostname routes to (defaults to the app port). */
  port?: number;
  /** Path prefix on the target (defaults to "/"). */
  targetPath?: string;
  type?: OpenshipDomainType;
}

export interface OpenshipHealthcheck {
  test?: string | string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  startPeriod?: string;
  disable?: boolean;
}

/**
 * Openship's own DEPLOY-TIME readiness gate — distinct from
 * `services[].healthcheck` above, which is the Docker-native `HEALTHCHECK`
 * directive baked into a compose service and run by the daemon.  This one runs
 * in the deploy pipeline, between "the container started" and "the deployment is
 * ready", and is the only one that can hold up (or veto) a deploy.
 *
 * EVERYTHING HERE IS OFF BY DEFAULT.  Omit the block — or omit the whole
 * `healthCheck` field — and a deploy does no post-start waiting whatsoever:
 * activate → route → ready.  That default is deliberate. The pipeline already
 * runs an *advisory* in-container port probe after the deploy is live
 * (`auditPorts`, surfaced as `meta.portCheck` and re-runnable on demand via
 * `POST /projects/:id/port-check`), so "is my app actually listening?" is
 * answered without a gate that can delay or fail a working deploy.
 *
 * Turn these on when you want the deploy itself to refuse to go green — e.g. a
 * release pipeline that must not advance on a broken build.
 */
export interface OpenshipHealthCheck {
  /**
   * Probe the app's port after start and wait for it to answer. `false`/absent
   * ⇒ no probe is issued at all (the default).
   */
  enabled?: boolean;
  /**
   * Require an HTTP GET to this path to answer below 500. Omit to accept a bare
   * TCP connection, which also passes for non-HTTP services.
   */
  path?: string;
  /** Port to probe. Defaults to the app's own port. */
  port?: number;
  /** How long to wait for the app to answer. Default 45. */
  timeoutSeconds?: number;
  /**
   * Watch the container for a restart loop before reporting ready. Independent
   * of `enabled` — this reads the runtime (so it also covers remote/SSH
   * targets) rather than dialing a port. `false`/absent ⇒ not watched.
   */
  stabilization?: boolean;
  /** How long to watch for a restart loop. Default 15. */
  stabilizationSeconds?: number;
  /**
   * What a failed check does.
   *   "warn" (default) — the deploy stays `ready` and carries an
   *                      action-required warning. Never destroys anything.
   *   "fail"           — the deploy fails and reverts to the previous
   *                      deployment, which keeps serving.
   */
  onFailure?: OpenshipHealthCheckFailureAction;
}

export type OpenshipHealthCheckFailureAction = "warn" | "fail";

export const OPENSHIP_HEALTH_CHECK_FAILURE_ACTIONS: readonly OpenshipHealthCheckFailureAction[] = [
  "warn",
  "fail",
];

export interface OpenshipService {
  name: string;
  image?: string;
  build?: string;
  dockerfile?: string;
  ports?: string[];
  volumes?: string[];
  dependsOn?: string[];
  env?: OpenshipEnv;
  command?: string;
  restart?: OpenshipRestart;
  exposed?: boolean;
  exposedPort?: string;
  domain?: string;
  healthcheck?: OpenshipHealthcheck;
  /** Per-service cpu/memory caps, overriding the top-level `resources` field by
   *  field. Parity with compose `mem_limit` / `deploy.resources.limits`, which
   *  the compose parser now honors. `0` = no limit. */
  resources?: OpenshipResources;
}

/**
 * Per-sub-app overrides for a monorepo. These override what the detector found
 * for the sub-app at `rootDirectory` (matched by path). Only build-shaping
 * fields are supported in v1 — per-app `domain`/`env`/`exposed` are set in the
 * wizard, not here (declare shared vars under the top-level `env`/`domains`).
 */
export interface OpenshipMonorepoApp {
  name: string;
  rootDirectory: string;
  framework?: StackId;
  packageManager?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  outputDirectory?: string;
  buildImage?: string;
  port?: number;
}

export interface OpenshipMonorepo {
  workspace?: { packageManager: string; prepareCommand?: string };
  apps?: OpenshipMonorepoApp[];
}

/** Cloud sizing tier OR an explicit production resource allocation. */
export interface OpenshipResources {
  tier?: OpenshipResourceTier;
  cpuCores?: number;
  memoryMb?: number;
  diskMb?: number;
}

export interface OpenshipConfig {
  // ── Build ──
  framework?: StackId;
  packageManager?: string;
  rootDirectory?: string;
  /**
   * Where the compose file lives, when it isn't at the project root — either the
   * file itself (`"deploy/stack.yml"`, which also covers non-standard filenames)
   * or the directory holding it (`"deploy/docker-compose"`). Declaring this makes
   * the project a compose/services deploy.
   */
  composePath?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  outputDirectory?: string;
  buildImage?: string;
  productionPaths?: string[];
  /**
   * Paths the app keeps across deploys. Either the short app form — a path
   * relative to the app root (`"storage"`, `"public/uploads"`) — or full compose
   * syntax (`"uploads:/app/storage"`, `"/srv/data:/app/storage"`). Omit to inherit
   * the framework's defaults (Laravel keeps `storage/`); declare `[]` to opt out.
   * Compose services keep declaring their own under `services[].volumes`.
   */
  volumes?: string[];
  // ── Runtime ──
  runtime?: OpenshipRuntime;
  productionMode?: OpenshipProductionMode;
  port?: number;
  // ── Env ──
  env?: OpenshipEnv;
  // ── Domains + routing ──
  domains?: OpenshipDomain[];
  routes?: RoutingConfig;
  // ── Resources ──
  resources?: OpenshipResources;
  // ── Deploy-time readiness gate (all off by default) ──
  healthCheck?: OpenshipHealthCheck;
  // ── Services (compose) ──
  services?: OpenshipService[];
  // ── Monorepo ──
  monorepo?: OpenshipMonorepo;
}

export interface ParseResult {
  /** Valid fields, partial — only what parsed cleanly. null if `raw` isn't an object. */
  config: OpenshipConfig | null;
  /** Hard validation failures (bad type / unknown enum / out-of-range). */
  errors: string[];
  /** Soft issues (unknown keys) — non-fatal; the field is ignored. */
  warnings: string[];
}
