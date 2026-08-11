import { describe, expect, it, vi } from "vitest";
import type { BuildConfig, CommandExecutor } from "../types";
import { DockerRuntime } from "./docker";

function buildConfig(sessionId: string): BuildConfig {
  return {
    sessionId,
    projectId: "project-1",
    slug: "cancel-test",
    repoUrl: "https://example.com/repo.git",
    branch: "main",
    stack: "docker",
    buildImage: "",
    packageManager: "",
    installCommand: "",
    buildCommand: "",
    outputDirectory: "",
    port: 8080,
    runtimeImage: "",
    envVars: {},
    resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
    cloneOnServer: true,
  };
}

describe("DockerRuntime build cancellation", () => {
  function runtimeWith(executor: CommandExecutor) {
    const verifyImageBuilt = vi.fn(async () => {});
    const cloneSourceOnRemote = vi.fn(async () => {});
    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime &
      Record<string, unknown>;
    Object.assign(runtime, {
      connectionOptions: { executor },
      transport: { kind: "ssh", description: "test ssh" },
      systemManager: null,
      _docker: {
        listContainers: vi.fn(async () => []),
      },
      cloneSourceOnRemote,
      resolveRemoteDockerfile: vi.fn(async () => "Dockerfile"),
      verifyImageBuilt,
    });
    return { runtime, verifyImageBuilt, cloneSourceOnRemote };
  }

  it("aborts the streamed SSH docker build and returns cancelled", async () => {
    let enteredBuild!: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      enteredBuild = resolve;
    });

    const executor = {
      exec: vi.fn(async () => ""),
      streamExec: vi.fn(async (_command, _onLog, opts) => {
        enteredBuild();
        await new Promise<void>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { code: 0, output: "" };
      }),
    } as unknown as CommandExecutor;

    const { runtime: buildRuntime, verifyImageBuilt } = runtimeWith(executor);
    const { runtime: cancelRuntime } = runtimeWith(executor);

    const resultPromise = buildRuntime.build(buildConfig("session-1"));
    await buildStarted;
    await cancelRuntime.cancelBuild("session-1");

    await expect(resultPromise).resolves.toMatchObject({
      sessionId: "session-1",
      status: "cancelled",
    });
    expect(executor.streamExec).toHaveBeenCalledWith(
      expect.stringContaining("docker build"),
      expect.any(Function),
      { signal: expect.any(AbortSignal) },
    );
    expect(executor.exec).toHaveBeenCalledWith(
      expect.stringContaining("/tmp/openship-build-session-1"),
    );
    expect(verifyImageBuilt).not.toHaveBeenCalled();
  });

  it("remembers cancellation that arrives before build registration", async () => {
    const executor = {
      exec: vi.fn(async () => ""),
      streamExec: vi.fn(async () => ({ code: 0, output: "" })),
    } as unknown as CommandExecutor;
    const { runtime: buildRuntime, cloneSourceOnRemote, verifyImageBuilt } = runtimeWith(executor);
    const { runtime: cancelRuntime } = runtimeWith(executor);

    await cancelRuntime.cancelBuild("session-queued");
    await expect(buildRuntime.build(buildConfig("session-queued"))).resolves.toMatchObject({
      sessionId: "session-queued",
      status: "cancelled",
    });

    expect(cloneSourceOnRemote).not.toHaveBeenCalled();
    expect(executor.streamExec).not.toHaveBeenCalled();
    expect(verifyImageBuilt).not.toHaveBeenCalled();
  });
});
