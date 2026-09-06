#!/usr/bin/env python3
"""Re-derive src/ ES modules from a hand-edited dist/cad.html bundle.

The bundle keeps a banner per module, so the module map is recoverable from the
file itself. Bodies are taken verbatim (dedented by two spaces); imports are
derived from top-level declarations. Nothing is retyped.
"""
import json
import os
import re
import sys
from collections import defaultdict

SRC = sys.argv[1] if len(sys.argv) > 1 else '/mnt/user-data/uploads/cad.html'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/home/claude/zbcad/src'

html = open(SRC).read()
lines = html.split('\n')

start = next(i for i, l in enumerate(lines) if l.strip() == '(() => {')
end = next(i for i, l in enumerate(lines) if l.strip() == '})();')
body = lines[start + 1:end]           # inside the IIFE

RULE = '  // ' + '-' * 75
banners = [i for i, l in enumerate(body)
           if l == RULE and i + 2 < len(body) and body[i + 2] == RULE
           and body[i + 1].strip().startswith('// ') and body[i + 1].strip().endswith('.js')]

modules = []                          # (path, [body lines])
for n, b in enumerate(banners):
    path = body[b + 1].strip()[3:]
    stop = banners[n + 1] if n + 1 < len(banners) else len(body)
    modules.append((path, body[b + 3:stop]))

prologue = body[:banners[0]]          # 'use strict' etc.

# ---------------------------------------------------------------- symbol table
DECL = re.compile(r'^  (?:export )?((?:async )?(?:function|class|const|let|var))\s+([A-Za-z_$][\w$]*)')
owner, kind = {}, {}
clashes = []
for path, blines in modules:
    for l in blines:
        m = DECL.match(l)
        if m:
            if m.group(2) in owner:
                clashes.append((m.group(2), owner[m.group(2)], path))
            owner[m.group(2)] = path
            kind[m.group(2)] = m.group(1)

# ------------------------------------------------------------------ references
STRIP = [
    (re.compile(r'/\*.*?\*/', re.S), ' '),
    (re.compile(r'//[^\n]*'), ' '),
    (re.compile(r'`(?:\\.|\$\{[^{}]*\}|[^`\\])*`', re.S), ' TPL '),
    (re.compile(r"'(?:\\.|[^'\\])*'"), ' STR '),
    (re.compile(r'"(?:\\.|[^"\\])*"'), ' STR '),
]
MEMBER = re.compile(r'(?<!\.\.)\.\s*[A-Za-z_$][\w$]*')
IDENT = re.compile(r'(?<![\w$])(?<!(?<!\.)\.)[A-Za-z_$][\w$]*')


def scrub(text):
    # template literals may hold expressions; keep them by unwrapping ${...}
    text = re.sub(r'`((?:\\.|[^`\\])*)`',
                  lambda m: ' '.join(re.findall(r'\$\{([^{}]*)\}', m.group(1))) or ' TPL ',
                  text, flags=re.S)
    for pat, rep in STRIP[:2] + STRIP[3:]:
        text = pat.sub(rep, text)
    return MEMBER.sub(' ', text)


refs = {}
for path, blines in modules:
    text = scrub('\n'.join(blines))
    names = set(IDENT.findall(text))
    refs[path] = sorted(n for n in names if owner.get(n) not in (None, path))

# ----------------------------------------------------------------------- write
os.makedirs(OUT, exist_ok=True)
for path, blines in modules:
    full = os.path.join(OUT, path)
    os.makedirs(os.path.dirname(full) or OUT, exist_ok=True)
    by_src = defaultdict(list)
    for name in refs[path]:
        by_src[owner[name]].append(name)
    header = []
    for src in sorted(by_src):
        rel = os.path.relpath(src, os.path.dirname(path)).replace(os.sep, '/')
        if not rel.startswith('.'):
            rel = './' + rel
        header.append('import { %s } from %r;' % (', '.join(sorted(by_src[src])), rel))
    out = []
    for l in blines:
        out.append(DECL.sub(lambda m: '  export ' + m.group(1) + ' ' + m.group(2), l, count=1)
                   if DECL.match(l) else l)
    text = '\n'.join(l[2:] if l.startswith('  ') else l for l in out)
    open(full, 'w').write(('\n'.join(header) + '\n' if header else '') + text)

json.dump({'order': [p for p, _ in modules], 'prologue': prologue,
           'owner': owner, 'kinds': kind},
          open(os.path.join(OUT, '.modules.json'), 'w'), indent=1)

print('modules:', len(modules))
print('symbols:', len(owner))
print('clashes:', clashes if clashes else 'none')
edges = sum(len(v) for v in refs.values())
print('import edges:', edges)
