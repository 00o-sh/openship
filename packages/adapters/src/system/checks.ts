/**
 * Component health checks - detect installed binaries and running services.
 *
 * All checks run through a CommandExecutor, so they work both locally
 * and on remote servers via SSH. Checks are fast, non-destructive, and
 * safe to run repeatedly.
 *
 * In normal operation, checks run ONCE during setup - the result is
 * cached in SetupStateStore. Subsequent operations read cached state
 * instead of re-running checks (see setup.ts).
 */

import type { CommandExecutor } from "../types";
import type { ComponentStatus } from "./types";
import { OPENRESTY_LUA_DIR } from "../infra/openresty-lua";
import { containerCommand } from "./edge-container-executor";
import { resolveOurEdgeContainer } from "./proxy/detect";
import { systemCatalog } from "./catalog";
import { resolveEnvironment } from "./environment";
import { enrichAvailableVersions } from "./available-version";
import {
  canonicalComponentName,
  getSystemComponentDefinition,
  SYSTEM_COMPONENTS,
} from "./components";
import { formatDuration, systemDebug } from "./debug";
import { isRemoteConnectionError } from "./errors";
import { safeErrorMessage } from "@repo/core";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Run a command via executor, return stdout or null on failure. */
async function tryExec(
  executor: CommandExecutor,
  command: string,
): Promise<string | null> {
  const startedAt = Date.now();
  systemDebug("checks", `exec:start ${command}`);
  try {
    const result = await executor.exec(command, { timeout: 10_000 });
    systemDebug(
      "checks",
      `exec:ok ${command} (${formatDuration(startedAt)})`,
    );
    return result;
  } catch (err) {
    if (isRemoteConnectionError(err)) {
      systemDebug(
        "checks",
        `exec:abort ${command} (${formatDuration(startedAt)}) ${safeErrorMessage(err)}`,
      );
      throw err;
    }
    const msg = safeErrorMessage(err);
    systemDebug(
      "checks",
      `exec:fail ${command} (${formatDuration(startedAt)}) ${msg}`,
    );
    return null;
  }
}

function healthy(
  name: string,
  version: string,
  running?: boolean,
): ComponentStatus {
  const component = getSystemComponentDefinition(name);
  return {
    name,
    label: component.label,
    description: component.description,
    installable: component.installable,
    installed: true,
    version,
    running,
    healthy: running !== undefined ? running : true,
    message: running
      ? `${name} ${version} - running`
      : `${name} ${version} - installed`,
  };
}

function unhealthy(
  name: string,
  message: string,
  opts?: { version?: string; running?: boolean },
): ComponentStatus {
  const component = getSystemComponentDefinition(name);
  return {
    name,
    label: component.label,
    description: component.description,
    installable: component.installable,
    installed: !!opts?.version,
    version: opts?.version,
    running: opts?.running,
    healthy: false,
    message,
  };
}

// ─── Individual checks ──────────────────────────────────────────────────────

export async function checkDocker(
  executor: CommandExecutor,
): Promise<ComponentStatus> {
  const startedAt = Date.now();
  const recipe = systemCatalog.checks.docker;
  const version = await tryExec(executor, recipe.versionCommand);
  if (!version) {
    systemDebug("checks", `docker:missing (${formatDuration(startedAt)})`);
    return unhealthy("docker", recipe.missingMessage);
  }

  const parsed = recipe.parseVersion(version);

  const info = await tryExec(executor, recipe.daemonCommand!);
  if (!info) {
    systemDebug("checks", `docker:not-running (${formatDuration(startedAt)})`);
    return unhealthy("docker", recipe.notRunningMessage!, {
      version: parsed,
      running: false,
    });
  }

  systemDebug("checks", `docker:healthy (${formatDuration(startedAt)})`);
  return healthy("docker", parsed, true);
}

export async function checkGit(
  executor: CommandExecutor,
): Promise<ComponentStatus> {
  const startedAt = Date.now();
  const recipe = systemCatalog.checks.git;
  const version = await tryExec(executor, recipe.versionCommand);
  if (!version) {
    systemDebug("checks", `git:missing (${formatDuration(startedAt)})`);
    return unhealthy("git", recipe.missingMessage);
  }
  const parsed = recipe.parseVersion(version);
  systemDebug("checks", `git:healthy (${formatDuration(startedAt)})`);
  return healthy("git", parsed);
}

export async function checkRsync(
  executor: CommandExecutor,
): Promise<ComponentStatus> {
  const startedAt = Date.now();
  const recipe = systemCatalog.checks.rsync;
  const version = await tryExec(executor, recipe.versionCommand);
  if (!version) {
    systemDebug("checks", `rsync:missing (${formatDuration(startedAt)})`);
    return unhealthy("rsync", recipe.missingMessage);
  }
  const parsed = recipe.parseVersion(version);
  systemDebug("checks", `rsync:healthy (${formatDuration(startedAt)})`);
  return healthy("rsync", parsed);
}

/**
 * The edge: ONE check for the openship-edge container.
 *
 * The edge is a Docker image, and its whole serving path is host-side (host
 * networking, host bind mounts for vhosts/certs/ACME). So the question is "is our
 * edge container up", not "is there an openresty binary on this box" — a converted
 * server has no binary, no unit and no Lua on the host, and every host probe would
 * call a perfectly healthy edge missing.
 *
 * A pre-conversion HOST edge is still reported healthy rather than missing: it is
 * genuinely serving, and the deploy path migrates it to the container (pull-first,
 * with rollback). Calling it "missing" here would offer to install a second edge
 * next to a working one.
 */
