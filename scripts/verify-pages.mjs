/** Static deploy smoke checks; run after unit tests and before GitHub Pages upload. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const required = [
  'index.html', '.nojekyll', 'assets/styles.css', 'assets/art-config.js',
  'src/main.js', 'src/rules.js', 'src/game.js', 'src/ai.js',
  'tests/game.test.mjs', 'tests/rules.test.mjs', 'tests/long-game.test.mjs',
];
for (const relativePath of required) {
  assert.ok(existsSync(resolve(root, relativePath)), `Missing deploy file: ${relativePath}`);
}
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
assert.match(html, /猴三毛拉密/);
assert.match(html, /type="module"\s+src="\.\/src\/main\.js"/);
assert.match(html, /<link\s+rel="stylesheet"\s+href="\.\/assets\/styles\.css"/);
assert.doesNotMatch(html, /<base\s+href=/i, 'Relative URLs must work on project Pages paths.');
const config = readFileSync(resolve(root, 'assets/art-config.js'), 'utf8');
assert.match(config, /jokerA:\s*null/);
assert.match(config, /jokerB:\s*null/);
console.log('PASS - independent project root, relative URL paths, and Joker placeholders');
