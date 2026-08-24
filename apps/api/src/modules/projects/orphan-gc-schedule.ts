/**
 * Orphaned-resource garbage collector.
 *
 * When a project is deleted while its server (or cloud) is unreachable, the
 * leaked remote resources are recorded in `orphaned_resource` and the DB row
 * is dropped anyway (enforced delete). This sweep reclaims them: for each
 * orphan it probes reachability, destroys the resource idempotently once the
 * host answers, and deletes the record. Unreachable ones are left for the next
 * tick (attempts is bumped so the condition is observable).
 *
 * `runOrphanSweep` is the action; scheduling is owned by the generic jobs
 * module (registered as the "projects:orphan-gc" system job — see
 * modules/jobs/job.registry.ts).
 */

import { repos, type OrphanedResource } from "@repo/db";
import {
  DockerRuntime,
  edgeProxyFor,
  isRuntimeNotFoundError,
  ownsBuiltImage,
  type Platform,
} from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import { createReachabilityProbe } from "../../lib/server-reachability";
import { isConnectionLoss } from "../../lib/remote-state";
import { disposePlatform, resolveDeploymentPlatform } from "../../lib/deployment-runtime";
import { convergeTargetHostPortClaims } from "../deployments/pinned-host-ports";
import { releaseManagedHostnames } from "../../lib/managed-edge-proxy";

/** Destroy one orphaned resource via the right adapter op; not-found = done. */
async function destroyOrphanResource(platform: Platform, o: OrphanedResource): Promise<void> {
  const runtime = platform.runtime;
  try {
    switch (o.resourceType) {
      case "container":
      case "cloud_workspace":
      case "artifact":
        await runtime.destroy(o.ref);
        return;
      case "image":
        // Old releases may have recorded pulled/adopted images as orphans
        // before manifest collection enforced ownership. Never turn that stale
        // bookkeeping into permission to untag shared registry cache.
        if (runtime instanceof DockerRuntime && ownsBuiltImage(o.ref)) {
          await runtime.removeImage(o.ref);
        }
        return;
      case "volume":
        if (runtime instanceof DockerRuntime) await runtime.removeVolume(o.ref);
        return;
      case "network":
        if (runtime instanceof DockerRuntime) await runtime.removeNetwork(o.ref);
        return;
      case "route":
        await platform.routing.removeRoute(o.ref);
        return;
      default:
        return;
    }
  } catch (err) {
    // Already gone on the host → the orphan is reclaimed; treat as success.
    if (isRuntimeNotFoundError(err)) return;
    throw err;
  }
}

/**
 * Attempt to reclaim one orphan. Returns true if destroyed (or already gone) →
 * caller deletes the row; false if the host is unreachable → caller defers.
 * Throws on a real destroy error → caller bumps the attempt count.
 */
async function reclaimOrphan(
  o: OrphanedResource,
  probe: ReturnType<typeof createReachabilityProbe>,
): Promise<boolean> {
  // Cloud resource: no TCP notion — resolve the cloud runtime for the org.
  // A null server id with docker/bare mode is the local self-hosted target, not
  // cloud; older code conflated the two and silently "reclaimed" local orphans
  // through a cloud adapter that never touched the host.
  if (o.runtimeMode === "cloud" || (!o.serverId && !o.runtimeMode)) {
    let cloudPlatform: Platform | null = null;
    try {
      const { platform } = await resolveDeploymentPlatform(
        { deployTarget: "cloud", workspaceId: o.ref },
        { organizationId: o.organizationId },
      );
      cloudPlatform = platform;
      if (platform.runtime.name !== "cloud") return false;
      await destroyOrphanResource(platform, o);
      if (o.resourceType === "route") {
        const { failures } = await releaseManagedHostnames([o.ref], {
          organizationId: o.organizationId,
        });
        if (failures.length > 0) {
          throw new Error(`Cloud edge route not released: ${failures.join(", ")}`);
        }
      }
      return true;
    } catch (err) {
      // Cloud API unreachable → defer; anything else is a real failure.
      if (isConnectionLoss(err)) return false;
      throw err;
    } finally {
      disposePlatform(cloudPlatform);
    }
  }

  // Server-backed: fast-fail if the remote host still isn't answering. A local
  // orphan has no server row to probe and resolves through this process's host
  // target directly.
  if (o.serverId && !(await probe.isReachable(o.serverId))) return false;

  // A docker-mode server platform binds a Docker-over-SSH bridge, and this runs
  // per orphan on a SCHEDULE — releasing it is what keeps a recurring sweep from
  // accumulating one loopback listener per reclaim, forever.
  const resolved = await resolveDeploymentPlatform(
    {
      deployTarget: o.serverId ? "server" : "local",
      runtimeMode: o.runtimeMode === "bare" ? "bare" : "docker",
      ...(o.serverId ? { serverId: o.serverId } : {}),
    },
    { organizationId: o.organizationId },
  );
  try {
    await destroyOrphanResource(resolved.platform, o);
    if (
      o.resourceType === "route" &&
      o.projectId &&
      resolved.hostPortTarget &&
      resolved.platform.executor
    ) {
      // The route is gone; only a fresh dump from this same physical target may
      // release its detached project claims. A failed dump throws, keeping the
      // orphan row for a later retry and every claim intact.
      const converged = await convergeTargetHostPortClaims({
        target: resolved.hostPortTarget,
        projectId: o.projectId,
        desiredPublishes: [],
        edgeProxy: edgeProxyFor(resolved.platform.executor, "openresty", { ours: true }),
      });
      if (converged.retained.length > 0) {
        const ports = [...new Set(converged.retained.map((claim) => claim.port))].sort(
          (a, b) => a - b,
        );
        throw new Error(
          `the target edge still references this project's host port(s): ${ports.join(", ")}`,
        );
      }
    }
    return true;
  } finally {
    disposePlatform(resolved);
  }
}

