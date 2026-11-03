/** Static deploy smoke checks; run after unit tests and before GitHub Pages upload. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const required = [
  'index.html', '.nojekyll', 'assets/styles.css', 'assets/art-config.js',
  'src/main.js', 'src/fixed-game-config.js', 'src/room-join-status.js', 'src/room-roster.js', 'src/tile-order.js', 'src/match-result.js', 'src/online-core.js', 'src/peer-room.js', 'src/online-controller.js', 'src/rules.js', 'src/game.js', 'src/ai.js',
  'assets/jokers/joker_sanmao_smile.webp', 'assets/jokers/joker_sanmao_smirk.webp',
  'tests/fixed-game-config.test.mjs', 'tests/room-roster.test.mjs', 'tests/room-join-status.test.mjs', 'tests/match-result.test.mjs', 'tests/game.test.mjs', 'tests/rules.test.mjs', 'tests/long-game.test.mjs', 'tests/online-core.test.mjs', 'tests/online-integration.test.mjs', 'tests/tile-order.test.mjs',
];
for (const relativePath of required) {
  assert.ok(existsSync(resolve(root, relativePath)), `Missing deploy file: ${relativePath}`);
}
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
assert.match(html, /猴三毛拉密/);
assert.match(html, /peerjs@1\.5\.5/);
assert.match(html, /id="create-room"/);
assert.match(html, /id="join-room"/);
assert.match(html, /id="host-start"/);
assert.match(html, /id="room-join-state"/);
assert.match(html, /id="room-player-count"/);
assert.match(html, /id="room-members"/);
assert.match(html, /id="room-ai-hint"/);
assert.match(html, /固定 4 人對局/);
assert.doesNotMatch(html, /id="seat-count"/, 'Player count chooser must be removed.');
assert.match(html, /rel="canonical" href="https:\/\/yiq1796\.github\.io\/Rummikub_Web\/"/);
assert.match(html, /id="result-dialog"/);
assert.match(html, /id="result-banner"/);
assert.match(html, /id="result-scores"/);
assert.match(html, /type="module"\s+src="\.\/src\/main\.js(?:\?v=\d+)?"/);
assert.match(html, /<link\s+rel="stylesheet"\s+href="\.\/assets\/styles\.css(?:\?v=\d+)?"/);
assert.doesNotMatch(html, /<base\s+href=/i, 'Relative URLs must work on project Pages paths.');
const config = readFileSync(resolve(root, 'assets/art-config.js'), 'utf8');
for (const [slot, path] of Object.entries({
  jokerA: './assets/jokers/joker_sanmao_smile.webp',
  jokerB: './assets/jokers/joker_sanmao_smirk.webp'
})) {
  assert.ok(config.includes(`${slot}: '${path}'`), `${slot} must map to the approved image`);
  const data = readFileSync(resolve(root, path));
  assert.ok(data.length > 1000, `${slot} artwork is too small or invalid`);
  assert.equal(data.subarray(0, 4).toString(), 'RIFF', 'Expected WebP RIFF header');
  assert.equal(data.subarray(8, 12).toString(), 'WEBP', 'Expected WebP format');
}
assert.ok(!config.includes('jokerA: null') && !config.includes('jokerB: null'));
console.log('PASS - approved two Joker images replace placeholders, and relative URLs are valid');
