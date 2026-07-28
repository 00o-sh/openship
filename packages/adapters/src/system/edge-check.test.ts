import { describe, expect, it, vi } from "vitest";

import { checkOpenResty } from "./checks";
import { uninstallOpenResty } from "./installer";
import type { CommandExecutor } from "../types";

function host(answers: Array<[string, string]>): CommandExecutor {
  return {
    exec: vi.fn(async (cmd: string) => {
      for (const [needle, out] of answers) if (cmd.includes(needle)) return out;
      return "";
    }),
  } as unknown as CommandExecutor;
}

describe("checkOpenResty", () => {
  it("reports healthy from the edge CONTAINER", async () => {
    // A converted box has no openresty binary, no unit and no Lua on the host, so
    // every host probe reads "missing" — the component would show broken while the
    // edge is serving fine.
    const status = await checkOpenResty(
      host([
        ["docker ps --filter name=openship-edge", "openship-edge"],
        ["openresty -v", "nginx version: openresty/1.27.1.1"],
      ]),
    );

    expect(status.healthy).toBe(true);
    expect(status.version).toBe("1.27.1.1");
  });

  it("flags a running-but-unresponsive edge container", async () => {
    const status = await checkOpenResty(
      host([["docker ps --filter name=openship-edge", "openship-edge"]]),
    );

    expect(status.healthy).toBe(false);
    expect(status.message).toMatch(/docker logs openship-edge/);
  });

  it("still checks the bare host edge when no container is running", async () => {
    const status = await checkOpenResty(
      host([
        ["openresty -v", "nginx version: openresty/1.25.3.1"],
        ["pgrep", "555"],
        ["site_logger.lua", "ok"],
      ]),
    );

    expect(status.healthy).toBe(true);
    expect(status.version).toBe("1.25.3.1");
  });

  it("reports missing on a box with neither", async () => {
    const status = await checkOpenResty(host([]));
    expect(status.healthy).toBe(false);
  });
});

describe("uninstallOpenResty on a container edge", () => {
  it("removes the container and never pkills openresty on the host", async () => {
    // `pkill -f openresty` matches a HOST-NETWORKED container's own master process,
    // so the bare uninstall path would kill the edge it's supposed to be removing
    // cleanly — and then fail purging a package that was never installed.
    const cmds: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd.startsWith("docker ps --filter name=openship-edge")) return "openship-edge";
      if (cmd.includes("id -u")) return "0";
      return "";
    });

    const result = await uninstallOpenResty(
      { exec, streamExec: vi.fn(async () => ({ code: 0, output: "" })) } as unknown as CommandExecutor,
      () => {},
    );

    expect(result.success).toBe(true);
    expect(cmds.some((c) => c.includes("docker rm -f 'openship-edge'"))).toBe(true);
    // Restart policy cleared first, or the daemon brings it right back.
    expect(cmds.some((c) => c.includes("docker update --restart=no"))).toBe(true);
    expect(cmds.some((c) => c.includes("pkill"))).toBe(false);
    expect(cmds.some((c) => c.includes("purge") || c.includes("systemctl stop openresty"))).toBe(false);
  });
});
