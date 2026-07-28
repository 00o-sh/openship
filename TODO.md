# TODO

Deferred work and known gaps. Items are grouped by area; each carries enough
context to be picked up cold. Anchors are `file:line` at time of writing —
re-grep if they drift.

---

## SSL / ACME

### Decision: ship on certbot, switch to `lua-resty-acme` later

Current state (verified): certbot is baked into the edge image
(`apps/edge/Dockerfile:23`) and issuance runs *inside* the edge container —
`certbot certonly --standalone --http-01-port 49180` (`packages/adapters/src/infra/nginx.ts:716`),
with the edge proxying `/.well-known/acme-challenge/` to that loopback port. No
host certbot, no port-80 fight, no webroot. Renewal is driven only by
`ssl-scheduler` → `manageDomainSsl("renew")`; there is deliberately no cron
inside the image.

**This is release-safe and does not foreclose the Lua switch**, because the ACME
implementation is already behind a seam:

- `SslProvider` (`packages/adapters/src/infra/types.ts:45`) is four methods —
  `provisionCert` / `renewCert` / `installCert` / `verifyCert`. certbot appears
  in the doc comments only, never in a signature.
- `apps/api/src/lib/domain-ssl.ts` is the single service-layer entrypoint. It
  owns the per-hostname issue lock, the `tlsIssuedElsewhere` gate, and status
  persistence, and talks only to the interface.
- A second implementation already exists (`packages/adapters/src/infra/cloud.ts`),
  so the seam is exercised, not theoretical.

Why we'd switch: no subprocess, no output scraping, no Python in the image,
on-demand issuance and auto-renew handled by the edge that already owns :443.
Why not now: it moves cert storage out of the standard layout, and several
subsystems read that layout directly (below).

### What the switch actually costs

The interface is clean, but the **cert location leaked past it**. These read or
write `/etc/letsencrypt/...` directly and must be handled before or during the
migration:

- `packages/adapters/src/infra/nginx.ts` — `certsExist` / `readCertInfo`, and
  the `ssl_certificate` directives in the generated vhost.
- `packages/adapters/src/system/proxy/cert-material.ts` — cert reuse / carry.
- `packages/adapters/src/system/proxy/import/caddy-certs.ts`,
  `import/traefik-certs.ts` — adopt certs from a foreign proxy on takeover.
- `packages/adapters/src/system/proxy/ensure-container-edge.ts`,
  `docker-edge-executor.ts`, `edge-container-executor.ts`, `installer.ts` — the
  bind mount that keeps certs on the host.
- `apps/api/src/modules/migration/migration.orchestrator.ts` — cross-server cert
  carry.
- `apps/api/src/modules/domains/domain.service.ts`, `apps/api/src/lib/edge-image.ts`,
  `apps/api/src/modules/mail/mail.service.ts` (mail reuses the web cert),
  `apps/cli/src/lib/compose.ts`, `packages/db/src/schema/domain.ts`.

Cheapest path: point `lua-resty-acme` at a **filesystem storage backend using
the same `live/<domain>/{fullchain,privkey}.pem` layout**, so every reader above
keeps working and the change stays inside the provider. Do not adopt the default
shared-dict storage without first abstracting cert reads behind the provider.

Other blockers to resolve in the same change:

- [ ] **Status feedback.** `sslStatus` / `sslExpiresAt` / `sslIssuer` are written
      by the API from the provider's return value (`resolveSslPatch`,
      `domain-ssl.ts:135`). Lazy on-handshake issuance has no API-side moment to
      write those — needs a Lua→API callback, or keep issuance API-triggered and
      use resty-acme only as the ACME client.
- [ ] **Per-hostname issue lock.** `ssl:issue:<host>` (`domain-ssl.ts:19`) exists
      to stop concurrent HTTP-01 orders burning Let's Encrypt budget.
      resty-acme does its own in-process locking; decide which one is
      authoritative rather than keeping both silently.
- [ ] **`installCert` must keep working.** Operator-uploaded / Cloudflare Origin
      CA certs (`manualSsl`) are written to the same path with no ACME involved,
      and `tlsIssuedElsewhere` must keep excluding them.
