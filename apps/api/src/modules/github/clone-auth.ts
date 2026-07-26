/**
 * @module clone-auth
 *
 * Thin adapter over the unified token dispatcher in `github.token.ts` for
 * the deploy pipeline. The dispatcher (`tokenFor(userId, purpose, ctx)`)
 * already encodes the full priority chain; this file only translates the
 * deploy-specific `buildStrategy` discriminator into a `purpose`:
 *
 *   - buildStrategy="local"  → tokenFor(..., "local")
 *   - buildStrategy="server" → requireTokenFor(..., "remote")
 *
 * gh CLI tokens are never returned for "remote" — that policy lives in
 * `tokenFor("remote", ...)` and the rejection happens before this
 * function ever sees a token.
 *
 * Token priority (single source of truth — see github.token.ts):
 *   - purpose: "local"  → gh CLI > App > project > user-pat > OAuth
 *     (auto-resolved credentials first; gh is opt-in-gated for multi-user)
 *   - purpose: "remote" → project > user-pat > App > REFUSE (no gh CLI)
 *
 * This function owns the ORDER of the whole clone-credential chain; the steps
 * that aren't tokens live beside it here rather than in their own resolvers, so
 * there is one readable sequence:
 *
 *   1. per-server stored identity (device token / PAT / ssh key / deploy key)
 *   2. App installation or PAT (`tokenFor("remote")`)
 *   3. public repo → anonymous
 *   4. the server's OWN pre-existing git access (ambient, verified per repo)
 *   5. desktop credential relay (forwarded, nothing persisted)
 *   6. api-host clone + context transfer (docker only)
 *
 * Steps 4-6 are all "nothing of ours can reach the server" fallbacks, ordered by
 * how little credential material moves: 4 moves none, 5 moves it only for the
 * lifetime of one git request, 6 keeps it here and moves the source instead.
 */

import { type BuildStrategy } from "@repo/core";
import type { AmbientGitVia, CommandExecutor } from "@repo/adapters";
import { tokenFor, requireTokenFor, type TokenContext } from "./github.token";
import { isPublicRepo } from "./github.http";
import { getLocalGhToken, hasLocalGitIdentity } from "./github.local-auth";
import { resolveServerGitCredential } from "./server-github.service";
import type { RequestContext } from "../../lib/request-context";

/**
 * Result of build-token resolution:
 *   - `{ token }`        → inject into the clone URL (existing behavior).
 *   - `{ relay: true }`  → no token, but the target server opted into git
 *     credential forwarding: clone via the desktop relay (gh identity, never
 *     persisted on the remote). The orchestrator opens the relay.
 *   - `{}`               → no credential (a local build of a public repo).
 */
export interface BuildGitCredential {
  token?: string;
  relay?: boolean;
  /**
   * The TARGET SERVER authenticates the clone with its own pre-existing git
   * credentials, verified against this repo by `probeServerGitAccess`. Nothing is
   * shipped to it and nothing is read off it. Valid only for a clone that runs on
   * that server.
   */
  ambient?: { via: AmbientGitVia };
  /**
   * Public repo on a remote clone: no credential is needed at all, so an
   * on-server clone (or anonymous tarball download) can proceed. Distinct from
   * `{}` — which also means "local build, nothing resolved" — because the
   * pipeline must be able to tell "nothing needed" from "nothing available".
   */
  anonymous?: boolean;
  /**
   * Set when a server clone-on-server was requested but no SHIPPABLE credential
   * (relay / App / PAT) exists, so the caller must degrade to an api-host clone
   * (clone on the orchestrator, transfer the context). Any `token` returned
   * alongside this is a LOCAL credential valid ONLY for cloning on this host — it
   * must NOT be shipped off-host. Callers therefore treat token-presence as
   * "shippable" only when this flag is absent.
   */
  apiHostFallback?: boolean;
  /**
   * SSH credential for cloning over git@github.com. Returned by a per-server
   * config whose mode is ssh-server-key / ssh-deploy-key. Can't be a `token`
   * (HTTPS-only), so it's carried here and consumed by the adapter clone step
   * (GIT_SSH_COMMAND with a 0600 key + pinned known_hosts). Decrypted only at
   * deploy time; never logged.
   */
  ssh?: {
    keyKind: "server-key" | "deploy-key";
    /** Decrypted OpenSSH private key. */
    privateKey: string;
    /** Pinned github.com host keys for StrictHostKeyChecking. */
    knownHosts: string;
  };
}

/** Resolve a credential for a clone that runs on THIS host (local gh, else the
 *  resolver chain). Shared by the local-build path and the api-host fallback. */
async function resolveLocalCredential(
  ctx: RequestContext,
  tokenCtx: TokenContext,
): Promise<{ token?: string }> {
  const ghToken = await getLocalGhToken();
  if (ghToken) return { token: ghToken };
  const r = await tokenFor(ctx, "local", tokenCtx);
  return r?.token ? { token: r.token } : {};
}

