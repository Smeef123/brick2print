#!/usr/bin/env python3
"""Summarise audit/out/results.jsonl: per category and overall, and list the problem parts.

    python audit/report.py [results.jsonl]

A part is OK when the shipped plate ("on") slices and has no more than 1 mm2 starting in mid-air.
Compared with plain studs-up ("off"): better / same / worse by more than 0.5 mm2 or 15% (whichever is more), or by slicing at all.
"""
import json, sys
from collections import defaultdict

rows = [json.loads(l) for l in open(sys.argv[1] if len(sys.argv) > 1 else 'audit/out/results.jsonl', encoding='utf-8') if l.strip()]


def mid(s):
    if not s or s.get('rc') != 0 or s.get('midair') is None:
        return float('inf')
    return s['midair']


cats = defaultdict(lambda: defaultdict(int))
problems = []
for r in rows:
    c = cats[r.get('category', '?')]
    c['parts'] += 1
    if r.get('status') != 'done':
        c[r.get('status', '?')] += 1
        problems.append((r.get('category'), r['part'], r.get('name', ''), r.get('status'), (r.get('error') or '')[:80]))
        continue
    off, on = mid(r['off']), mid(r['on'])
    c['ok'] += on <= 1.0
    tol = max(0.5, 0.15 * min(on, off))   # Bambu's slices vary run to run: identical files measured 50.6 vs 58.5 mm2
    c['better'] += on < off - tol
    c['worse'] += on > off + tol
    c['supported'] += r.get('decision') != 'prints as is'
    if on > 1.0 or on > off + tol:
        why = 'does not slice: ' + (r['on'].get('error') or '') if on == float('inf') else f"mid-air {r['on']['midair']} mm2 (studs-up {r['off'].get('midair') if off != float('inf') else 'fails'})"
        problems.append((r['category'], r['part'], r.get('name', ''), r.get('decision'), why))

tot = defaultdict(int)
print(f"{'category':38} parts  ok  better worse supported other")
for name, c in sorted(cats.items()):
    other = c['parts'] - sum(c[k] for k in ('ok',)) if False else sum(v for k, v in c.items() if k not in ('parts', 'ok', 'better', 'worse', 'supported'))
    print(f"{name[:38]:38} {c['parts']:5} {c['ok']:3} {c['better']:6} {c['worse']:5} {c['supported']:9} {other:5}")
    for k, v in c.items():
        tot[k] += v
print(f"{'ALL':38} {tot['parts']:5} {tot['ok']:3} {tot['better']:6} {tot['worse']:5} {tot['supported']:9}")
print('\nPROBLEMS')
for p in sorted(problems, key=lambda p: (str(p[0]), str(p[1]))):
    print(' | '.join(str(x) for x in p))
