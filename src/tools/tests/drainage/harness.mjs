// Boots drainage.html's first <script> inside a Node vm. That script is the engine: a job in,
// every outlet sized and every check out, with no DOM. The second script is the UI and is left
// to a browser.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {suite} from '../schedule/harness.mjs';

export {suite};
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PAGE = path.resolve(HERE, '../../../../drainage.html');

export function boot(page = process.argv[2] || DEFAULT_PAGE) {
  const html = fs.readFileSync(page, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no inline <script> in ' + page);
  const ctx = vm.createContext({ console });
  vm.runInContext(m[1], ctx, { filename: 'drainage.html' });
  return code => vm.runInContext(code, ctx);
}
