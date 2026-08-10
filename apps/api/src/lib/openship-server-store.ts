/**
 * The single owner of the `/root/.openship/` folder on a target server.
 *
 * Everything Openship persists ON a server (mail state, the project manifest)
 * lives in this one root-only directory so it's the server's self-describing
 * source of truth — survive-the-orchestrator state for disaster recovery.
 *
 * This module owns ONLY the storage mechanics: ensuring the folder exists and
 * atomic file read/write/remove over an SSH `CommandExecutor`. Domain modules
 * (`mail-state.ts`, `openship-manifest.ts`) layer their schemas on top and must
 * NOT re-implement the folder/mkdir/atomic-write logic — call these helpers.
 */

import {
  HOST_STATE_DIR,
  privilegedExecutor,
  type CommandExecutor,
} from "@repo/adapters";

/**
 * The one folder — now spelled once, in the resolver's ops layer.
 *
 * Kept as a named re-export because every consumer here composes paths *under* it
 * (`MANIFEST_PATH`, `STATE_FILE_PATH`) at module scope, where there is no target host
 * to ask. The constant is right for that: these files are root-owned by contract on
 * every managed Linux host, which is exactly the case `stateDir()` returns unchanged.
 */
export const OPENSHIP_DIR = HOST_STATE_DIR;

/**
 * Single-quote wrap for safe interpolation into a remote LOGIN SHELL. The file
 * `name` reaches these helpers from semi-trusted sources — e.g. a `snapshot-<id>`
 * name where `<id>` is a container label read during a migration scan — so every
 * interpolated path MUST be quoted or a crafted name (`x$(cmd)`, `x;cmd`) is root
 * RCE on the target. `writeFile` uses SFTP (no shell) and needs no quoting.
 */
function sq(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/**
 * The executor these helpers actually run through.
 *
 * The directory is 0700 root-owned by design, so on a host we log in to as a non-root
 * user EVERY operation here needs elevation — not just the writes. It used to need none
 * because the login was assumed to be root: `mkdir -p /root/.openship` is the first
 * thing such a server hits, and a `cat` of a file it could never have written returns
 * "" — indistinguishable from "this server has no Openship state", which is what `scan`
 * reads to re-import our own projects.
 *
 * The PATH does not move for a non-root login, unlike the remote journal's: elevation is
 * available here (`elevatedExecutor`'s `writeFile` stages through `/tmp` then sudo-mv's,
 * so the atomic write survives it), and this state is read back later — sometimes by a
 * different login user — so a host provisioned before this fix must still be found.
 */
async function storeExecutor(exec: CommandExecutor, purpose: string): Promise<CommandExecutor> {
  const grant = await privilegedExecutor(exec, purpose, { onRefusedHost: "proceed" });
  if (!grant.supported) throw new Error(grant.reason);
  return grant.value.executor;
}

/** The dir, created through an executor a caller has already gated. */
async function mkdirOpenship(e: CommandExecutor): Promise<void> {
  await e.exec(`mkdir -p ${sq(OPENSHIP_DIR)} && chmod 0700 ${sq(OPENSHIP_DIR)}`);
}

/**
 * Ensure the `.openship` dir exists, root-only (0700). Idempotent. THE single
 * place the folder is created — callers never `mkdir` it themselves.
 */
export async function ensureOpenshipDir(exec: CommandExecutor): Promise<void> {
  await mkdirOpenship(await storeExecutor(exec, "Writing Openship server state"));
}

/**
 * Read a file from `.openship` by bare name (e.g. "mail-state.json"). Returns
 * "" when absent — never throws on a missing file.
 */
export async function readOpenshipFile(exec: CommandExecutor, name: string): Promise<string> {
  const path = `${OPENSHIP_DIR}/${name}`;
  try {
    const e = await storeExecutor(exec, "Reading Openship server state");
    return (await e.exec(`cat ${sq(path)} 2>/dev/null || echo ""`)).trim();
  } catch {
    return "";
  }
}

/**
 * Atomically write a file into `.openship` (temp file → `mv -f`), root-only
 * (0600). Ensures the dir first. A kill mid-write never leaves a partial file.
 */
export async function writeOpenshipFile(
  exec: CommandExecutor,
  name: string,
  content: string,
): Promise<void> {
  const path = `${OPENSHIP_DIR}/${name}`;
  const tmp = `${path}.tmp`;
  // One grant for all three steps: the staged write must land under the dir this same
  // grant just created, and re-gating per step would re-probe for nothing.
  const e = await storeExecutor(exec, "Writing Openship server state");
  await mkdirOpenship(e);
  await e.writeFile(tmp, content);
  await e.exec(`mv -f ${sq(tmp)} ${sq(path)} && chmod 0600 ${sq(path)}`);
}

/** Remove a file (and any stale temp) from `.openship`. Idempotent. */
export async function removeOpenshipFile(exec: CommandExecutor, name: string): Promise<void> {
  const path = `${OPENSHIP_DIR}/${name}`;
  const e = await storeExecutor(exec, "Removing Openship server state");
  await e.exec(`rm -f ${sq(path)} ${sq(`${path}.tmp`)}`);
}

/** Cheap existence check (no read) — `true` iff `.openship/<name>` is a file. */
export async function openshipFileExists(exec: CommandExecutor, name: string): Promise<boolean> {
  const path = `${OPENSHIP_DIR}/${name}`;
  try {
    const e = await storeExecutor(exec, "Reading Openship server state");
    return (await e.exec(`test -f ${sq(path)} && echo yes || echo no`)).trim() === "yes";
  } catch {
    return false;
  }
}
