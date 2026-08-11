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

/** The reference, trimmed, when it names something a runtime can actually act on
 *  — else null. Trims because these come from stored columns and a whitespace-only
 *  value is as unusable as an empty one. */
export function usableRef(ref: string | null | undefined): string | null {
  const trimmed = ref?.trim();
  if (!trimmed || trimmed === COMPOSE_SENTINEL) return null;
  return trimmed;
}

/** `usableRef` as a type guard, for the call sites that only need the question
 *  answered and already hold a clean value. */
export function isRealContainerRef(ref: string | null | undefined): ref is string {
  return usableRef(ref) !== null;
}
