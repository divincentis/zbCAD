#!/usr/bin/env python3
"""Fail if the module graph gains a cycle. Also reports unused imports."""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src')
order = json.load(open(os.path.join(SRC, '.modules.json')))['order']

IMPORT = re.compile(r"^import \{ ([^}]*) \} from '([^']*)';$", re.M)
graph, imported = {}, {}
for rel in order:
    text = open(os.path.join(SRC, rel)).read()
    deps, names = [], []
    for names_raw, target in IMPORT.findall(text):
        dep = os.path.normpath(os.path.join(os.path.dirname(rel), target)).replace(os.sep, '/')
        deps.append(dep)
        names.extend(n.strip() for n in names_raw.split(','))
    graph[rel] = deps
    imported[rel] = names

# Tarjan
index, stack, on, idx, low, comps = {}, [], set(), [0], {}, []
def strong(v):
    idx[0] += 1
    index[v] = low[v] = idx[0]
    stack.append(v); on.add(v)
    for w in graph.get(v, []):
        if w not in index:
            strong(w); low[v] = min(low[v], low[w])
        elif w in on:
            low[v] = min(low[v], index[w])
    if low[v] == index[v]:
        comp = []
        while True:
            w = stack.pop(); on.discard(w); comp.append(w)
            if w == v: break
        comps.append(comp)

sys.setrecursionlimit(10000)
for m in order:
    if m not in index:
        strong(m)

cycles = [c for c in comps if len(c) > 1]
missing = [(m, d) for m, ds in graph.items() for d in ds if d not in graph]
print('modules:', len(order))
print('missing import targets:', missing or 'none')
print('cycles:', cycles or 'none')

# imports that name something the target module does not export. The bundle is
# one flat scope, so a stale import still resolves there and the mistake only
# shows up as a module graph that no longer describes the program.
EXPORT = re.compile(r'^export (?:async )?(?:function|class|const|let|var) ([A-Za-z_$][\w$]*)', re.M)
exports = {rel: set(EXPORT.findall(open(os.path.join(SRC, rel)).read())) for rel in order}
unexported = []
for rel in order:
    text = open(os.path.join(SRC, rel)).read()
    for names_raw, target in IMPORT.findall(text):
        dep = os.path.normpath(os.path.join(os.path.dirname(rel), target)).replace(os.sep, '/')
        for name in (n.strip() for n in names_raw.split(',')):
            if name and dep in exports and name not in exports[dep]:
                unexported.append(f'{rel}: {name} is not exported by {dep}')
print('imports of missing exports:', unexported or 'none')

# unused imports: name never appears in the body below the import header
unused = []
for rel in order:
    lines = open(os.path.join(SRC, rel)).read().split('\n')
    body = '\n'.join(l for l in lines if not l.startswith('import '))
    for name in imported[rel]:
        if not re.search(r'(?<![\w$])(?<![^.]\.)%s(?![\w$])' % re.escape(name), body):
            unused.append(f'{rel}: {name}')
print('unused imports:', len(unused))
for u in unused[:20]:
    print('  ', u)

# duplicate top-level names: the bundle is ONE flat scope, so two modules
# declaring the same top-level name silently shadow each other — the later one
# in `order` wins, and the earlier module's callers quietly get the wrong
# function. Nothing else notices: the import graph is still valid, every name
# still resolves, and the syntax check passes. unbundle.py's ownership table
# assumes uniqueness too, so a clash also breaks the round trip back to modules.
DECL = re.compile(r'^(?:export )?(?:async )?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)', re.M)
owners = {}
duplicates = []
for rel in order:
    text = open(os.path.join(SRC, rel)).read()
    for name in set(DECL.findall(text)):
        if name in owners:
            duplicates.append(f'{name}: {owners[name]} and {rel}')
        else:
            owners[name] = rel
print('duplicate top-level names:', duplicates or 'none')
for d in duplicates:
    print('  ', d)

sys.exit(1 if cycles or missing or unexported or duplicates else 0)
