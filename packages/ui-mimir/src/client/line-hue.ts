/**
 * Stable research-line identity hue: the same line id always maps to the
 * same palette index — never the order it happened to be laid out in, so a
 * new or re-parented line no longer recolors the whole map. The Evidence
 * Graph (bands) and the Worktree flow (lanes) share this function, so one
 * research line keeps one hue across both views.
 *
 * The worktree uses raw idea ids, the fold prefixes them (`idea:<id>`);
 * `idea:` is normalized away so both spell the same hue, while `project:<id>`
 * passes through untouched (a distinct line space on both sides).
 * @module dsh-client-ui-mimir/client/line-hue
 */

/** The shared research-line palette size (both maps cycle the same six). */
export const LINE_HUES = 6

/** djb2 over the normalized id → a stable 0..(mod−1) hue index. */
export function lineHueOf(lineId: string, mod: number = LINE_HUES): number {
  const key = lineId.startsWith('idea:') ? lineId.slice('idea:'.length) : lineId
  let hash = 5381
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) + hash + key.charCodeAt(index)) | 0
  }
  return Math.abs(hash) % mod
}
