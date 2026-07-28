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
