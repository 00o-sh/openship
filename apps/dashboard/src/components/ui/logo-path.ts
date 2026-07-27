/**
 * The Openship brand mark, as raw path data.
 *
 * Extracted so the `Logo` component and the illustrations that embed the mark
 * (home empty state, splash) share ONE copy — a second transcription of an
 * 855-character path is a copy that silently drifts.
 *
 * The path is authored in a 4990x3590 space, flipped: it MUST be wrapped in
 * `LOGO_PATH_TRANSFORM` (or an equivalent) to land in a 499x359 viewBox.
 * `logoTransform(x, y, width)` does that plus placement, for embedding at any
 * size inside a larger illustration.
 */

export const OPENSHIP_LOGO_PATH =
  "M2817 2923 c-4 -3 -7 -241 -7 -527 l0 -521 131 -103 c72 -57 132   -102 133 -100 2 2 19 38 39 81 141 302 522 398 785 199 252 -191 280 -549 60   -778 -156 -163 -395 -207 -594 -109 -99 48 -115 61 -779 605 -605 495 -738   594 -866 648 -281 116 -602 64 -841 -137 -301 -254 -387 -673 -211 -1026 46   -92 87 -146 170 -226 82 -78 143 -121 228 -160 255 -115 548 -100 786 41 129   76 280 241 328 358 15 36 29 20 -144 160 -55 45 -102 78 -106 74 -3 -4 -13   -28 -23 -54 -60 -163 -205 -286 -381 -323 -88 -18 -122 -18 -210 0 -245 52   -415 261 -415 510 0 200 113 383 290 468 173 83 343 71 516 -36 56 -35 847   -673 1314 -1060 105 -87 249 -164 360 -191 217 -54 452 -17 657 106 66 39 196   163 241 229 50 75 99 180 124 265 30 104 32 323 4 424 -84 303 -303 526 -602   612 -65 19 -103 22 -219 22 -163 0 -243 -18 -375 -84 l-80 -40 0 340 0 340   -153 0 c-85 0 -157 -3 -160 -7z";

/** Native size of the mark once LOGO_PATH_TRANSFORM is applied. */
export const LOGO_VIEWBOX = { width: 499, height: 359 } as const;

/** Normalizes the authored path into the 499x359 viewBox. */
export const LOGO_PATH_TRANSFORM = "translate(0,359) scale(0.1,-0.1)";

/**
 * Transform that draws the mark at `width` units wide with its TOP-LEFT at
 * (x, y), in whatever user space the caller's <svg> uses.
 * Height follows the aspect ratio: width * 359/499.
 */
export function logoTransform(x: number, y: number, width: number): string {
  const scale = width / LOGO_VIEWBOX.width;
  return `translate(${x},${y}) scale(${scale}) ${LOGO_PATH_TRANSFORM}`;
}

/** Height the mark occupies when drawn at `width`. */
export function logoHeight(width: number): number {
  return (width * LOGO_VIEWBOX.height) / LOGO_VIEWBOX.width;
}
