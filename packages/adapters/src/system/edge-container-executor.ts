import type { CommandExecutor, LogEntry } from "../types";
import { sq } from "./local-shell";
import { resolveOurEdgeContainer } from "./proxy/detect";

/** Wrap a command so it runs INSIDE the named edge container. */
export function containerCommand(container: string, command: string): string {
  return `docker exec ${sq(container)} sh -c ${sq(command)}`;
}

/**
 * Where an edge-container executor's FILE operations land.
 *
 *   "host" — the edge's state is bind-mounted from canonical host paths
 *            (EDGE_CONTAINER_MOUNTS), so file ops pass straight through to the
 *            inner executor. The default, and the right answer for any edge this
 *            codebase installs: `ensureContainerEdge` creates those mounts.
 *   "auto" — the state may NOT be visible on the host (a legacy install on
 *            Docker-managed named volumes), so prefer the host and reach into the
 *            container when the host can't answer. Same rule, same code, as the
 *            standalone {@link readEdgeFile} / {@link writeEdgeFile}.
 */
export type EdgeFilesAt = "host" | "auto";

/**
 * The edge container, either already known or resolvable on demand. A thunk lets
 * the read path skip the `docker ps` entirely when the host answers — which is
 * every non-legacy box.
 */
type EdgeContainerRef = string | null | (() => Promise<string | null>);

function resolveRef(ref: EdgeContainerRef): Promise<string | null> | string | null {
  return typeof ref === "function" ? ref() : ref;
}

/**
 * Read a path the edge owns (a cert, a vhost) from wherever its state actually
 * lives, on the box `inner` reaches. `container` names the edge container — already
 * known, null when there is none, or a thunk that resolves one on demand.
 *
 * Canonical location is the HOST — certs live at `/etc/letsencrypt` and vhosts at a
 * bind-mounted dir, so a plain read is right for a bare edge and for a containerized
 * one on current mounts. A LEGACY install keeps that state in a Docker-managed named
 * volume the host can't see, where a host read returns nothing and is
 * indistinguishable from "no cert" — so fall back to reading inside the container.
 * Never throws: "" means nothing to reuse, which is what every caller already treats
 * as absence.
 *
 * This is the ONE implementation of that decision. It has two doors — the standalone
 * `readEdgeFile` for callers holding a plain executor, and `files: "auto"` on
 * `edgeContainerExecutor` for callers holding a provider — and they must never be
 * able to answer differently for the same box.
 */
async function readEdgeFileIn(
  inner: CommandExecutor,
  container: EdgeContainerRef,
  path: string,
): Promise<string> {
  const direct = await inner.readFile(path).catch(() => "");
  if (direct.trim()) return direct;
  // Resolved only NOW, on the miss: the overwhelmingly common case is a host hit,
  // and it must not pay for a `docker ps` to answer a question it never asks.
  const name = await resolveRef(container);
  if (!name) return "";
  return inner.exec(containerCommand(name, `cat ${sq(path)}`)).catch(() => "");
}

/**
 * Write a file the edge must be able to read, wherever its state actually lives.
 * Counterpart to {@link readEdgeFileIn} — see there for why this exists once.
 *
 * Writes to the canonical host path first, then asks the container whether it can
 * see it. A bind mount answers yes and we're done; a named volume answers no, and
 * the file gets copied in — otherwise the write lands on a path the edge never looks
 * at and silently does nothing (how carried migration certs went missing).
 * Best-effort on the container leg: the host write is the contract.
 */
async function writeEdgeFileIn(
  inner: CommandExecutor,
  container: string | null,
  path: string,
  content: string,
): Promise<void> {
  await inner.writeFile(path, content);
  if (!container) return;
  const visible = await inner
    .exec(containerCommand(container, `test -e ${sq(path)} && echo visible`))
    .catch(() => "");
  if (visible.trim() === "visible") return;
  const dir = path.replace(/\/[^/]*$/, "");
  if (dir && dir !== path) {
    await inner.exec(containerCommand(container, `mkdir -p ${sq(dir)}`)).catch(() => {});
  }
  await inner.exec(`docker cp ${sq(path)} ${sq(`${container}:${path}`)}`).catch(() => {});
}

