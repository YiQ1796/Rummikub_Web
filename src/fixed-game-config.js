/** Public four-seat policy and URL normalization for GitHub Pages. */
export const FIXED_PLAYER_COUNT = 4;
export const FIXED_GAME_URL = 'https://yiq1796.github.io/Rummikub_Web/';

/** Remove stale version/tracking parameters without destroying room invitations. */
export function canonicalPublicPath(href) {
  const url = new URL(href);
  url.searchParams.delete('v');
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key)) url.searchParams.delete(key);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
