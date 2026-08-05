import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, it, expect } from "vitest";

import { mailBuildSpec } from "./mail-image";

const ENV = "OPENSHIP_MAIL_BUILD_CONTEXT";
const original = process.env[ENV];

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

describe("mailBuildSpec", () => {
  it("returns the explicit OPENSHIP_MAIL_BUILD_CONTEXT when set", () => {
    process.env[ENV] = "/srv/openship-checkout";
    expect(mailBuildSpec()).toEqual({ context: "/srv/openship-checkout" });
  });

  it("auto-detects a repo root that actually holds apps/email/Dockerfile", () => {
    delete process.env[ENV];
    const spec = mailBuildSpec();
    // Running from a source checkout, so the anchor above apps/api IS the repo root.
    // Assert the context is a real dir holding the Dockerfile rather than hardcoding a
    // path — the guard is what keeps a bundled install from returning a bogus context.
    expect(spec).toBeDefined();
    expect(existsSync(join(spec!.context, "apps", "email", "Dockerfile"))).toBe(true);
  });
});
