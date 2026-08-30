import type { DockerContainerSummary } from "@repo/adapters";

export interface ForeignComposeCollision {
  serviceName: string;
  containerName: string;
}

/**
 * Detect a pre-existing Docker Compose stack which merely shares this project's
 * slug. A normal deployment does not own those containers and must not silently
 * create a parallel Openship-managed stack beside them.
 */
export function findForeignComposeCollisions(input: {
  slug: string;
  serviceNames: Iterable<string>;
  containers: readonly DockerContainerSummary[];
  trackedContainerIds?: Iterable<string>;
}): ForeignComposeCollision[] {
  const services = new Set(input.serviceNames);
  const tracked = new Set(input.trackedContainerIds ?? []);
  return input.containers
    .filter(
      (container) =>
        !tracked.has(container.id) &&
        container.composeProject === input.slug &&
        !!container.composeService &&
        services.has(container.composeService),
    )
    .map((container) => ({
      serviceName: container.composeService!,
      containerName: container.names[0] ?? container.id.slice(0, 12),
    }));
}