export async function runOrphanSweep(): Promise<{ reclaimed: number; deferred: number }> {
  const orphans = await repos.orphanedResource.listAll();
  if (orphans.length === 0) return { reclaimed: 0, deferred: 0 };

  const probe = createReachabilityProbe();
  let reclaimed = 0;
  let deferred = 0;
  const targetGroupKey = (orphan: OrphanedResource): string | null =>
    orphan.projectId
      ? [
          orphan.organizationId,
          orphan.projectId,
          orphan.serverId
            ? `server:${orphan.serverId}`
            : orphan.runtimeMode === "cloud" || !orphan.runtimeMode
              ? "cloud"
              : "local",
        ].join("\0")
      : null;
  // A route disappearance proves only that the edge stopped dialling a port; it
  // cannot prove a failed/stopped workload surrendered the bind. Hold route
  // cleanup—and therefore claim convergence—until every non-route orphan for the
  // same project/target has been reclaimed. Counts are decremented only after the
  // orphan row itself is deleted successfully.
  const pendingResourcesByTarget = new Map<string, number>();
  for (const orphan of orphans) {
    const key = targetGroupKey(orphan);
    if (!key || orphan.resourceType === "route") continue;
    pendingResourcesByTarget.set(key, (pendingResourcesByTarget.get(key) ?? 0) + 1);
  }

  for (const o of orphans) {
    try {
      // Orphan rows are written just before the originating project is hard
      // deleted. If a later unlink/delete step failed—or this sweep races that
      // narrow window—the project still exists and remains authoritative. Never
      // let GC tear down its workload/routes or release its claims.
      if (o.projectId && (await repos.project.findById(o.projectId))) {
        await repos.orphanedResource.bumpAttempt(o.id);
        deferred++;
        continue;
      }
      const groupKey = targetGroupKey(o);
      if (
        o.resourceType === "route" &&
        groupKey &&
        (pendingResourcesByTarget.get(groupKey) ?? 0) > 0
      ) {
        await repos.orphanedResource.bumpAttempt(o.id);
        deferred++;
        continue;
      }
      if (await reclaimOrphan(o, probe)) {
        await repos.orphanedResource.delete(o.id);
        if (groupKey && o.resourceType !== "route") {
          pendingResourcesByTarget.set(
            groupKey,
            Math.max(0, (pendingResourcesByTarget.get(groupKey) ?? 1) - 1),
          );
        }
        reclaimed++;
      } else {
        await repos.orphanedResource.bumpAttempt(o.id);
        deferred++;
      }
    } catch (err) {
      await repos.orphanedResource.bumpAttempt(o.id).catch(() => {});
      deferred++;
      console.error(`[orphan-gc] ${o.resourceType} ${o.ref} failed:`, safeErrorMessage(err));
    }
  }

  return { reclaimed, deferred };
}
