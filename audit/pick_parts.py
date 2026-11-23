#!/usr/bin/env python3
"""Pick the parts the audit tests: the most-used parts of every Rebrickable part category.

    python audit/pick_parts.py [per_category] > audit/out/parts.json

Parts that share a category are similar in shape and job (bricks, plates, Technic pins, clips,
wheels...), so the most-used few of each stand in for the rest. Usage = pieces across every
set's newest inventory, spares left out. Categories with nothing printable (stickers, minifig
printed parts, non-LEGO) are skipped.
"""
import csv, gzip, io, json, sys, urllib.request
from collections import defaultdict

BASE = 'https://cdn.rebrickable.com/media/downloads/'
SKIP = ('sticker', 'non-lego', 'minifig', 'string', 'rubber', 'tubes', 'cables', 'electronics', 'power functions',
        'flag', 'cloth', 'paper', 'large buildable', 'duplo, quatro', 'clikits', 'scala', 'belville', 'znap',
        'bionicle', 'hero factory', 'fabuland', 'baby', 'primo', 'pneumatics', 'mechanical', 'magnets', 'light')


def table(name):
    req = urllib.request.Request(BASE + name + '.csv.gz', headers={'User-Agent': 'brick2print-audit'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return list(csv.DictReader(io.StringIO(gzip.decompress(r.read()).decode('utf-8'))))


def main(per_cat):
    cats = {c['id']: c['name'] for c in table('part_categories')}
    parts = {p['part_num']: p for p in table('parts')}
    newest = {}
    for inv in table('inventories'):
        v = int(inv['version'])
        if inv['set_num'] not in newest or v > newest[inv['set_num']][0]:
            newest[inv['set_num']] = (v, inv['id'])
    live = {iid for _, iid in newest.values()}
    uses = defaultdict(int)
    for row in table('inventory_parts'):
        if row['inventory_id'] in live and row['is_spare'] != 'True':
            uses[row['part_num']] += int(row['quantity'])
    by_cat = defaultdict(list)
    for pn, n in uses.items():
        p = parts.get(pn)
        if not p:
            continue
        cat = cats.get(p['part_cat_id'], '?')
        if any(s in cat.lower() for s in SKIP):
            continue
        by_cat[cat].append((n, pn, p['name']))
    out = []
    for cat, rows in sorted(by_cat.items()):
        rows.sort(reverse=True)
        for n, pn, name in rows[:per_cat]:
            out.append({'part': pn, 'name': name, 'category': cat, 'uses': n, 'catParts': len(rows), 'catUses': sum(r[0] for r in rows)})
    json.dump(out, sys.stdout, indent=1)
    sys.stderr.write(f'{len(out)} parts from {len(by_cat)} categories\n')


if __name__ == '__main__':
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 8)
