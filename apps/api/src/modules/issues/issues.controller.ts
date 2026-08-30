/**
 * Issues HTTP handlers — the org-wide "what is broken" surface.
 *
 * Three handlers, all thin: the aggregator owns every decision (which sources the
 * caller may see, how severity ranks, what the fix is), so these only parse a query
 * param and shape the envelope. Rescan is the one that acts, and it acts by firing
 * jobs that already exist rather than probing anything itself.
 */

import type { Context } from "hono";
import { getRequestContext } from "../../lib/request-context";
import { SYSTEM_JOB_BY_KEY } from "../jobs/job.registry";
import { runJobNow } from "../jobs/job.service";
import { listOrganizationIssues } from "./issues.service";
import { listWorkloadHealthSnapshots } from "../monitoring/health-watch";
import { repos } from "@repo/db";
import { env } from "../../config/env";

/** GET /api/issues?status=open|resolved — every issue in the caller's org. */
export async function listIssues(c: Context) {
  const ctx = getRequestContext(c);
  const status = c.req.query("status") === "resolved" ? "resolved" : "open";
  const { issues, counts } = await listOrganizationIssues(ctx, { status });
  return c.json({ data: issues, counts, status });
}

/**
 * GET /api/issues/summary — counts without rows.
 *
 * For callers that only need the tally: MCP clients answering "is anything broken",
 * and any future badge. The dashboard reads its counts off the feed it already
 * fetched, so nothing in the UI calls this today.
 *
 * Re-runs the same aggregator instead of counting a cheaper way: a number that
 * disagrees with the page it summarizes is worse than a slightly more expensive read,
 * and every source here is a cached DB read.
 */
export async function issuesSummary(c: Context) {
  const ctx = getRequestContext(c);
  const { counts } = await listOrganizationIssues(ctx);
  return c.json({ data: counts });
}

/** Latest per-workload state from the existing grouped health watcher. Reading
 * this endpoint performs no Docker I/O, so a large dashboard cannot multiply the
 * monitoring load. */
export async function healthSnapshot(c: Context) {
  const ctx = getRequestContext(c);
  const [rows, job, servers] = await Promise.all([
    Promise.resolve(listWorkloadHealthSnapshots(ctx.organizationId)),
    repos.job.findByKey("services:health-watch"),
    repos.server.listByOrganization(ctx.organizationId),
  ]);
  const serverNames = new Map(servers.map((server) => [server.id, server.name ?? server.sshHost]));
  return c.json({
    data: rows.map((row) => ({
      ...row,
      serverName: row.serverId ? (serverNames.get(row.serverId) ?? row.serverId) : "This server",
    })),
    watching: job?.enabled ?? false,
    watcher: {
      key: "services:health-watch",
      schedule: job?.cronExpression ?? null,
      eventsEnabled: !env.OPENSHIP_DISABLE_CONTAINER_EVENTS,
    },
  });
}

/**
 * The checkers whose caches back this feed. Deliberately the SCHEDULED jobs, not
 * the underlying services — "re-scan" means "run the sweep early", so the run shows
 * up in the jobs history with a `manual` trigger like any other run-now.
 *
 * Ordered cheapest-first only for tidiness; they run concurrently.
 */
const RESCAN_JOBS = [
  "services:health-watch",
  "infra:scan",
  "domains:verify-pending",
  "updates:scan",
] as const;

type RescanKey = (typeof RESCAN_JOBS)[number];
type RescanStage = {
  key: RescanKey;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  summary?: Record<string, unknown>;
  error?: string;
};
type RescanSession = {
  id: string;
  status: "running" | "completed";
  startedAt: string;
  finishedAt?: string;
  stages: RescanStage[];
};

/** One instance-wide checker batch. The underlying jobs are instance-wide too;
 * sharing the session prevents two browser tabs from doubling the Docker/Git/DNS
 * load. Kept after completion so a refresh can still show how the scan ended. */
let activeRescan: RescanSession | null = null;

export function rescanStatus(c: Context) {
  return c.json({ data: activeRescan });
}

/**
 * POST /api/issues/rescan — refresh every source behind the feed.
 *
 * A job whose platform gate is false was never seeded (see `reconcileJobs`), so it
 * is reported as `skipped` rather than failing the request: on desktop there is no
 * health watch to run, and asking for a fleet re-scan there shouldn't 404.
 *
 * Reports per-job outcomes instead of a bare ok — a scan that silently didn't run
 * is indistinguishable from "nothing is wrong", which is the failure mode this
 * whole surface exists to prevent.
 */
export async function rescanIssues(c: Context) {
  // Cloud is refused by the route's `localOnly` — the same gate the jobs module
  // puts on its own run-now, rather than a second cloud check here.
  if (activeRescan?.status === "running") return c.json({ data: activeRescan }, 202);

  const available = RESCAN_JOBS.filter((key) => {
    const def = SYSTEM_JOB_BY_KEY.get(key);
    return !def?.available || def.available();
  });
  const skipped = RESCAN_JOBS.filter((key) => !available.includes(key));

  activeRescan = {
    id: crypto.randomUUID(),
    status: "running",
    startedAt: new Date().toISOString(),
    stages: RESCAN_JOBS.map((key) => ({
      key,
      status: skipped.includes(key) ? "skipped" : "pending",
    })),
  };
  const session = activeRescan;

  // Detached, but every child is still the normal recorded manual job run. The
  // endpoint answers immediately and GET /rescan/status reconnects to this batch.
  void Promise.all(
    available.map(async (key) => {
      const stage = session.stages.find((item) => item.key === key)!;
      stage.status = "running";
      try {
        const result = await runJobNow(key);
        stage.status = "completed";
        stage.summary = (result.summary ?? {}) as Record<string, unknown>;
      } catch (err) {
        stage.status = "failed";
        stage.error = (err as Error)?.message ?? "failed";
      }
    }),
  ).finally(() => {
    session.status = "completed";
    session.finishedAt = new Date().toISOString();
  });

  c.set("auditAfter", { scanSessionId: session.id, stages: available, skipped });
  return c.json({ data: session }, 202);
}
