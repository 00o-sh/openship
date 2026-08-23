import { repos, type PinnedHostPort } from "@repo/db";

export type { PinnedHostPort };

export interface ReusablePinnedHostPort {
  projectId: string;
  serviceId: string | null;
  port: number;
}

/**
 * Durable port claims for the exact host this deploy targets.
 *
 * Deliberately does not catch database failures: continuing with an incomplete
 * set can steal a stopped container's port, which is worse than failing this
 * deploy before it mutates the host. Live socket scanning remains the second,
 * complementary half of allocation.
 */
export function listTargetPinnedHostPorts(
  organizationId: string,
  serverId: string | null,
): Promise<PinnedHostPort[]> {
  return repos.project.listActivePinnedHostPorts(organizationId, serverId);
}

/**
 * Convert owned claims into an allocator avoid-set, optionally releasing the
 * caller's own carried claim. A number is released only when no other owner
 * claims it, so corrupt/legacy duplicate rows fail safe instead of letting one
 * service erase a sibling's reservation.
 */
export function pinnedHostPortsToAvoid(
  claims: readonly PinnedHostPort[],
  reusable?: ReusablePinnedHostPort,
): Set<number> {
  const avoid = new Set(claims.map((claim) => claim.port));
  if (!reusable) return avoid;

  const ownsClaim = claims.some(
    (claim) =>
      claim.projectId === reusable.projectId &&
      claim.serviceId === reusable.serviceId &&
      claim.port === reusable.port,
  );
  const anotherOwnerClaimsIt = claims.some(
    (claim) =>
      claim.port === reusable.port &&
      (claim.projectId !== reusable.projectId || claim.serviceId !== reusable.serviceId),
  );
  if (ownsClaim && !anotherOwnerClaimsIt) avoid.delete(reusable.port);
  return avoid;
}