/** {@link readEdgeFileIn} for a caller that has an executor but no container name. */
export function readEdgeFile(exec: CommandExecutor, path: string): Promise<string> {
  return readEdgeFileIn(exec, () => resolveOurEdgeContainer(exec).catch(() => null), path);
}

/**
 * {@link writeEdgeFileIn} for a caller that has an executor but no container name.
 * Unlike the read path this always resolves, because deciding whether to copy in
 * requires asking the container what it can see.
 */
export async function writeEdgeFile(
  exec: CommandExecutor,
  path: string,
  content: string,
): Promise<void> {
  const container = await resolveOurEdgeContainer(exec).catch(() => null);
  return writeEdgeFileIn(exec, container, path, content);
}

/**
 * Decorate a CommandExecutor so it drives a CONTAINERIZED OpenResty edge on the
 * box that executor reaches — the shell counterpart of `DockerEdgeExecutor`,
 * which needs a dockerode client and therefore only works where the daemon socket
 * is directly reachable. This one goes through `docker exec` over whatever channel
 * the inner executor already has (typically the pooled SSH executor for a remote
 * server), so no tunnel and no second Docker client are involved.
 *
 * Commands (`openresty -t`, `-s reload`, `certbot`) ALWAYS run inside the
 * container. Where FILES go is the caller's choice — see {@link EdgeFilesAt}; the
 * default `"host"` is correct for every edge `ensureContainerEdge` creates, because
 * it creates the bind mounts.
 *
 * Privilege is the caller's problem, exactly as with `probeEdge`'s own
 * `docker ps`: pass an already-elevated inner executor if the SSH user needs
 * sudo to reach the daemon.
 *
 * A Proxy forwards every other (optional) executor method — rawExec, forwardPort,
 * openShell, onDisconnect, dispose — transparently to the inner executor.
 */
export function edgeContainerExecutor(
  inner: CommandExecutor,
  container: string,
  opts?: { files?: EdgeFilesAt },
): CommandExecutor {
  const inContainer = (command: string) => containerCommand(container, command);

  const overrides: Partial<CommandExecutor> = {
    exec: (command: string, execOpts?: { timeout?: number }) =>
      inner.exec(inContainer(command), execOpts),
    streamExec: (command: string, onLog: (log: LogEntry) => void) =>
      inner.streamExec(inContainer(command), onLog),
  };

  if (opts?.files === "auto") {
    // Deliberately the SAME functions the standalone readEdgeFile/writeEdgeFile
    // use — the container is already resolved here, so it's the identical decision
    // with one probe saved.
    Object.assign(overrides, {
      readFile: (path: string) => readEdgeFileIn(inner, container, path),
      writeFile: (path: string, content: string) =>
        writeEdgeFileIn(inner, container, path, content),
      exists: async (path: string) => {
        if (await inner.exists(path).catch(() => false)) return true;
        // `test` reports absence via exit code — an answer, not a failure.
        const { code } = await inner.streamExec(inContainer(`test -e ${sq(path)}`), () => {});
        return code === 0;
      },
      // mkdir/rm are idempotent and rare (route register/deregister), so both homes
      // get them unconditionally rather than paying a probe to decide.
      mkdir: async (path: string) => {
        await inner.mkdir(path);
        await inner.exec(inContainer(`mkdir -p ${sq(path)}`)).catch(() => {});
      },
      rm: async (path: string) => {
        await inner.rm(path);
        await inner.exec(inContainer(`rm -rf ${sq(path)}`)).catch(() => {});
      },
    } satisfies Partial<CommandExecutor>);
  }

  return new Proxy(inner, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return (overrides as Record<string | symbol, unknown>)[prop];
      }
      // Bind to the REAL inner (not the proxy) so delegated methods never
      // re-enter the container layer.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