- [ ] **Delete the certbot-specific workarounds** once nothing shells out:
      `--cert-name` lineage pinning and the `-0001` self-heal
      (`nginx.ts:709`), `summarizeCertbotFailure` + `certbot-summary.test.ts`,
      `ensureIssued`'s "exit 0 but no cert" backstop (`nginx.ts:765`), and the
      adopted-non-lineage branch in `renewCert` (`nginx.ts:800`).
- [ ] **Migration story for boxes already issued by certbot** — existing
      lineages and `/etc/letsencrypt/renewal` configs. With filesystem storage
      this is a no-op; with any other backend it is a data migration.

If the goal is only "get Python out of the image", **`lego`** (single Go binary)
is a much smaller change than resty-acme: same executor, same on-disk layout,
structured exit codes, contained entirely to `nginx.ts`.

### Fold the `certbot` component into the edge (small, do before or after release)

On a container-edge box, `openresty` and `certbot` are one artifact — the image.
The *checks* already know this (`checks.ts:167`, `checks.ts:235` short-circuit via
`resolveOurEdgeContainer`), and so does the installer (`installer.ts:220`). The
**component model does not**:

```
setup.ts:67,75  { feature: "ssl", requires: ["openresty", "certbot"] }
setup.ts:82     ["docker", "git", "openresty", "certbot"]
```

Cost today: two `docker exec` probes to prove one image is present, two rows in
the server components UI for one thing, and `ensureFeature("ssl")` able to
report "SSL requires OpenResty and certbot" while naming a component that is not
independently installable on that box.

- [ ] Key `resolveRules` / `resolveRequired` (`packages/adapters/src/system/setup.ts`)
      off the same `resolveOurEdgeContainer` predicate the checks use, and drop
      `certbot` when a container edge is present. Keep the standalone component
      for the bare / Docker-less branch, which still needs it. Note
      `assumeInstalled` (`setup.ts:109`) already no-ops this when openship itself
      runs containerized, so the residue only affects remote SSH servers with a
      container edge.

---

## Auth

### SSO login for self-hosted (OIDC first, SAML only if asked for)

Not started. Goal: an operator points the instance at their IdP (Okta / Entra /
Keycloak / Authentik / Google Workspace) and staff sign in with that instead of
email + password.

What's already there:

- better-auth `^1.5.4` (`apps/api/package.json:27`), org plugin at
  `apps/api/src/lib/auth.ts:442`. The installed plugin set includes
  **`generic-oauth`** — arbitrary OIDC/OAuth2 issuers, no new dependency. That's
  the cheap path.
- Not `better-auth/plugins/oidc-provider` — that makes Openship *an* IdP, the
  opposite direction. Per-org IdPs and SAML live in the separate
  `@better-auth/sso` package, which is **not** installed; only pull it in if
  per-org IdPs or SAML are genuinely required.
- Providers are already registered only when their creds exist
  (`auth.ts:174`) — an SSO provider should follow the same env-gated shape.

The prerequisite nobody expects:

- [ ] **The button can't just be added.** Social login is hidden on self-hosted
      outright today — `{!selfHosted && <OAuthButtons/>}` at
      `apps/dashboard/src/app/(auth)/login/page.tsx:246` and
      `register/page.tsx:154` — because an operator with no `GITHUB_CLIENT_ID`
      would get buttons that fail, and **nothing tells the dashboard which
      providers are configured**. `OAuthButtons` hardcodes github+google. SSO
      needs a server-advertised provider list (public, read-only, alongside the
      `authMode`/`selfHosted` values `useAuthContext` already serves). That
      endpoint doesn't exist yet and is the real first task.

Decisions to settle before coding:

- [ ] **Account linking.** `accountLinking.trustedProviders` is
      `["github", "google"]` with `allowDifferentEmails: true`
      (`auth.ts:202-205`). An SSO provider left out of that list forks a second
      user row on first login for an email that already exists. Decide whether
      IdP-asserted email is trusted (it usually is — but say so deliberately).
- [ ] **Org + role mapping.** In team mode a fresh SSO user arrives with no
      membership and no role. Invite-only (SSO authenticates, but only into an
      org they were already invited to) is the safe default; auto-join the
      instance org needs an email-domain allowlist and a default role.
- [ ] **Zero-auth interaction.** `authMode === "none"` instances
      (`apps/api/src/lib/auth-mode.ts`) have no login at all. SSO must be inert
      there, not a second door into a box that deliberately has none.
