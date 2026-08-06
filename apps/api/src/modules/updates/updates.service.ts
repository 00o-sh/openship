/**
 * ONE channel for "is anything out of date?" across every updatable entity —
 * and every entity is a project row (git projects, release/dist projects, the
 * self-app, webmail, installed template apps).
 *
 * What is cached, and what is not:
 *
 *   `update_status` caches the UPSTREAM half of drift only — the branch HEAD, the
 *   newest release tag, the registry digest per service. That half costs a
 *   network round-trip per project and no local event announces when it moves, so
 *   it can only be polled (`updates:scan`, every 6h) and is worth caching.
 *
 *   The DEPLOYED half — what's actually running — is read live on every request.
 *   It's a local row lookup, and it is written by seven different code paths
 *   (deploy success, rollback, reconcile, activate, clear, self-deploy, migrate).
 *   Caching it meant every one of those needed an invalidation hook, and a missed
 *   hook left an operator staring at "update available" for a commit they had
 *   already shipped. Deriving it removes the hook requirement entirely.
 *
 * So `behind`, `latestInProgress` and both display labels are COMPUTED on read
 * (`evaluateDrift`), never stored. And the upstream side is cached under the
 * source identity it was polled for (branch key / release-source key / image
 * ref), so repointing a project is a cache MISS rather than a stale hit — there
 * is no invalidation call to remember anywhere in the codebase.
 */

import { ValidationError } from "@repo/core";
import { repos, type NewUpdateStatus, type Project, type UpdateStatus } from "@repo/db";
import { buildBackgroundContext, type RequestContext } from "../../lib/request-context";
import { resolveOrgOwner } from "../../lib/org-actor";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import {
  evaluateDrift,
  resolveUpstreamDrift,
  type DriftStatus,
  type UpstreamDrift,
} from "../projects/project-crud.service";
import { redeployBuildSession } from "../deployments/build.service";

// ─── Display labels ──────────────────────────────────────────────────────────

/** Tags that carry no version identity — fall back to the content digest for these. */
const FLOATING_TAGS = new Set(["latest", "stable", "main", "master", "edge", "nightly"]);

/** Tag portion of an image ref (`repo:tag` / `repo:tag@sha256:…`), or null if untagged. */
function imageTag(ref: string): string | null {
  const noDigest = ref.split("@")[0];
  const lastColon = noDigest.lastIndexOf(":");
  return lastColon > noDigest.lastIndexOf("/") ? noDigest.slice(lastColon + 1) : null;
}

/** Short form of a `sha256:…` (or bare hex) content digest. */
function shortDigest(digest?: string | null): string | null {
  if (!digest) return null;
  const hex = digest.includes(":") ? digest.slice(digest.indexOf(":") + 1) : digest;
  return hex.slice(0, 12) || null;
}

/**
 * Human-readable version for one image service: a pinned/specific tag reads as the
 * version; a floating tag (latest/stable/…) has none, so fall back to the short
 * content digest of the resolved image.
 */
function serviceVersion(ref: string, digest?: string | null): string | null {
  const tag = imageTag(ref);
  if (tag && !FLOATING_TAGS.has(tag)) return tag.length > 12 ? tag.slice(0, 12) : tag;
  return shortDigest(digest);
}

/** App-level version label across an image app's services (deduped; joined when they differ). */
function imageLabel(
  services: ReadonlyArray<{
    ref: string;
    deployedDigest?: string | null;
    latestDigest?: string | null;
  }>,
  side: "deployed" | "latest",
): string | null {
  const parts = [
    ...new Set(
      services
        .map((s) => serviceVersion(s.ref, side === "deployed" ? s.deployedDigest : s.latestDigest))
        .filter((v): v is string => !!v),
    ),
  ];
  return parts.length ? parts.join(", ") : null;
}

/**
 * The UI's "current → latest" strings, plus the mode-specific payload it renders.
 * Derived from the evaluated status so a label can never disagree with the
 * verdict shown beside it.
 */
