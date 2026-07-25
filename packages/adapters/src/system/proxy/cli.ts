/**
 * Lean entrypoint for the host-side edge preflight in `openship up` (the CLI).
 *
 * The CLI bundles workspace packages inline (see apps/cli/tsup.config.ts
 * `noExternal: [/^@repo\//]`), so it must NOT import the `@repo/adapters` barrel —
 * that drags in ssh2 / dockerode / @aws-sdk / oblien (executors, docker runtime,
 * backups, cloud client). This subpath re-exports ONLY the shell-based proxy
 * detect / enumerate / free primitives + `LocalExecutor`, whose transitive graph
 * is free of those heavy deps.
 *
 * Registration of migrated sites into the CONTAINER edge is NOT done here — the
 * containerized api owns that (POST /api/system/edge/import-sites), because it
 * needs the running edge container + the shared routing volumes + the docker
 * socket. The CLI only detects, enumerates, and (on consent) stops the foreign
 * proxy on the host before `docker compose up`.
 */
export {
  probeEdge,
  detectEdge,
  foreignProxyOnEdge,
  importSites,
  freeEdgeTargets,
  stopTargetsForStatus,
} from "./index";
export { LocalExecutor } from "../local-executor";
export type {
  EdgeStatus,
  EdgeStopTarget,
  ImportedSite,
  ProxyScanResult,
} from "../types";
export type { CommandExecutor } from "../../types";