export async function checkEdge(executor: CommandExecutor): Promise<ComponentStatus> {
  const startedAt = Date.now();
  const recipe = systemCatalog.checks.openresty;

  const container = await resolveOurEdgeContainer(executor);
  if (container) {
    const containerVersion = await tryExec(
      executor,
      containerCommand(container, "openresty -v 2>&1"),
    );
    if (containerVersion) {
      systemDebug("checks", `edge:healthy-container (${formatDuration(startedAt)})`);
      return healthy("edge", recipe.parseVersion(containerVersion), true);
    }
    systemDebug("checks", `edge:container-unresponsive (${formatDuration(startedAt)})`);
    return unhealthy(
      "edge",
      `The edge container ${container} is running but not responding — check \`docker logs ${container}\``,
      { running: false },
    );
  }

  const version = await tryExec(executor, recipe.versionCommand);

  // No container and no binary → there is no edge. The install is a container
  // pull, so the message points at Docker rather than at an apt package.
  if (!version) {
    systemDebug("checks", `edge:missing (${formatDuration(startedAt)})`);
    return unhealthy(
      "edge",
      "No edge on this server. The edge is the openship-edge container — install it (requires Docker).",
    );
  }

  // ── Legacy HOST edge (pre-conversion) ──────────────────────────────────────
  // Still the real serving path on this box, so it reports healthy; the deploy
  // path migrates it to the container. New installs never land here.
  const parsed = recipe.parseVersion(version);

  const runningChecks = await Promise.all(
    recipe.runningCommands!.map((command) => tryExec(executor, command)),
  );
  const running = runningChecks.some(Boolean);

  if (!running) {
    systemDebug("checks", `edge:host-not-running (${formatDuration(startedAt)})`);
    return unhealthy("edge", recipe.notRunningMessage!, {
      version: parsed,
      running: false,
    });
  }

  // Binary + process OK - verify Lua analytics/streaming scripts are deployed
  const hasLua = await tryExec(
    executor,
    `test -f ${OPENRESTY_LUA_DIR}/site_logger.lua && test -f ${OPENRESTY_LUA_DIR}/pipe_stream.lua && echo ok`,
  );
  if (!hasLua) {
    systemDebug("checks", `edge:host-missing-lua (${formatDuration(startedAt)})`);
    return unhealthy(
      "edge",
      "The host edge is running but its analytics scripts are not deployed — reinstall to move it into the edge container",
      { version: parsed, running: true },
    );
  }

  systemDebug("checks", `edge:healthy-host (${formatDuration(startedAt)})`);
  return healthy("edge", parsed, true);
}

// ─── Registry ────────────────────────────────────────────────────────────────

type CheckFn = (executor: CommandExecutor) => Promise<ComponentStatus>;

export const COMPONENT_CHECKS: Record<string, CheckFn> = {
  docker: checkDocker,
  edge: checkEdge,
  git: checkGit,
  rsync: checkRsync,
};

/**
 * Map items through `fn` with a bounded concurrency pool, preserving order.
 *
 * Component checks are independent, so we run several at once instead of
 * serially — a big win on the system-ssh path where every `exec` is a separate
 * `ssh` round-trip (serial checks otherwise stack past the client timeout). The
 * cap keeps us well under sshd's per-connection MaxSessions (default 10), which
 * both ssh2 channels and ControlMaster sessions draw from, leaving headroom for
 * the live-metrics stream sharing the same connection.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/** Max component checks to run concurrently (see mapWithConcurrency). */
const CHECK_CONCURRENCY = 4;

/** Run every registered check with bounded concurrency. */
export async function checkAll(
  executor: CommandExecutor,
): Promise<ComponentStatus[]> {
  const startedAt = Date.now();
  const entries = SYSTEM_COMPONENTS
    .map((component) => [component.name, COMPONENT_CHECKS[component.name]] as const)
    .filter((entry): entry is readonly [string, CheckFn] => Boolean(entry[1]));
  systemDebug(
    "checks",
    `checkAll:start [${entries.map(([name]) => name).join(", ")}]`,
  );
  const results = await mapWithConcurrency(entries, CHECK_CONCURRENCY, ([, fn]) =>
    fn(executor),
  );
  await enrichAvailable(executor, results);
  systemDebug("checks", `checkAll:done (${formatDuration(startedAt)})`);
  return results;
}

/** Best-effort "newer version available?" enrichment; never throws. */
async function enrichAvailable(
  executor: CommandExecutor,
  results: ComponentStatus[],
): Promise<void> {
  try {
    const profile = await resolveEnvironment(executor);
    await enrichAvailableVersions(executor, profile, results);
  } catch {
    /* leave components without an available version */
  }
}

/** Run checks for a specific set of components with bounded concurrency. */
export async function checkComponents(
  executor: CommandExecutor,
  names: string[],
): Promise<ComponentStatus[]> {
  const startedAt = Date.now();
  // Canonicalize first (a caller may still ask for "openresty"/"certbot"), then
  // dedupe — both legacy names map to the edge, and running its check twice would
  // double the `docker ps` work for one answer.
  const canonical = [...new Set(names.map(canonicalComponentName))];
  const fns = canonical
    .map((name) => COMPONENT_CHECKS[name])
    .filter((fn): fn is CheckFn => Boolean(fn));
  systemDebug("checks", `checkComponents:start [${canonical.join(", ")}]`);
  const results = await mapWithConcurrency(fns, CHECK_CONCURRENCY, (fn) =>
    fn(executor),
  );
  await enrichAvailable(executor, results);
  systemDebug(
    "checks",
    `checkComponents:done [${names.join(", ")}] (${formatDuration(startedAt)})`,
  );
  return results;
}