function presentation(status: DriftStatus) {
  if (!status.supported) return null;
  if (status.mode === "commit") {
    return {
      currentLabel: status.deployedSha ? status.deployedSha.slice(0, 7) : null,
      latestLabel: status.latestSha ? status.latestSha.slice(0, 7) : null,
      detail: { branch: status.branch, latestMessage: status.latestMessage ?? null },
    };
  }
  if (status.mode === "release") {
    return {
      currentLabel: status.currentVersion ?? null,
      latestLabel: status.latestVersion ?? null,
      detail: { pinned: status.pinned },
    };
  }
  return {
    currentLabel: imageLabel(status.services, "deployed"),
    latestLabel: imageLabel(status.services, "latest"),
    detail: { services: status.services },
  };
}

// ─── Cache serialization ─────────────────────────────────────────────────────

/**
 * Upstream state → the cache row. Returns null for unsupported entities
 * (local/upload/no-remote projects) so they're skipped and any existing row is
 * dropped. The `key` fields ride along: they are what makes the row answerable
 * later, or knowably unanswerable.
 */
function toUpsert(project: Project, upstream: UpstreamDrift): Omit<NewUpdateStatus, "id"> | null {
  if (!upstream.supported) return null;
  const base = {
    organizationId: project.organizationId,
    projectId: project.id,
    checkedAt: new Date(),
  };
  if (upstream.mode === "commit") {
    return {
      ...base,
      kind: "commit",
      detail: {
        key: upstream.key,
        // Full sha, not the 7-char display prefix: this is compared against the
        // deployed sha on every read, and a truncated value can't be.
        latestSha: upstream.latestSha,
        latestMessage: upstream.latestMessage,
      },
    };
  }
  if (upstream.mode === "release") {
    return {
      ...base,
      kind: "release",
      detail: {
        key: upstream.key,
        latestVersion: upstream.latestVersion,
        pinned: upstream.pinned,
      },
    };
  }
  return { ...base, kind: "image", detail: { digestByRef: upstream.digestByRef } };
}

/**
 * The cache row → upstream state, for comparison against live deployed state.
 * Defensive about shapes: a row written by an older build (or hand-edited) reads
 * back as "upstream unknown", which reports no update rather than a wrong one.
 */
function fromCache(row: UpdateStatus): UpstreamDrift {
  const d = (row.detail ?? {}) as Record<string, unknown>;
  const key = typeof d.key === "string" ? d.key : "";
  if (row.kind === "commit") {
    return {
      supported: true,
      mode: "commit",
      key,
      latestSha: typeof d.latestSha === "string" ? d.latestSha : null,
      latestMessage: typeof d.latestMessage === "string" ? d.latestMessage : null,
    };
  }
  if (row.kind === "release") {
    return {
      supported: true,
      mode: "release",
      key,
      latestVersion: typeof d.latestVersion === "string" ? d.latestVersion : null,
      pinned: d.pinned === true,
    };
  }
  const digestByRef =
    d.digestByRef && typeof d.digestByRef === "object"
      ? (d.digestByRef as Record<string, string | null>)
      : {};
  return { supported: true, mode: "image", digestByRef };
}

// ─── Scanning (cache writes) ─────────────────────────────────────────────────

export interface ScanSummary {
  scanned: number;
  supported: number;
}

/**
 * GitHub-backed upstream needs a credential, and background sweeps have no human
 * session — so resolve the org OWNER as the actor, exactly like the webhook
 * handlers do for auto-deploy. Before this, a ctx-less scan skipped the branch
 * HEAD lookup entirely, so the scheduled job could never detect a new commit:
 * git drift was only ever noticed when a logged-in user happened to open a page.
 *
 * Cached per org for the sweep's lifetime — one member lookup per org, not per
 * project. No owner → null, and the commit branch degrades to "upstream unknown"
 * (reported as not-behind rather than guessed).
 */
async function backgroundCtxFor(
  organizationId: string,
  cache: Map<string, RequestContext | null>,
): Promise<RequestContext | null> {
  const hit = cache.get(organizationId);
  if (hit !== undefined) return hit;
  const owner = await resolveOrgOwner(organizationId).catch(() => null);
  const ctx = owner
    ? buildBackgroundContext({ userId: owner.userId, organizationId, label: "updates:scan" })
    : null;
  cache.set(organizationId, ctx);
  return ctx;
}

/**
 * Refresh the cached upstream for a set of projects. Best-effort per project —
 * one failure never aborts the sweep.
 */
