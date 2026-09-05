#!/usr/bin/env node
// Concatenate src/ back into the single-file distribution.
//
// The bundle is a plain concatenation inside one IIFE: import lines are dropped,
// the `export` keyword is stripped, and every body is re-indented by two spaces.
// Module bodies are never rewritten, so a build is reversible by tools/unbundle.py.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const map = JSON.parse(fs.readFileSync(path.join(root, 'src/.modules.json'), 'utf8'));
const shell = process.argv[2] ?? path.join(root, 'shell.html');
const target = process.argv[3] ?? path.join(root, 'dist/cad.html');

const RULE = '  // ' + '-'.repeat(75);

const chunks = [];
for (const rel of map.order) {
  const text = fs.readFileSync(path.join(root, 'src', rel), 'utf8');
  const lines = text.split('\n')
    .filter(l => !/^import\s.*from\s+['"].*['"];\s*$/.test(l))
    .map(l => (l.startsWith('export ') ? l.slice(7) : l))
    .map(l => (l.length ? '  ' + l : l));
  chunks.push([RULE, `  // ${rel}`, RULE, ...lines].join('\n'));
}

const body = [...map.prologue, ...chunks].join('\n');
const html = fs.readFileSync(shell, 'utf8');
const open = html.indexOf('(() => {');
const close = html.indexOf('  })();', open);
if (open < 0 || close < 0) throw new Error('shell has no IIFE to fill');

const out = html.slice(0, open) + '(() => {\n' + body + '\n' + html.slice(close);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out);
console.log(`built ${path.relative(root, target)} — ${map.order.length} modules, ${(out.length / 1024).toFixed(0)} KB`);
