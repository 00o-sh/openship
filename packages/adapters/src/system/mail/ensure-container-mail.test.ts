import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildMailRunCommand,
  ensureContainerMail,
  resolveMailImage,
  setDefaultMailImage,
} from "./ensure-container-mail";

afterEach(() => setDefaultMailImage(undefined));

/**
 * The one container-state probe every path here goes through (`containerState`):
 * run state AND created-from image in a single `docker inspect`, tab-separated.
 * Stubs match on the template so a change to the probe shape fails loudly instead
 * of silently reading as "no container" (which is how these stubs first drifted).
 */
const STATE_PROBE = "{{.State.Running}}";
const stateLine = (image: string, running = true) => `${running}\t${image}\n`;

describe("buildMailRunCommand", () => {
  it("runs host-networked with NET_ADMIN, restart, env-file, and the load-bearing mounts", () => {
    const cmd = buildMailRunCommand("openship-mail", "ghcr.io/x/openship-mail:1");
    expect(cmd).toContain("--network host");
    expect(cmd).toContain("--cap-add NET_ADMIN");
    expect(cmd).toContain("--restart unless-stopped");
    expect(cmd).toContain("--env-file");
    // The Postfix queue must be a bind mount or a recreate drops in-flight mail.
    expect(cmd).toContain("/var/spool/postfix");
    // The cert store is shared with the edge and mounted read-only.
    expect(cmd).toContain("/etc/letsencrypt:ro,z");
    // Image is the final, shell-quoted token.
    expect(cmd.endsWith("'ghcr.io/x/openship-mail:1'")).toBe(true);
  });
});

describe("resolveMailImage", () => {
  it("prefers an explicit ref, else the injected default", () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    expect(resolveMailImage("explicit:1")).toBe("explicit:1");
    expect(resolveMailImage()).toBe("ghcr.io/x/openship-mail:pinned");
  });
});

describe("ensureContainerMail idempotency", () => {
  it("returns updated:false without pulling when already on the pinned image", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const streamExec = vi.fn(async () => ({ code: 0, output: "" }));
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes(STATE_PROBE)) return stateLine("ghcr.io/x/openship-mail:pinned");
      return "";
    });
    const executor = { exec, streamExec } as never;

    const res = await ensureContainerMail(executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
    });

    expect(res.updated).toBe(false);
    expect(res.image).toBe("ghcr.io/x/openship-mail:pinned");
    // No pull and no docker run — the running container already matches.
    expect(streamExec).not.toHaveBeenCalled();
  });
});

// A /proc/net/tcp dump with LISTEN (state 0A) sockets for the DB (5432 = 0x1538),
// SMTP (25 = 0x19) and IMAPS (993 = 0x3E1) ports, so waitForPortListening resolves
// on the first poll and the bring-up doesn't spin until its (long) deadline.
const PROC_LISTENING = [
  "  sl  local_address rem_address   st ...",
  "  0: 00000000:1538 00000000:0000 0A 00000000:00000000",
  "  1: 00000000:0019 00000000:0000 0A 00000000:00000000",
  "  2: 00000000:03E1 00000000:0000 0A 00000000:00000000",
].join("\n");

/**
 * A first-boot executor: no container running, docker available, ports reported
 * listening, and every image-presence probe reports whatever `imagePresent` says.
 * `streamExec` and the writes succeed so the bring-up runs end to end.
 */
function firstBootExecutor(opts: { imagePresent: boolean; dockerfilePresent?: boolean }) {
  const streamExec = vi.fn(async (_cmd: string) => ({ code: 0, output: "" }));
  const exec = vi.fn(async (cmd: string) => {
    // No engine on the box yet — the state probe finds nothing.
    if (cmd.includes(STATE_PROBE)) return "";
    // Docker is available.
    if (cmd.includes("docker version")) return "27.0.0\n";
    // Image presence probe (docker image inspect -f '{{.Id}}').
    if (cmd.includes("docker image inspect")) return opts.imagePresent ? "sha256:abc\n" : "";
    // Port-listening probe reads /proc/net/tcp.
    if (cmd.includes("/proc/net/tcp")) return PROC_LISTENING;
    return "";
  });
  const writeFile = vi.fn(async () => {});
  const exists = vi.fn(async () => opts.dockerfilePresent ?? false);
  return { executor: { exec, streamExec, writeFile, exists } as never, exec, streamExec, exists };
}