async function scanProjects(
  ctx: RequestContext | null,
  rows: Project[],
): Promise<ScanSummary> {
  let supported = 0;
  const ctxByOrg = new Map<string, RequestContext | null>();

  for (const project of rows) {
    try {
      const actor = ctx ?? (await backgroundCtxFor(project.organizationId, ctxByOrg));
      const upstream = await resolveUpstreamDrift(actor, project);
      const upsert = toUpsert(project, upstream);
      if (!upsert) {
        // Unsupported now (e.g. source changed) — drop any cached row.
        await repos.updateStatus.deleteByProject(project.id).catch(() => {});
        continue;
      }
      supported += 1;
      await repos.updateStatus.upsert(upsert);
    } catch {
      /* best-effort: skip this project, keep scanning */
    }
  }

  return { scanned: rows.length, supported };
}

/** Scan every project in one org (the dashboard's explicit "check for updates"). */
export async function scanOrganizationUpdates(
  ctx: RequestContext | null,
  organizationId: string,
): Promise<ScanSummary> {
  // Large perPage → effectively "all projects" for a single org.
  const { rows } = await repos.project.listByOrganization(organizationId, { perPage: 1000 });
  return scanProjects(ctx, rows);
}

/**
 * Instance-wide sweep for the scheduled `updates:scan` job — every project across
 * all orgs, each org acting as its own owner (see `backgroundCtxFor`).
 */
export async function scanInstanceUpdates(): Promise<ScanSummary> {
  const rows = await repos.project.listAllForScan();
  return scanProjects(null, rows);
}

// No invalidation entry point, deliberately. Deployments can't stale this cache
// (the deployed side is read live) and repointing a project can't either (the
// upstream side is keyed by source identity, so it misses). The scan is the only
// writer, and a miss always reads as "no update available".

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * Cached upstream + live deployed state, per project in an org. The `behind`
 * verdict here is computed from the project's CURRENT deployment on every call,
 * so it agrees with the project page and with the deployment list by
 * construction — the cache only supplies the upstream side.
 */
export async function listOrganizationUpdates(
  organizationId: string,
  opts?: { behindOnly?: boolean },
) {
  const rows = await repos.updateStatus.listByOrg(organizationId);
  const { rows: projects } = await repos.project.listByOrganization(organizationId, {
    perPage: 1000,
  });
  const byId = new Map(projects.map((p) => [p.id, p]));

  const items = await Promise.all(
    rows.map(async (r) => {
      const p = byId.get(r.projectId);
      if (!p) return null;
      const status = await evaluateDrift(p, fromCache(r)).catch(() => ({ supported: false }) as DriftStatus);
      const view = presentation(status);
      if (!view || !status.supported) return null;
      return {
        projectId: r.projectId,
        name: p.name,
        slug: p.slug ?? null,
        isApp: p.isApp ?? false,
        appTemplateId: p.appTemplateId ?? null,
        kind: r.kind,
        behind: status.behind,
        latestInProgress: status.latestInProgress,
        currentLabel: view.currentLabel,
        latestLabel: view.latestLabel,
        detail: view.detail,
        /** When the UPSTREAM side was last polled (the deployed side is live). */
        checkedAt: r.checkedAt,
      };
    }),
  );

  const present = items.filter((i): i is NonNullable<typeof i> => i !== null);
  return opts?.behindOnly ? present.filter((i) => i.behind) : present;
}

// ─── Applying ────────────────────────────────────────────────────────────────

/**
 * Apply the available update to a project (app / git / release / self-app). Runs
 * a redeploy with the `update` trigger — which force-pulls image tags and
 * recreates every image service, and (for release/git projects) rolls forward
 * to the latest version/commit — after firing a pre-deploy backup. The existing
 * rollback-orchestrator auto-archive gives one-click revert. Returns the new
 * deployment id so the UI can follow build progress.
 *
 * Deliberately does not touch `update_status`: the upstream hasn't moved, and the
 * nudge stops the moment the deployment row exists, because `latestInProgress` is
 * computed live. (The previous rescan here re-armed the banner it had just
 * cleared — `redeployBuildSession` returns while the build is still queued, so a
 * rescan at this instant recomputed drift against the version being replaced.)
 */
export async function applyProjectUpdate(ctx: RequestContext, projectId: string) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  if (!project.activeDeploymentId) {
    throw new ValidationError("Deploy this project before updating it.");
  }
  return redeployBuildSession(ctx, project.activeDeploymentId, {
    trigger: "update",
    preDeployBackup: true,
  });
}
