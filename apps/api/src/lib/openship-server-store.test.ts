import { describe, it, expect } from "vitest";
import type { CommandExecutor } from "@repo/adapters";

// The real fixture rather than a hand-rolled profile literal: this exercises the actual
// resolver + privilege gate, so a probe shape change must break it rather than pass.
import { probeOutput } from "../../../../packages/adapters/src/system/environment.fixtures";
import {
  OPENSHIP_DIR,
  openshipFileExists,
  readOpenshipFile,
  writeOpenshipFile,
} from "./openship-server-store";

/**
 * Privilege for the server state store.
 *
 * `.openship` is 0700 root-owned by design, so on a host we log in to as a non-root user
 * EVERY operation here needs elevation — including the reads, which is the half that hid:
 * a `cat` of a file the login user could never have written returns "" and is
 * indistinguishable from "this server has no Openship state", which is exactly what
 * `scan` reads to re-import our own projects.
 *
 * A fresh executor object per case on purpose: the profile is cached per executor
 * identity, so sharing one would leak the first case's host into the rest.
 */
function fakeHost(probe: string, fileBody = "PAYLOAD") {
  const commands: string[] = [];
  const writes: string[] = [];

  const executor = {
    exec: async (command: string) => {
      commands.push(command);
      if (command.includes("opsh_begin")) return probe;
      if (command.includes("cat ")) return fileBody;
      if (command.includes("test -f")) return "yes";
      return "";
    },
    writeFile: async (path: string) => {
      writes.push(path);
    },
  } as unknown as CommandExecutor;

  // The store's own commands. The probe is filtered out because it carries a `sudo -n
  // true` of its own — a bare "no sudo anywhere" assertion would always fail.
  const stored = () => commands.filter((c) => !c.includes("opsh_begin"));

  return { executor, commands, writes, stored };
}

const NON_ROOT_SUDO = probeOutput({
  uid: "1000",
  user: "deploy",
  home: "/home/deploy",
  sudo: "y",
});
const NON_ROOT_NO_SUDO = probeOutput({
  uid: "1000",
  user: "deploy",
  home: "/home/deploy",
  sudo: "n",
});

describe("openship-server-store privilege", () => {
  it("elevates every operation on a non-root login, without moving the path", async () => {
    const write = fakeHost(NON_ROOT_SUDO);
    await writeOpenshipFile(write.executor, "manifest.json", "{}");

    // Staged through a user-writable temp, then moved into the root-owned dir as root —
    // SFTP has no shell and cannot be elevated, so a direct write would EACCES.
    expect(write.writes).toHaveLength(1);
    expect(write.writes[0]!.startsWith("/tmp/")).toBe(true);
    // Two hops, both as root: the staging mv out of /tmp, then the atomic promote.
    const mv = write.stored().filter((c) => c.includes("mv -f"));
    expect(mv).toHaveLength(2);
    expect(mv.every((c) => c.includes("sudo -n sh -c"))).toBe(true);
    expect(mv[0]).toContain(`${OPENSHIP_DIR}/manifest.json.tmp`);
    expect(mv[1]).toContain(`${OPENSHIP_DIR}/manifest.json`);

    const read = fakeHost(NON_ROOT_SUDO);
    expect(await readOpenshipFile(read.executor, "manifest.json")).toBe("PAYLOAD");
    expect(read.stored().find((c) => c.includes("cat "))).toContain("sudo -n sh -c");

    const stat = fakeHost(NON_ROOT_SUDO);
    expect(await openshipFileExists(stat.executor, "manifest.json")).toBe(true);
    expect(stat.stored().find((c) => c.includes("test -f"))).toContain("sudo -n sh -c");
  });

  it("leaves a root login exactly as it was — no sudo, same path", async () => {
    const { executor, stored, writes } = fakeHost(probeOutput());
    await writeOpenshipFile(executor, "manifest.json", "{}");

    expect(writes).toEqual([`${OPENSHIP_DIR}/manifest.json.tmp`]);
    expect(stored().some((c) => c.includes("sudo"))).toBe(false);
  });

  it("still reads state on a host it could not measure", async () => {
    // A banner or forced command means no profile. Refusing here would turn a readable
    // manifest into a missing one — a regression dressed as a safety check.
    const { executor, stored } = fakeHost("Please login as the user \"ec2-user\"\n");

    expect(await readOpenshipFile(executor, "manifest.json")).toBe("PAYLOAD");
    expect(stored().some((c) => c.includes("sudo"))).toBe(false);
  });

  it("names the fix when the login is measurably unprivileged", async () => {
    const write = fakeHost(NON_ROOT_NO_SUDO);
    await expect(writeOpenshipFile(write.executor, "manifest.json", "{}")).rejects.toThrow(
      /passwordless sudo/,
    );
    expect(write.writes).toEqual([]);

    // Reads stay non-throwing by contract; absent state is still absent state.
    const read = fakeHost(NON_ROOT_NO_SUDO);
    expect(await readOpenshipFile(read.executor, "manifest.json")).toBe("");
  });
});
