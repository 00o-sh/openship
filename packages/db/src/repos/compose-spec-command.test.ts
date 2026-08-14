import { describe, expect, it } from "vitest";
import { composeSpecDiff, composeSpecsEqual, composeWritePatch, toComposeSpec } from "./service.repo";

/**
 * #332 drift stability: adding structured `commandArgv` must NOT make a legacy
 * row (stored with only the text `command`, argv null) read as drift against its
 * re-parse (same command, argv populated). `toComposeSpec` derives argv from the
 * text command so both canonicalize identically. A genuine argv change still
 * surfaces.
 */
describe("compose command drift stability (#332)", () => {
  it("legacy text command ≡ re-parsed command+argv (no phantom drift)", () => {
    const legacy = toComposeSpec({ command: "serve --host 0.0.0.0" }); // argv null → derived
    const reparsed = toComposeSpec({
      command: "serve --host 0.0.0.0",
      commandArgv: ["serve", "--host", "0.0.0.0"],
    });
    expect(composeSpecsEqual(legacy, reparsed)).toBe(true);
    expect(composeSpecDiff(legacy, reparsed).some((c) => c.field === "command" || c.field === "commandArgv")).toBe(false);
  });

  it("a genuine argv change is still flagged", () => {
    const before = toComposeSpec({ command: "serve --host 0.0.0.0", commandArgv: ["serve", "--host", "0.0.0.0"] });
    const after = toComposeSpec({ command: "serve --host ::", commandArgv: ["serve", "--host", "::"] });
    expect(composeSpecsEqual(before, after)).toBe(false);
    expect(composeSpecDiff(before, after).some((c) => c.field === "command" || c.field === "commandArgv")).toBe(true);
  });

  it("args-with-spaces: a real representation difference the old join lost is caught", () => {
    // old join stored "a b" (argv null → derived ["a","b"]); a genuine list ["a b"]
    const derivedFromLegacy = toComposeSpec({ command: "a b" });
    const genuineSingleArg = toComposeSpec({ command: "a b", commandArgv: ["a b"] });
    expect(composeSpecsEqual(derivedFromLegacy, genuineSingleArg)).toBe(false);
  });

  it("null command ≡ null command", () => {
    expect(composeSpecsEqual(toComposeSpec({}), toComposeSpec({}))).toBe(true);
  });
});

/**
 * `composeWritePatch` is the ONE gate every compose-sync writer passes through —
 * the sync endpoint, the migration importer, and (the one that bit) the deploy
 * request's own service list, whose wire shape carried `command` as a string only.
 * Because the stored string is a lossy display join, letting toComposeSpec re-derive
 * argv there meant a client replaying its service list re-split a correct
 * `["sh","-c","a && b"]` into five words on the next deploy.
 */
describe("composeWritePatch keeps argv faithful across a string-only writer (#332)", () => {
  const storedListCommand = {
    command: "sh -c a && b", // the lossy display join of the argv below
    commandArgv: ["sh", "-c", "a && b"],
  };

  it("an unchanged command string leaves the stored argv alone", () => {
    const patch = composeWritePatch({ name: "web", command: "sh -c a && b" }, storedListCommand);
    expect(patch.commandArgv).toEqual(["sh", "-c", "a && b"]);
  });

  it("without that rule the same input would have re-split the join", () => {
    // No stored row (a brand-new service): deriving is correct here.
    const patch = composeWritePatch({ name: "web", command: "sh -c a && b" }, null);
    expect(patch.commandArgv).toEqual(["sh", "-c", "a", "&&", "b"]);
  });

  it("a genuinely changed command re-derives argv", () => {
    const patch = composeWritePatch(
      { name: "web", command: "server start --verbose" },
      { command: "server start", commandArgv: ["server", "start"] },
    );
    expect(patch.commandArgv).toEqual(["server", "start", "--verbose"]);
  });

  it("an explicit argv from the parser wins over both", () => {
    const patch = composeWritePatch(
      { name: "web", command: "sh -c a && b", commandArgv: ["sh", "-c", "a && b"] },
      { command: "server start", commandArgv: ["server", "start"] },
    );
    expect(patch.commandArgv).toEqual(["sh", "-c", "a && b"]);
  });

  it("a dropped command clears argv with it", () => {
    const patch = composeWritePatch({ name: "web" }, storedListCommand);
    expect(patch.command).toBeNull();
    expect(patch.commandArgv).toBeNull();
  });

  it("still backfills a legacy row that has a command but no argv", () => {
    const patch = composeWritePatch(
      { name: "web", command: "server start" },
      { command: "server start", commandArgv: null },
    );
    expect(patch.commandArgv).toEqual(["server", "start"]);
  });
});
