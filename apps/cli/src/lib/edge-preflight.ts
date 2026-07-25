/**
 * Host-side edge preflight for `openship up` (Docker Compose self-deploy).
 *
 * The compose stack's OpenResty `edge` container binds host :80/:443 via
 * `network_mode: host` the instant `docker compose up` runs. If another proxy
 * (the user's nginx/caddy/…) already owns those ports, the edge can't bind — so
 * BEFORE bringing the stack up we run the SAME detect → "proxy X serving N
 * sites" → consent → stop chain the dashboard and the bare wizard use. This is
 * the piece `apps/api/src/lib/startup/self-edge.ts` explicitly delegates to
 * `openship up` in docker-edge mode.
 *
 * Detection runs directly against the host via a `LocalExecutor` (the api isn't
 * up yet, so we can't use its /self-edge/preflight endpoint). On "migrate" we
 * ALSO read the foreign cert PEMs here (the container edge can't read the host
 * filesystem) and hand them, with the parsed sites, to the api's
 * `POST /system/edge/import-sites` AFTER the stack is up (done by the caller).
 *
 * Everything is behind an injectable `deps` object so the flow is unit-testable
 * with fakes — no real docker/ss/fs.
 */
import { readFileSync } from "node:fs";
import chalk from "chalk";
import { isCancel, log, note, select } from "@clack/prompts";
import {
  LocalExecutor,
  foreignProxyOnEdge as realForeignProxyOnEdge,
  freeEdgeTargets as realFreeEdgeTargets,
  importSites as realImportSites,
  stopTargetsForStatus as realStopTargetsForStatus,
  type CommandExecutor,
  type EdgeStatus,
  type EdgeStopTarget,
  type ImportedSite,
} from "@repo/adapters/proxy";

export type EdgeAction = "migrate" | "takeover" | "cancel";

export interface EdgePlan {
  /** Proceed to `docker compose up`? False = the user cancelled (proxy left running). */
  proceed: boolean;
  /** What the user chose when a foreign proxy was found (absent when the edge was clean). */
  action?: EdgeAction;
  /** Sites parsed from the foreign proxy — passed to the api's import endpoint (migrate). */
  sites?: ImportedSite[];
  /** Foreign cert PEMs, keyed by source cert path, read host-side (migrate + TLS sites). */
  certPems?: Record<string, { certPem: string; keyPem: string }>;
}

export interface EdgePreflightDeps {
  platform: NodeJS.Platform;
  /** Whether we can prompt (TTY). Non-interactive falls back to the flag or cancel. */
  interactive: boolean;
  makeExecutor(): CommandExecutor;
  foreignProxyOnEdge(
    executor: CommandExecutor,
  ): Promise<{ status: EdgeStatus; blocked: boolean; owner: string }>;
  importSites(
    executor: CommandExecutor,
    status: EdgeStatus,
  ): Promise<{ sites: ImportedSite[]; warnings: string[] }>;
  freeEdgeTargets(
    executor: CommandExecutor,
    targets: EdgeStopTarget[],
    onLog: (message: string, level?: "info" | "warn" | "error") => void,
  ): Promise<void>;
  stopTargetsForStatus(status: EdgeStatus): EdgeStopTarget[];
  /** Read a cert/key PEM off the host filesystem; null if unreadable. */
  readCert(path: string): string | null;
  /** Show the detected conflict (sites + non-migratable warnings) to the operator. */
  render(info: { owner: string; sites: ImportedSite[]; warnings: string[] }): void;
  /** Ask which action to take (interactive path only). */
  confirm(info: { owner: string; known: boolean; importable: number }): Promise<EdgeAction>;
  warn(message: string): void;
}

/** A filesystem path safe to read without shell/path surprises (absolute, no metachars). */
function isSafePath(p: string): boolean {
  return /^\/[A-Za-z0-9._/-]+$/.test(p);
}

/**
 * Detect a foreign proxy on :80/:443 and, on consent, stop it so the compose
 * edge container can bind. Returns whether to proceed and (for migrate) the
 * sites + cert PEMs to re-register into the container edge after the stack is up.
 *
 * `edge` is the `--edge` flag value (pre-answers the prompt, e.g. for CI).
 */
