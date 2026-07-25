import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the compose backend + the host edge preflight so runCompose's ORCHESTRATION
// (gate → preflight → up → import) is exercised without real docker / ss / fs.
const h = vi.hoisted(() => ({
  hasDocker: true,
  composeUpResult: { ok: true, apiPort: "4000", dashPort: "3001" },
  composeUpCalls: 0,
  internalToken: "tok" as string | null,
}));
vi.mock("../../src/lib/compose", () => ({
  hasDockerCompose: () => h.hasDocker,
  composeIsViableDefault: () => true,
  composeUp: () => {
    h.composeUpCalls++;
    return h.composeUpResult;
  },
  composeInternalToken: () => h.internalToken,
}));

const e = vi.hoisted(() => ({ plan: { proceed: true } as any, calls: 0 }));
vi.mock("../../src/lib/edge-preflight", () => ({
  planAndApplyHostEdge: async () => {
    e.calls++;
    return e.plan;
  },
}));

import { upCommand } from "../../src/commands/up";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

// up.ts prints via console.log/console.error, which vitest intercepts (so the
// harness's process.stdout.write capture misses them). Capture console directly.
function captureConsole() {
  let buf = "";
  const sink = (...a: unknown[]) => {
    buf += a.map(String).join(" ") + "\n";
  };
  const log = vi.spyOn(console, "log").mockImplementation(sink);
  const error = vi.spyOn(console, "error").mockImplementation(sink);
  return {
    text: () => buf.replace(/\[[0-9;]*m/g, ""),
    restore: () => {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

let fetchStub: FetchStub | undefined;
let con: ReturnType<typeof captureConsole>;

beforeEach(() => {
  h.hasDocker = true;
  h.composeUpResult = { ok: true, apiPort: "4000", dashPort: "3001" };
  h.composeUpCalls = 0;
  h.internalToken = "tok";
  e.plan = { proceed: true };
  e.calls = 0;
  // Clear any option values commander retained from a previous parse.
  (upCommand as any).setOptionValue?.("edge", undefined);
  (upCommand as any).setOptionValue?.("compose", undefined);
  con = captureConsole();
});

afterEach(() => {
  con.restore();
  fetchStub?.restore();
  fetchStub = undefined;
  vi.restoreAllMocks();
});

describe("openship up --compose (edge chain)", () => {
  it("exits before the edge preflight when docker/compose is missing", async () => {
    h.hasDocker = false;
    const r = await runCommand(upCommand, ["--compose"]);
    expect(r.code).toBe(1);
    expect(e.calls).toBe(0); // gate is first
    expect(h.composeUpCalls).toBe(0);
    expect(con.text()).toContain("docker compose");
  });

  it("brings the stack up when the edge is clean", async () => {
    e.plan = { proceed: true };
    const r = await runCommand(upCommand, ["--compose"]);
    expect(e.calls).toBe(1);
    expect(h.composeUpCalls).toBe(1);
    expect(r.code).toBe(0);
  });

  it("does NOT bring the stack up when the user cancels the edge takeover", async () => {
    e.plan = { proceed: false };
    const r = await runCommand(upCommand, ["--compose"]);
    expect(e.calls).toBe(1);
    expect(h.composeUpCalls).toBe(0);
    expect(r.code).toBe(1);
    expect(con.text()).toContain("Left the existing proxy");
  });

  it("imports migrated sites into the edge after the stack is healthy", async () => {
    e.plan = {
      proceed: true,
      action: "migrate",
      sites: [{ serverNames: ["a.com"], ssl: true, target: { kind: "proxy", url: "http://127.0.0.1:3000" } }],
      certPems: { "/etc/ssl/a.crt": { certPem: "CERT", keyPem: "KEY" } },
    };
    fetchStub = stubFetch((req) => {
      if (req.url.endsWith("/api/health")) return { status: 200, json: { ok: true } };
      if (req.url.endsWith("/api/system/edge/import-sites")) return { status: 200, json: { registered: ["a.com"], warnings: [] } };
      return { status: 404, json: {} };
    });

    const r = await runCommand(upCommand, ["--compose"]);
    expect(r.code).toBe(0);
    expect(h.composeUpCalls).toBe(1);

    const importCall = fetchStub.calls.find((c) => c.url.endsWith("/api/system/edge/import-sites"));
    expect(importCall).toBeDefined();
    expect(importCall!.method).toBe("POST");
    expect(importCall!.headers["x-internal-token"]).toBe("tok");
    expect((importCall!.body as any).sites).toHaveLength(1);
    expect((importCall!.body as any).certPems).toEqual({ "/etc/ssl/a.crt": { certPem: "CERT", keyPem: "KEY" } });
  });

  it("rejects an invalid --edge value before any side effects", async () => {
    const r = await runCommand(upCommand, ["--compose", "--edge", "bogus"]);
    expect(r.code).toBe(1);
    expect(e.calls).toBe(0);
    expect(h.composeUpCalls).toBe(0);
    expect(con.text()).toContain("Invalid --edge");
  });
});
