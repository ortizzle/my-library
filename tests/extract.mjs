// Pull named functions out of index.html so they can be unit-tested in node.
//
// The app is deliberately a single HTML file with no build step, so there is
// nothing to import. Rather than duplicate the sync logic here (where it would
// drift from the real thing), we slice the actual function bodies out of the
// source and evaluate them. If a function is renamed, these tests fail loudly
// instead of silently testing a stale copy.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const source = readFileSync(join(root, 'index.html'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`extract: function ${name}() not found in index.html`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`extract: unbalanced braces in ${name}()`);
}

/**
 * Evaluate the named functions in isolation and return them.
 * `expose` names extra bindings from the preamble to return alongside, so a
 * test can drive the module-level state a function reads.
 */
export function loadFunctions(names, preamble = '', expose = []) {
  const body = names.map(n => extractFunction(source, n)).join('\n\n');
  const returns = [...names, ...expose].join(',');
  const factory = new Function(`${preamble}\n${body}\nreturn {${returns}};`);
  return factory();
}

/** Read a top-level `const NAME=<literal>;` out of the source. */
export function extractConst(name) {
  const m = source.match(new RegExp(`const ${name}\\s*=\\s*([^;]+);`));
  if (!m) throw new Error(`extract: const ${name} not found`);
  return m[1];
}
