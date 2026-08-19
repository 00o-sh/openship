/**
 * The env layering a compose/catalog service is deployed with.
 *
 * Its own module because THREE surfaces have to agree on it — the deploy merge,
 * the rollback confirm diff (`deployments/deployment.service.ts`), and anything
 * else reporting "what will this container get". Two of them used to spell the
 * rule out by hand, which is how the confirm dialog came to claim a precedence
 * the deploy no longer used. One rule, imported.
 */

/** The four env layers a compose service is deployed with, before token resolution. */
export interface ServiceEnvLayers {
  /**
   * Project-scoped rows, live.
   *
   * NOTE the deploy caller builds this with an UNSCOPED `getEnvMap(projectId,
   * environment)`, so today it is really project rows ∪ every other service's
   * service-scoped rows. That is a pre-existing defect in the caller, not in this
   * layering, but it is why {@link mergeServiceDeployEnv} describes what it
   * compares against as "already layered" rather than "the project's".
   */
  project: Record<string, string>;
  /** This deployment's frozen capture (`dep.envVars`, decrypted). Flat, unscoped. */
  frozen: Record<string, string>;
  /** The compose file's inline `environment:` for this service. */
  inline: Record<string, string>;
  /** Service-scoped rows for this service, live. */
  service: Record<string, string>;
}

export interface MergedServiceEnv {
  /** The env the container is created with, before `{{publicUrl:…}}` resolution. */
  env: Record<string, string>;
  /**
   * Inline keys whose EMPTY value was not applied because a lower layer already
   * held a real one — see {@link inlineEmptyDefers}. NAMES ONLY, never values:
   * this is written to the deploy log, and env is output-masked everywhere else.
   *
   * Reported rather than swallowed for the same reason `resolveEnvPublicUrls`
   * reports what it omitted: silently rewriting a variable leaves no surface that
   * predicts the container. Both the service Env tab and the deploy wizard go on
   * displaying the empty value this merge decided to ignore.
   */
  deferredEmpty: string[];
}

/**
 * Whether an inline compose empty value yields to a value an earlier layer
 * already supplied.
 *
 * The rule, in one sentence an operator can predict: **an empty inline value
 * never clears a configured one.** It exists because compose's passthrough idiom
 * (`FOO: ${FOO:-}` / `FOO: ${FOO}`) parses to `""` whenever nothing resolved the
 * placeholder, and that `""` is persisted onto the service row with its
 * provenance stripped — the row has no `environmentMeta`, so by deploy time
 * "the author wrote an empty literal" and "nothing filled this placeholder in"
 * are the same three characters. Before this rule the placeholder won, so the
 * project-level value the operator had just typed was replaced with `""` —
 * which is worse than unset, since `FOO=` also masks the image's own `ENV`
 * default (issue #614).
 *
 * The cost, accepted deliberately: an inline empty that WAS authored on purpose
 * no longer clears a project-level value for that one service. `advanced` JSONB
 * could carry the parser's `environmentMeta.source` onto the row and let this
 * decide on recorded intent instead of value shape (the `entrypoint`/#575
 * precedent) — that is the endgame, and it is what would also fix the sibling
 * case this cannot: a PARTIALLY interpolated value, where `postgres://${USER}:
 * ${PASS}@db/${DB}` resolves to the non-empty garbage `postgres://:@db/` and
 * still wins. Until then the escape hatch for a deliberate blank is an empty
 * SERVICE-SCOPED env row, which is layered after this and never skipped.
 */
export function inlineEmptyDefers(
  inlineValue: string,
  alreadyLayered: string | undefined,
): boolean {
  // `!== undefined` is load-bearing: a passthrough key that appears in NO other
  // layer must still be set (to ""), not dropped. Omitting it would delete the
  // variable from the container instead of leaving it blank, which is a
  // different container than either reading of the compose file asked for.
  return inlineValue === "" && alreadyLayered !== undefined && alreadyLayered !== "";
}

/**
 * Layer a service's env. Service rows beat inline compose env beats project rows
 * — so the compose UI can override a global per service — with the ONE exception
 * that an empty inline value defers instead of clearing ({@link
 * inlineEmptyDefers}).
 *
 * `frozenWins` moves the frozen layer LAST, which is what makes a rollback replay
 * the release it restores instead of running old code against today's config —
 * the one combination nobody ever ran. It is layered last rather than used alone
 * because `dep.envVars` is flat and unscoped: it cannot express "this key was
 * never set here", so dropping the live layers would delete keys the snapshot
 * never captured. Last-wins shadows exactly the keys the release had.
 *
 * It shadows inline and service-scoped values too, which for a key that was
 * project-scoped at capture and is service-scoped now means one value lands on
 * every service. That case is unresolvable from a flat map, so it is surfaced per
 * key as `scopeAmbiguous` in the rollback confirm diff rather than hidden.
 *
 * Note the frozen layer is layered BEFORE inline on a normal deploy, so an empty
 * inline value defers to a frozen value as well as a project one. That is the
 * intent — the frozen capture is a snapshot of the operator's env, not of this
 * service's inline map — and it is why the deferral compares against the
 * accumulated result rather than against `layers.project`.
 */
export function mergeServiceDeployEnv(
  layers: ServiceEnvLayers,
  frozenWins: boolean,
): MergedServiceEnv {
  const env: Record<string, string> = { ...layers.project };
  const deferredEmpty: string[] = [];

  if (!frozenWins) Object.assign(env, layers.frozen);

  for (const [key, value] of Object.entries(layers.inline)) {
    if (inlineEmptyDefers(value, env[key])) {
      deferredEmpty.push(key);
      continue;
    }
    env[key] = value;
  }

  // Explicit service-scoped rows win outright — including an empty one, which is
  // the supported way to force a variable blank on one service.
  Object.assign(env, layers.service);

  if (frozenWins) Object.assign(env, layers.frozen);

  // A key that a later layer supplied anyway was never really "deferred" —
  // reporting it would name a variable whose value this decision didn't pick.
  const decidedLater = (key: string) =>
    key in layers.service || (frozenWins && key in layers.frozen);
  return { env, deferredEmpty: deferredEmpty.filter((key) => !decidedLater(key)) };
}
