/**
 * The `deployment.container_id` / `image_ref` sentinel, and the one predicate for
 * "is this a reference I can hand to a runtime".
 *
 * A leaf module on purpose: the sentinel is read on the write path (compose
 * deploy, reconcile), the read path (logs, container info, routing upstreams) and
 * in rollback planning, and every open-coded `=== "compose"` was a place that
 * could forget.
 */

/** Stored in `deployment.container_id` / `image_ref` when a release has no single
 *  primary container/image. A marker, never a real Docker reference — treating it
 *  as one is what made compose rollback try `createContainer({ Image: "compose" })`
 *  and made a project pause report success having stopped nothing. */
export const COMPOSE_SENTINEL = "compose";

/** True when a stored reference names something a runtime can actually act on. */
export function isRealContainerRef(ref: string | null | undefined): ref is string {
  return !!ref && ref !== COMPOSE_SENTINEL;
}