- [ ] **Deprovisioning.** Removing someone from the IdP does not end their
      Openship session or membership. `session.expiresIn` is 30 days
      (`auth.ts:211`) — either shorten it when SSO is on, or document the gap
      honestly. There's no SCIM and shouldn't be one for v1.
- [ ] Gate on explicit env vars validated in `apps/api/src/config/env.ts`, and
      show the resolved state in Settings → security so an operator can tell SSO
      is actually live.

---

## Git providers

### Provider-agnostic git: GitLab, self-managed GitLab/Gitea/Forgejo, dumb remotes

Not started. Today "connect a repo" means GitHub, and `gitProvider` is a column
written `"github"` and then read as an assumption. Goal: make it a real
dimension — GitHub, GitLab (SaaS + self-managed), and a **dumb-remote** tier
(any HTTPS/SSH remote + a credential, no provider API) — with GitHub as one
implementation behind the seam rather than the seam itself.

What's already a seam (reuse, don't rebuild):

- `GitHubSource` + `createGitHubSource(ctx)`
  (`apps/api/src/modules/github/sources/types.ts:78`, `sources/index.ts:24`) —
  one interface, three impls (App / gh-CLI / merged local), already THE place
  source selection happens. Generalize this to `GitSource` with a provider
  dimension and most controllers don't change.
- `github.http.ts` is the single `api.github.com` primitive, so a sibling
  `gitlab.http.ts` is additive rather than surgery.
- `resolveBuildGitToken` (`modules/github/clone-auth.ts:112`) is the one clone
  credential issuer and `tokenFor` (`github.token.ts:117`) the one minter —
  provider dispatch belongs there, once, and stays unit-testable.
- Only three places branch on the column today: `project.controller.ts:955`
  (`"local"`), `clone-plan.ts:43` (`repoIsGithub`), `project-source.ts:21`
  (`"release"`).

What actually hardcodes GitHub — each is a decision, not a rename:

- [ ] **The clone URL is BUILT, not stored**: `https://github.com/${owner}/${repo}.git`
      (`modules/projects/project-crud.service.ts:219`). Any non-GitHub project
      needs its remote persisted (or a per-provider URL builder). Smallest diff,
      widest blast radius — do it first.
- [ ] **Webhooks**: `x-hub-signature-256` HMAC + GitHub's push body
      (`github.webhook.ts:127,150`, `webhook-push.ts`, `webhook-changed-files.ts`,
      `webhook-check-run.ts`). GitLab sends `X-Gitlab-Token` — a plain shared
      secret, not an HMAC — and a different payload. Extend the unified
      `webhook_delivery` table that already absorbed GitHub dedup; don't fork it.
- [ ] **Per-repo permissions** are keyed to GitHub: resource type `"github"`
      (`lib/permission.ts:52`, `lib/route-permission.ts:97,122`) and
      `assertGitHubRepoAccess` (`github-access.ts:143`). Decide between one
      `repo` resource with a provider-qualified id (a grant migration) or a
      second resource type (no migration, two gates to keep in sync forever).
- [ ] **Tarball fast path is GitHub-only** — `githubTarballUrl`
      (`packages/adapters/src/runtime/source-tarball.ts:25`). GitLab and
      Gitea/Forgejo each expose a different archive endpoint. It already falls
      back to `git clone`, so this is per-provider optional, not blocking.
- [ ] **The desktop credential relay pins the host**:
      `req.protocol !== "https" || host !== "github.com"` → reject
      (`lib/git-forwarding/relay.ts:165`). That pin is a security control, not an
      oversight. Widening it means an explicit per-provider allowlist — never a
      wildcard, and never a user-supplied host without validation.
- [ ] **SSH known-hosts are GitHub's keys** (`github-known-hosts.ts`). A
      self-managed remote needs operator-supplied host keys or a deliberate,
      documented TOFU decision.
- [ ] **Server-side git auth assumes an API to push a key to**:
      `server-git-ambient.ts`, `server-github.service.ts`,
      `packages/db/src/repos/github-deploy-key.repo.ts`. A dumb remote has no
      deploy-key endpoint — that tier is credential-only by construction.
- [ ] **Release sources**: `ReleaseSource.mode: "github" | "url"`
      (`packages/core/src/project-source.ts:30`) plus
      `api.github.com/.../releases/latest` (`lib/release-resolver.ts:183`,
      `lib/release-download.ts:163`). `mode: "url"` already covers the generic
      case; GitLab releases would be a third mode.
