// Boots pano.html's first <script> inside a Node vm. That script is the part of the page that
// never touches the DOM: the projection math, the panorama metadata, snapshot sizes and the
// saved settings. The second script is the WebGL viewer and is left to a browser.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {suite} from '../schedule/harness.mjs';

export {suite};
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PAGE = path.resolve(HERE, '../../../../pano.html');

export function boot(page = process.argv[2] || DEFAULT_PAGE) {
  const html = fs.readFileSync(page, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no inline <script> in ' + page);
  const ctx = vm.createContext({ console });
  vm.runInContext(m[1], ctx, { filename: 'pano.html' });
  return code => vm.runInContext(code, ctx);
}
