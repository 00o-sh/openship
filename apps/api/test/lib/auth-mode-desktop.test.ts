import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * getAuthMode() on the desktop app.
 *
 * The bug: a persisted `instanceSettings.authMode = "cloud"` won outright, so a
 * desktop launch rendered the Openship Cloud sign-in screen — delegating login to
 * a remote IdP for an app that only ever serves 127.0.0.1 — and the only way out
 * was wiping the local DB. A stale row from a cloud connect or an old onboarding
 * run was enough to trigger it.
 *
 * The fix is deliberately narrow, and these tests pin that narrowness:
 *   - desktop + stored "cloud"  → downgraded to "none"
 *   - desktop + stored "local"  → HONOURED (someone put a password on a shared
 *                                 machine; silently ignoring it is a downgrade)
 *   - OPENSHIP_REQUIRE_AUTH / OPENSHIP_PUBLIC_URL → the stored value stands, so
 *                                 the CLI-managed and publicly-served escape
 *                                 hatches keep working
 *   - non-desktop (docker/bare/SaaS) → untouched
 */

const settings: { authMode?: string | null } = {};

vi.mock("@repo/db", () => ({
  repos: { instanceSettings: { get: async () => settings } },
}));

const envMock: Record<string, unknown> = {};
vi.mock("../../src/config/env", () => ({ env: envMock }));

async function resolve(): Promise<string> {
  const mod = await import("../../src/lib/auth-mode");
  mod.clearAuthModeCache();
  return mod.getAuthMode();
}

beforeEach(() => {
  for (const k of Object.keys(envMock)) delete envMock[k];
  delete settings.authMode;
});

afterEach(async () => {
  const { clearAuthModeCache } = await import("../../src/lib/auth-mode");
  clearAuthModeCache();
});

describe("getAuthMode() — desktop", () => {
  it("downgrades a stale persisted 'cloud' to zero-auth", async () => {
    envMock.DEPLOY_MODE = "desktop";
    settings.authMode = "cloud";
    expect(await resolve()).toBe("none");
  });

  it("honours a deliberate persisted 'local' (never a silent downgrade)", async () => {
    envMock.DEPLOY_MODE = "desktop";
    settings.authMode = "local";
    expect(await resolve()).toBe("local");
  });

  it("defaults to zero-auth when nothing is persisted", async () => {
    envMock.DEPLOY_MODE = "desktop";
    expect(await resolve()).toBe("none");
  });

  it("keeps 'cloud' when OPENSHIP_REQUIRE_AUTH is set", async () => {
    envMock.DEPLOY_MODE = "desktop";
    envMock.OPENSHIP_REQUIRE_AUTH = true;
    settings.authMode = "cloud";
    expect(await resolve()).toBe("cloud");
  });

  it("keeps 'cloud' when the box is publicly served", async () => {
    envMock.DEPLOY_MODE = "desktop";
    envMock.OPENSHIP_PUBLIC_URL = "https://openship.example.com";
    settings.authMode = "cloud";
    expect(await resolve()).toBe("cloud");
  });
});

describe("getAuthMode() — not desktop", () => {
  it.each(["docker", "bare", "cloud"])("leaves a stored 'cloud' alone (%s)", async (mode) => {
    envMock.DEPLOY_MODE = mode;
    settings.authMode = "cloud";
    expect(await resolve()).toBe("cloud");
  });

  it("defaults a fresh self-hosted install to 'local'", async () => {
    envMock.DEPLOY_MODE = "docker";
    expect(await resolve()).toBe("local");
  });
});
