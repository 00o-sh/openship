import { describe, expect, it, vi } from "vitest";

import { probeServerGitAccess } from "../../../src/modules/github/server-git-ambient";

const REPO = "https://github.com/acme/app.git";

/**
 * Fake executor: `discover` is the capability line-set the host reports, and
 * `verifyOk` decides which `ls-remote` invocations succeed. Records every command
 * so the secrecy assertions can inspect them.
 */
function executor(opts: { discover: string; verifyOk?: (cmd: string) => boolean }) {
  const commands: string[] = [];
  return {
    commands,
    exec: vi.fn(async (cmd: string) => {
      commands.push(cmd);
      if (!cmd.includes("ls-remote")) return opts.discover;
      if (opts.verifyOk?.(cmd)) return "";
      throw new Error("exit 128");
    }),
  };
}

const ALL = "git=1\ngh=1\nhelper=1\ncredfile=0\nsshkey=1";
const NONE = "git=1\ngh=0\nhelper=0\ncredfile=0\nsshkey=0";

describe("probeServerGitAccess — verification", () => {
  it("reports the mechanism that actually reached THIS repo", async () => {
    const ex = executor({ discover: ALL, verifyOk: (c) => c.includes("gh auth git-credential") });
    expect(await probeServerGitAccess({ executor: ex, repoUrl: REPO })).toEqual({ via: "gh" });
  });

  it("returns null when the host has git but no credential of any kind", async () => {
    const ex = executor({ discover: NONE });
    expect(await probeServerGitAccess({ executor: ex, repoUrl: REPO })).toBeNull();
    // Nothing to verify, so it must not spend round trips trying.
    expect(ex.commands.filter((c) => c.includes("ls-remote"))).toHaveLength(0);
  });

  it("returns null when a mechanism EXISTS but cannot read this repo", async () => {
    // The wrong-account case: `gh` is logged in, just not as someone with access.
    const ex = executor({ discover: ALL, verifyOk: () => false });
    expect(await probeServerGitAccess({ executor: ex, repoUrl: REPO })).toBeNull();
  });

  it("falls past a non-working mechanism to one that works", async () => {
    const ex = executor({ discover: ALL, verifyOk: (c) => c.includes("git@github.com") });
    expect(await probeServerGitAccess({ executor: ex, repoUrl: REPO })).toEqual({ via: "ssh" });
  });

  it("verifies the exact repo it was asked about", async () => {
    const ex = executor({ discover: ALL, verifyOk: () => true });
    await probeServerGitAccess({ executor: ex, repoUrl: REPO });
    const verify = ex.commands.find((c) => c.includes("ls-remote"));
    expect(verify).toContain("acme/app");
  });

  it("returns null (never throws) when the host is unreachable", async () => {
    const ex = { exec: vi.fn().mockRejectedValue(new Error("ssh: connect: timed out")) };
    expect(await probeServerGitAccess({ executor: ex, repoUrl: REPO })).toBeNull();
  });

  it("returns null when git itself is missing", async () => {
    const ex = executor({ discover: "git=0\ngh=1\nhelper=1\ncredfile=1\nsshkey=1" });
    expect(await probeServerGitAccess({ executor: ex, repoUrl: REPO })).toBeNull();
  });
});

describe("probeServerGitAccess — no credential moves in either direction", () => {
  it("never reads a token, helper output or key material back off the host", async () => {
    const ex = executor({ discover: ALL, verifyOk: () => true });
    await probeServerGitAccess({ executor: ex, repoUrl: REPO });

    for (const cmd of ex.commands) {
      // `gh auth token` may be used as an exit-status check ONLY — its output must
      // be discarded, never captured into a variable or echoed back to us.
      if (cmd.includes("gh auth token")) {
        expect(cmd).toContain("gh auth token >/dev/null 2>&1");
        expect(cmd).not.toMatch(/\$\(\s*gh auth token/);
      }
      // These would each transfer a secret to the API host.
      expect(cmd).not.toContain("credential fill");
      expect(cmd).not.toContain("cat $HOME/.git-credentials");
      expect(cmd).not.toMatch(/cat .*id_(rsa|ed25519)(?!\.pub)/);
    }
  });

  it("ships no token or key INTO the clone URL it verifies", async () => {
    const ex = executor({ discover: ALL, verifyOk: () => true });
    await probeServerGitAccess({ executor: ex, repoUrl: REPO });
    const verify = ex.commands.find((c) => c.includes("ls-remote")) ?? "";
    expect(verify).not.toContain("x-access-token");
    expect(verify).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  });

  it("keeps the host's own credential helper enabled (it IS the auth)", async () => {
    const ex = executor({ discover: ALL, verifyOk: () => true });
    await probeServerGitAccess({ executor: ex, repoUrl: REPO });
    const verify = ex.commands.find((c) => c.includes("ls-remote")) ?? "";
    // The token path disables it; ambient must not, or there'd be no credential.
    expect(verify).not.toContain("-c credential.helper=");
  });

  it("discards ref output so a build log can't leak private branch names", async () => {
    const ex = executor({ discover: ALL, verifyOk: () => true });
    await probeServerGitAccess({ executor: ex, repoUrl: REPO });
    const verify = ex.commands.find((c) => c.includes("ls-remote")) ?? "";
    expect(verify).toContain(">/dev/null 2>&1");
  });
});