describe("ensureContainerMail local-image awareness", () => {
  it("skips the registry pull when the image is already present locally", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const { executor, streamExec } = firstBootExecutor({ imagePresent: true });

    await ensureContainerMail(executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
      // no build spec → pull path, but image is local
    }).catch(() => {}); // verifyEngine may fail on the stub; we only assert the pull

    const pulled = streamExec.mock.calls.some(([cmd]) => String(cmd).startsWith("docker pull"));
    expect(pulled).toBe(false);
  });

  it("pulls when no build spec and the image is absent locally", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const { executor, streamExec } = firstBootExecutor({ imagePresent: false });

    await ensureContainerMail(executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
    }).catch(() => {});

    const pulled = streamExec.mock.calls.some(([cmd]) => String(cmd).startsWith("docker pull"));
    expect(pulled).toBe(true);
  });
});

describe("ensureContainerMail build path", () => {
  it("builds from the checkout instead of pulling when the Dockerfile is on the executor", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const { executor, streamExec, exists } = firstBootExecutor({
      imagePresent: false,
      dockerfilePresent: true,
    });

    await ensureContainerMail(executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
      build: { context: "/src/openship" },
    }).catch(() => {});

    // Gated on the Dockerfile existing on the executor.
    expect(exists).toHaveBeenCalledWith("/src/openship/apps/email/Dockerfile");
    const cmds = streamExec.mock.calls.map(([cmd]) => String(cmd));
    expect(cmds.some((c) => c.startsWith("docker build -t"))).toBe(true);
    // A build stands in for the pull — the registry is never contacted.
    expect(cmds.some((c) => c.startsWith("docker pull"))).toBe(false);
  });

  it("falls through to the pull path when the context has no Dockerfile on the executor", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    // Remote box: build context is an API-local path that doesn't exist here.
    const { executor, streamExec } = firstBootExecutor({
      imagePresent: false,
      dockerfilePresent: false,
    });

    await ensureContainerMail(executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
      build: { context: "/api-only/path" },
    }).catch(() => {});

    const cmds = streamExec.mock.calls.map(([cmd]) => String(cmd));
    expect(cmds.some((c) => c.startsWith("docker build"))).toBe(false);
    expect(cmds.some((c) => c.startsWith("docker pull"))).toBe(true);
  });

  it("recreates on a same-tag rebuild when the running container's image ID is stale", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const streamExec = vi.fn(async (_cmd: string) => ({ code: 0, output: "" }));
    const exec = vi.fn(async (cmd: string) => {
      // Engine is running on the pinned tag.
      if (cmd.includes(STATE_PROBE)) return stateLine("ghcr.io/x/openship-mail:pinned");
      // Container was created from the OLD image ID...
      if (cmd.includes("inspect -f '{{.Image}}'")) return "sha256:old\n";
      // ...but the freshly-built ref now points at a NEW ID → stale → recreate.
      if (cmd.includes("docker image inspect")) return "sha256:new\n";
      if (cmd.includes("/proc/net/tcp")) return PROC_LISTENING;
      return "";
    });
    const exists = vi.fn(async () => true);
    const executor = { exec, streamExec, exists, writeFile: vi.fn(async () => {}) } as never;

    await ensureContainerMail(executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
      build: { context: "/src/openship" },
    }).catch(() => {});

    const cmds = streamExec.mock.calls.map(([cmd]) => String(cmd));
    expect(cmds.some((c) => c.startsWith("docker build -t"))).toBe(true);
    // Recreated in place — a new `docker run` for the engine, no pull, no swap-pull.
    expect(cmds.some((c) => c.includes("docker run") && c.includes("--network host"))).toBe(true);
    expect(cmds.some((c) => c.startsWith("docker pull"))).toBe(false);
  });
});
