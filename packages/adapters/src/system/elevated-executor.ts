import { randomBytes } from "node:crypto";

import type { CommandExecutor, LogEntry } from "../types";
import { sq } from "./local-shell";

// apt/dpkg non-interactive env, re-set INSIDE the sudo'd root shell. sudo
// resets the environment and many sudoers configs reject -E / --preserve-env,
// so exporting it here (rather than relying on the outer executor ENV_PREFIX,
// which runs before sudo) is what keeps apt from prompting under root.
const INSTALL_ENV = "DEBIAN_FRONTEND=noninteractive DPKG_FORCE=confnew";

/** Wrap an arbitrary (possibly compound) command so it runs as root via
 *  passwordless sudo. `-n` fails fast instead of blocking on a password. */
export function elevateCommand(command: string): string {
  return `sudo -n sh -c ${sq(`export ${INSTALL_ENV}; ${command}`)}`;
}

/**
 * The executor a decorated one delegates to.
 *
 * `elevatedExecutor` returns a Proxy, which is a distinct object identity and therefore
 * a distinct key in the per-executor host-profile cache (`environment.ts`). Without a
 * way back to the delegate, an elevated view of a box re-probes it from scratch and can
 * disagree with the unelevated view about `canSudo` — the same host, two answers. This
 * lets the cache key on the box rather than on the view of it.
 */
export const EXECUTOR_DELEGATE = Symbol.for("openship.executor.delegate");

/** Parent directory of an absolute path (for `mkdir -p` before a move). */
function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return ".";
  return idx === 0 ? "/" : path.slice(0, idx);
}

/**
 * Decorate a CommandExecutor so every privileged operation runs through
 * `sudo -n`. Construct this ONLY for a target that is non-root WITH passwordless
 * sudo (environment.ts `canSudo`) — it elevates unconditionally.
 *
 * Overrides the mutating methods (exec, streamExec, writeFile, rename, mkdir, rm) plus
 * the two reads that can be REFUSED rather than merely fail (readFile, exists).
 * Transfers pass straight through — the install path never transfers into a privileged
 * path. A Proxy forwards every other (optional) executor method (rawExec, forwardPort,
 * openShell, onDisconnect, …) transparently.
 *
 * The reads used to pass through too, on the reasoning that "files under /etc are
 * world-readable". That is true of almost everything and false of the one that matters:
 * certbot chmods `/etc/letsencrypt/{live,archive}` to 0700 root. A non-root read of a
 * cert therefore failed, every caller treats a failed read as ABSENCE, and so a box with
 * a perfectly good certificate reported having none — which re-issued it on every
 * deploy and walked into Let's Encrypt's 5-per-week duplicate limit, at which point
 * TLS stopped working for a reason nothing in the logs connected to permissions.
 */
export function elevatedExecutor(inner: CommandExecutor): CommandExecutor {
  /**
   * Elevate only on a MISS, which is what makes this safe to add under existing
   * callers: any read that already worked keeps its exact path, encoding and error, and
   * only a genuine refusal pays a second round-trip. Same shape as
   * `readMaybeInContainer`, for the same reason — a read has a cheap answer and an
   * expensive one, and the expensive one is worth it only when the cheap one came up
   * empty.
   *
   * The ORIGINAL error is rethrown if the elevated read fails too: "no such file" is
   * the useful message on a path that is simply absent, and sudo's would replace it.
   */
  const readFileElevated = async (path: string): Promise<string> => {
    try {
      return await inner.readFile(path);
    } catch (err) {
      try {
        return await inner.exec(elevateCommand(`cat ${sq(path)}`));
      } catch {
        throw err;
      }
    }
  };

  const existsElevated = async (path: string): Promise<boolean> => {
    if (await inner.exists(path).catch(() => false)) return true;
    // `test -e` answers absence with exit 1, which `exec` surfaces as a throw — so a
    // false here means "root can't see it either", not "the probe broke".
    return await inner
      .exec(elevateCommand(`test -e ${sq(path)}`))
      .then(() => true)
      .catch(() => false);
  };
  /**
   * Stage where only the login user can look, then publish as root.
   *
   * The content cannot go on the command line — some of it is a multi-kilobyte Lua bundle —
   * so it has to be written unelevated first. What matters is where it RESTS in between:
   * the staged file is created with the login user's umask (0644 on every host we've seen),
   * so staging it directly in a 1777 /tmp published a TLS private key, the ACME EAB HMAC
   * key and mail-state.json's plaintext credentials to every local account for the length
   * of a round trip — and left them there for good when the sudo step failed.
   *
   * `mkdir -m 700` with no `-p`, and both halves carry weight: the mode is applied at
   * creation so there is no readable window, and refusing a path that already exists makes
   * a planted directory an error rather than somewhere we write a secret. The name is
   * `randomBytes` because the old `Date.now()`+`Math.random()` was guessable enough to
   * pre-create and neither source is a CSPRNG.
   *
   * `chown 0:0` before the move because `mv` PRESERVES ownership, both by rename and by
   * cross-device copy: the published file was landing under /etc owned by the login user,
   * so on exactly the hosts this decorator exists for, a non-root account could rewrite
   * root's nginx.conf after we wrote it. The mode is deliberately left alone — callers
   * needing tighter than the default chmod the staged path themselves (`nginx.ts`
   * `_writeFile`), and forcing one here would silently loosen theirs.
   */
  const writeFileElevated = async (path: string, content: string): Promise<void> => {
    const stage = `/tmp/.openship-elev-${randomBytes(12).toString("hex")}`;
    await inner.exec(`mkdir -m 700 ${sq(stage)}`);
    try {
      const staged = `${stage}/payload`;
      await inner.writeFile(staged, content);
      await inner.exec(
        elevateCommand(
          `mkdir -p ${sq(dirOf(path))} && chown 0:0 ${sq(staged)} && mv -f ${sq(staged)} ${sq(path)}`,
        ),
      );
    } finally {
      // Unelevated on purpose: the directory belongs to the login user, so this still
      // works when the failure being cleaned up after is sudo itself refusing — which is
      // the one case that used to leave plaintext in /tmp indefinitely.
      await inner.exec(`rm -rf ${sq(stage)}`).catch(() => undefined);
    }
  };

  const overrides: Partial<CommandExecutor> = {
    exec: (command: string, opts?: { timeout?: number }) =>
      inner.exec(elevateCommand(command), opts),
    streamExec: (command: string, onLog: (log: LogEntry) => void, opts?: { signal?: AbortSignal }) =>
      inner.streamExec(elevateCommand(command), onLog, opts),
    writeFile: writeFileElevated,
    readFile: readFileElevated,
    exists: existsElevated,
    // Elevated for the same reason as writeFile: the vhost/conf dirs are root-owned,
    // and the Proxy would otherwise forward this to the inner executor unelevated —
    // EACCES immediately after an elevated write succeeded.
    rename: async (from: string, to: string) => {
      await inner.exec(elevateCommand(`mv -f ${sq(from)} ${sq(to)}`));
    },
    mkdir: async (path: string) => {
      await inner.exec(elevateCommand(`mkdir -p ${sq(path)}`));
    },
    rm: async (path: string) => {
      await inner.exec(elevateCommand(`rm -rf ${sq(path)}`));
    },
  };

  return new Proxy(inner, {
    get(target, prop) {
      if (prop === EXECUTOR_DELEGATE) return target;
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return (overrides as Record<string | symbol, unknown>)[prop];
      }
      // Bind to the REAL inner (not the proxy) so delegated methods never
      // re-enter the elevation layer.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