export async function planAndApplyHostEdge(
  opts: { edge?: EdgeAction },
  overrides: Partial<EdgePreflightDeps> = {},
): Promise<EdgePlan> {
  const deps: EdgePreflightDeps = { ...defaultDeps(), ...overrides };

  // The host-net edge (and thus the :80/:443 contention) is a Linux concept;
  // Docker Desktop on mac/win has no host networking. Nothing to detect.
  if (deps.platform !== "linux") return { proceed: true };

  const executor = deps.makeExecutor();
  const { status, blocked, owner } = await deps.foreignProxyOnEdge(executor);
  if (!blocked) return { proceed: true }; // free, or already ours

  const { sites, warnings } = await deps.importSites(executor, status);

  const action = await resolveAction(opts.edge, { status, owner, sites, warnings }, deps);
  if (action === "cancel") return { proceed: false };

  // migrate captures the foreign certs (host FS) before we stop the proxy;
  // takeover just frees the ports and lets the imported sites drop.
  const certPems = action === "migrate" ? collectCertPems(sites, deps.readCert) : undefined;
  await deps.freeEdgeTargets(executor, deps.stopTargetsForStatus(status), (m, l) =>
    deps.warn(l === "info" ? m : chalk.yellow(m)),
  );
  return action === "migrate" ? { proceed: true, action, sites, certPems } : { proceed: true, action };
}

async function resolveAction(
  flag: EdgeAction | undefined,
  ctx: { status: EdgeStatus; owner: string; sites: ImportedSite[]; warnings: string[] },
  deps: EdgePreflightDeps,
): Promise<EdgeAction> {
  if (flag) return flag;
  if (!deps.interactive) {
    deps.warn(
      `An existing proxy (${ctx.owner}) holds :80/:443 and this is a non-interactive run. ` +
        `Re-run with --edge=migrate (import its sites), --edge=takeover (stop it, sites drop), ` +
        `or --edge=cancel. Leaving it running.`,
    );
    return "cancel";
  }
  deps.render({ owner: ctx.owner, sites: ctx.sites, warnings: ctx.warnings });
  return deps.confirm({
    owner: ctx.owner,
    known: ctx.status.classification === "known",
    importable: ctx.sites.length,
  });
}

function collectCertPems(
  sites: ImportedSite[],
  readCert: (path: string) => string | null,
): Record<string, { certPem: string; keyPem: string }> {
  const out: Record<string, { certPem: string; keyPem: string }> = {};
  for (const s of sites) {
    if (!s.ssl || !s.tls) continue;
    const { certPath, keyPath } = s.tls;
    if (!isSafePath(certPath) || !isSafePath(keyPath)) continue; // else api provisions fresh
    const certPem = readCert(certPath);
    const keyPem = readCert(keyPath);
    if (certPem && keyPem) out[certPath] = { certPem, keyPem };
  }
  return out;
}

function defaultDeps(): EdgePreflightDeps {
  return {
    platform: process.platform,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    makeExecutor: () => new LocalExecutor(),
    foreignProxyOnEdge: realForeignProxyOnEdge,
    importSites: realImportSites,
    freeEdgeTargets: realFreeEdgeTargets,
    stopTargetsForStatus: realStopTargetsForStatus,
    readCert: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    render: ({ owner, sites, warnings }) => {
      if (sites.length > 0) {
        const lines = sites.map((st) => {
          const host = (st.serverNames ?? []).join(", ") || "(no server_name)";
          const dest = st.target.kind === "static" ? `static: ${st.target.root}` : st.target.url;
          return `${chalk.bold(host)} → ${chalk.dim(dest)}${st.ssl ? chalk.green(" [TLS]") : ""}`;
        });
        note(lines.join("\n"), `Detected ${sites.length} site${sites.length === 1 ? "" : "s"} on ${owner}`);
      }
      if (warnings.length > 0) {
        log.warn(`${warnings.length} config item${warnings.length === 1 ? "" : "s"} won't migrate automatically:`);
        for (const w of warnings.slice(0, 8)) log.message(chalk.dim(`• ${w}`));
      }
    },
    confirm: async ({ owner, known, importable }) => {
      const choice = await select({
        message: known
          ? `An existing reverse proxy (${owner}) is serving ports 80/443.`
          : `Ports 80/443 are in use by ${owner}, which we couldn't identify.`,
        options: [
          ...(importable > 0
            ? [
                {
                  value: "migrate" as const,
                  label: `Migrate ${importable} site${importable === 1 ? "" : "s"} & take over`,
                  hint: "import the existing sites into Openship's edge, then take 80/443",
                },
              ]
            : []),
          {
            value: "takeover" as const,
            label: "Stop it & take over 80/443",
            hint: known ? "the existing sites stop being served" : "may interrupt a running service",
          },
          { value: "cancel" as const, label: "Cancel — leave it running" },
        ],
        // Unknown owner pre-selects takeover; a known proxy defaults to cancel so
        // the operator chooses deliberately (mirrors the wizard / dashboard modal).
        initialValue: known ? "cancel" : "takeover",
      });
      return isCancel(choice) ? "cancel" : (choice as EdgeAction);
    },
    warn: (message) => console.log(chalk.yellow(`  ${message}`)),
  };
}