export async function resolveBuildGitToken(opts: {
  /** Caller's request context. Carries userId + organizationId; org-scoped
   *  App installation lookup uses ctx.organizationId. */
  ctx: RequestContext;
  projectId: string;
  owner?: string | null;
  /** Repo name — threaded to the github-access gate for PER-REPO
   *  authorization (so a member granted only repo X can build X). */
  repo?: string | null;
  buildStrategy: BuildStrategy;
  /**
   * Target server id (server deploys). When set, a per-server GitHub auth
   * config wins for clones that run on THAT server (self-hosted only). Left
   * unset for local/cloud clones.
   */
  serverId?: string | null;
  /**
   * Desktop-only: when a SERVER build has no remote token (no App / PAT),
   * signal `{ relay: true }` instead of throwing — set by the orchestrator only
   * when the operator opted in for THIS deploy (the deploy flow's "Forward my
   * git credentials" choice → `snapshot.forwardGitCredentials`) and it's an
   * eligible (non-docker) server build. The gh token is NOT returned here; it's
   * fetched on demand by the relay's remote helper, so it never lands on the
   * build host.
   */
  allowRelayFallback?: boolean;
  /**
   * DOCKER clone-on-server only: when a SERVER clone has no shippable credential
   * (no relay, no App/PAT), degrade to an api-host clone instead of throwing —
   * return `{ apiHostFallback: true }` (with a LOCAL token when one exists). The
   * pipeline then clones on the orchestrator and transfers the context. Bare
   * server builds must NOT set this (they can only clone on the target and are
   * gated by their own hard-fail preflight checks).
   */
  allowApiHostFallback?: boolean;
  /**
   * Executor for the TARGET SERVER, when the clone will run there. Enables the
   * ambient probe ("can this server reach the repo with its own credentials?").
   * Omit for local/cloud clones — there is no server identity to consult.
   */
  serverExecutor?: Pick<CommandExecutor, "exec"> | null;
  /** Clone URL, required by the ambient probe (it verifies this exact remote). */
  repoUrl?: string | null;
  /** Build-log sink for the probe's one-line outcome. Never receives secrets. */
  onLog?: (message: string) => void;
}): Promise<BuildGitCredential> {
  const tokenCtx: TokenContext = {
    projectId: opts.projectId,
    owner: opts.owner ?? undefined,
    repo: opts.repo ?? undefined,
  };

  if (opts.buildStrategy === "local") {
    // LOCAL build: clone + build run on THIS host, the token never leaves it,
    // and we're already authenticated via gh — so use the local gh token
    // DIRECTLY, no SaaS App-token fetch. (Same rule as local READS in
    // githubFetch: local op → gh.) Falls through to the full resolver chain
    // (App installation / project PAT / user PAT / OAuth) only when there's no
    // local gh. getLocalGhToken self-guards to null in CLOUD_MODE.
    return resolveLocalCredential(opts.ctx, tokenCtx);
  }

  // SERVER / REMOTE build: the clone/build runs off this host.
  //
  // Per-server GitHub identity FIRST (self-hosted): if this deploy's target
  // server has its own configured GitHub auth (device-flow token, per-server
  // PAT, or an SSH key), it wins for clones that run on that server — the
  // operator explicitly configured the host. Falls through to the shared chain
  // (App / PAT / relay) when the server has none.
  if (opts.serverId) {
    const serverCred = await resolveServerGitCredential({
      serverId: opts.serverId,
      ctx: opts.ctx,
      owner: opts.owner ?? null,
      repo: opts.repo ?? null,
    });
    if (serverCred) return serverCred;
  }

  // Otherwise prefer the SaaS-minted App installation token (short-lived,
  // repo-scoped) or a PAT — gh is REFUSED in this chain (HIGH #7: never ship
  // the operator's broad token off-host via the URL).
  const r = await tokenFor(opts.ctx, "remote", tokenCtx);
  if (r?.token) return { token: r.token };

  // No remote token — but a PUBLIC github.com repo clones anonymously (nothing
  // to ship off-host, no relay/fallback needed). This is what lets a public
  // repo deploy with zero credentials, exactly like Vercel. Checked here (only
  // when no token resolved) so it never costs an API call for private repos.
  if (opts.owner && opts.repo && (await isPublicRepo(opts.owner, opts.repo))) {
    return { anonymous: true };
  }

  // Nothing of ours reaches the server — but the SERVER may already reach the
  // repo on its own (`gh` logged in there, a configured credential helper, its
  // own ssh key). Preferred over both remaining options because no credential
  // moves in either direction, and verified against THIS repo first so a server
  // authenticated as the wrong account reports nothing instead of failing the
  // build. Deliberately placed AFTER the App/PAT chain: it can only turn a
  // deploy that was about to give up into an on-server clone, never re-route one
  // that already works.
  if (opts.serverExecutor && opts.repoUrl) {
    const { probeServerGitAccess } = await import("./server-git-ambient");
    const ambient = await probeServerGitAccess({
      executor: opts.serverExecutor,
      repoUrl: opts.repoUrl,
      onLog: opts.onLog,
    });
    if (ambient) return { ambient };
  }

  // No shippable server/App/PAT token. Prefer FORWARDING (the relay) over an
  // api-host clone — it clones directly on the build host, atomically, with
  // nothing persisted. But the relay vends the operator's LOCAL gh token
  // specifically (its remote helper resolves via getLocalGhToken), so only
  // forward when a gh identity actually exists — otherwise the relay would open
  // and vend nothing. When it's absent, fall through to the api-host clone.
  if (opts.allowRelayFallback && (await hasLocalGitIdentity())) {
    return { relay: true };
  }

  // Docker clone-on-server with no shippable credential and no forwardable gh:
  // degrade to an api-host clone rather than hard-failing after the server was
  // already provisioned. The api-host clone runs on THIS host, so a LOCAL
  // credential is valid (flagged apiHostFallback so callers never ship it off-host).
  if (opts.allowApiHostFallback) {
    const local = await resolveLocalCredential(opts.ctx, tokenCtx);
    return { ...local, apiHostFallback: true };
  }

  // Otherwise surface the standard actionable error (requireTokenFor throws).
  await requireTokenFor(opts.ctx, "remote", tokenCtx);
  // Unreachable: requireTokenFor always throws when no token is resolvable.
  return {};
}
