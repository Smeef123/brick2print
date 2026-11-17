#!/usr/bin/env python3
"""Turn audit results into the site's verified decisions.

    python audit/decisions.py audit/out/results.jsonl > bambu/decisions.json

For every audited part, Bambu Studio sliced both versions three times. When the site's automatic
supports came out clearly worse than plain studs-up (more mid-air area by over 0.5 mm2 and 15%,
judged on the middle of three slices) or failed to slice, the part is marked "plain" and the site
prints it studs-up as is. Everything else keeps the automatic decision. Keys are LDraw file names.
"""
import json, sys

def mid(s):
    if not s or s.get('rc') != 0 or s.get('midair') is None:
        return float('inf')
    return s['midair']

out = {}
for line in open(sys.argv[1], encoding='utf-8'):
    if not line.strip():
        continue
    r = json.loads(line)
    if r.get('status') != 'done' or r.get('decision') == 'prints as is':
        continue
    off, on = mid(r['off']), mid(r['on'])
    if off == float('inf'):
        continue                      # studs-up doesn't slice either: keep the automatic attempt
    if on > off + max(0.5, 0.15 * min(on, off)):
        out[r['ldraw']] = 'plain'
json.dump(dict(sorted(out.items())), sys.stdout, indent=1)
sys.stderr.write(f'{len(out)} parts kept plain\n')