- [ ] **Dashboard speaks GitHub throughout**: `ServerGitHubConnect`,
      `GithubPermissionModal`, `DeployCredentialModal`, the deploy wizard's
      import step, `ResourcePicker`. Needs a server-advertised provider list —
      the SAME missing primitive as the SSO item above (`OAuthButtons` hardcodes
      github+google). Build that endpoint once and both features use it.
- [ ] **`gh` CLI as an ambient identity** (`sources/gh-cli-source.ts`,
      `github.local-auth.ts:360` parses `oauth_token` under `github.com:` in
      hosts.yml) has no equivalent worth matching. `glab` exists; decide
      deliberately whether to support it or require a PAT for GitLab.

Decisions to settle before coding:

- [ ] **Scope**: GitLab.com only, or self-managed too (custom base URL, possibly
      a private CA)? Self-managed is the harder half and the one operators
      actually ask for.
- [ ] **Is the dumb-remote tier first-class?** "Any remote + PAT" is cheap and
      covers Gitea/Forgejo/Bitbucket on day one, but it silently loses
      auto-deploy, repo listing, and per-repo grants. Ship it only if the UI says
      plainly what it can't do.
- [ ] **Make `gitProvider` a checked union** (`packages/db/src/schema/project.ts:39,115`
      — free text defaulting to `"github"`) BEFORE any second provider writes
      rows. Retrofitting a union over mixed data is the expensive order.
- [ ] **Naming trap**: `apps/api/src/modules/github/` is 26 files and the module
      path is load-bearing in imports across the API. Prefer adding
      `modules/git/` for the provider-agnostic seam and leaving GitHub as one
      implementation behind it, over a rename that touches every call site.

---

## Open TODO markers in code

Verified present; listed so they aren't lost.

- [ ] `apps/api/src/middleware/active-organization.ts:52` — active-org resolution
      has fallbacks; decide whether that's correct or whether it should be strict.
- [ ] `apps/api/src/middleware/better-auth-shield.ts:70` — audit the shield flow
      end-to-end for correctness/security.
- [ ] `apps/api/src/lib/route-permission.ts:510` — per-route `auditOnRead` flag.
- [ ] `apps/api/src/modules/projects/transfer.service.ts:339` — business-logic
      phase of project transfer, deliberately out of scope of the change that
      landed the plumbing.
- [ ] `apps/api/src/modules/system/migration/migrate-instance.service.ts:7,17` —
      trigger the actual deploy once deploy-engine integration lands (see the
      control-plane migration item below).
- [ ] `packages/adapters/src/infra/cloud.ts:22,27,34,39,44` — Oblien route + SSL
      endpoints are stubs (`POST /routes`, `DELETE /routes/:domain`,
      `POST /ssl/provision`, `POST /ssl/renew`, `GET /ssl/status`). Cloud is the
      source of truth for managed certs; until these exist, cloud SSL status is
      not readable.
- [ ] `apps/api/src/modules/deployments/cloud-resources.ts:18` — cpu/memory
      resize intentionally disabled pending the `cloud.ts` `deploy()` TODO.

---

## Known gaps — re-verify before picking up

Carried from project state, not re-verified in this pass. Confirm against the
tree first.

- [ ] **Migrate control plane → server**: phases 0+1 shipped; SSH provisioning,
      sealed transfer, and the modal/SSE surface remain.
- [ ] **Edge loopback-port routing**: allocator + schema landed; activation still
      pending real-box E2E.
- [ ] **Static sandbox build**: build ⟂ serve split landed; real-box E2E pending.
- [ ] **Cloud/self-host isolation audit**: cross-tenant leaks in shared routes +
      ingest (notably the `dump.ts` FK gap, MS Teams SSRF, verify-pending sweep,
      stale notification subscription, GitHub push fan-out).
- [ ] **Mail**: re-running DKIM key setup clobbers SES DNS records.
- [ ] **ARM64**: Linux arm64 AppImage still missing (server install is arch-safe).
- [ ] **Cloud compose**: incremental per-service add is not supported on cloud.
- [ ] **Unified app settings**: schema-driven settings UI for `isApp` projects
      (planned, not started).
- [ ] **Device auth for CLI cloud-connect** requires a SaaS redeploy to go live.
