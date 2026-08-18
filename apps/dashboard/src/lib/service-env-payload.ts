/**
 * Build the `environment` value for a service PATCH (#619).
 *
 * The endpoint MERGES this map onto the stored one, so a key the payload doesn't
 * mention is KEPT. An editor that submits only its current rows therefore cannot
 * express a deletion — the removed key simply survives. Every key that was there
 * when the panel loaded and is gone from the rows now has to be named explicitly
 * as `null`.
 *
 * `originalEnv` is the map the panel loaded. Its VALUES arrive masked (`••••••••`,
 * see the api's secret-env.ts) but its KEYS are complete, which is all this needs
 * — `maskEnv` iterates `Object.keys` and drops nothing.
 */
export type ServiceEnvRow = { key: string; value: string };

export function serviceEnvPatch(
  rows: ServiceEnvRow[],
  originalEnv?: Record<string, string> | null,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const row of rows) {
    // Blanking a row's key is how the editor spells "drop this variable", so an
    // empty key contributes nothing and the original it replaced falls through
    // to the deletion pass below.
    const key = row.key.trim();
    if (key) out[key] = row.value;
  }
  for (const key of Object.keys(originalEnv ?? {})) {
    if (!(key in out)) out[key] = null;
  }
  return out;
}
