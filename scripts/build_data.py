#!/usr/bin/env python3
"""Build Brick2Print's built-in set data from Rebrickable's free database downloads.

    python scripts/build_data.py <out_dir>

Writes:
  <out_dir>/sets/<bucket>.json  {set_num: {"n": name, "y": year, "p": [[part, colour_id, qty, spare, name], ...]}}
                                parts from the set's newest inventory, minifigure parts folded in
  <out_dir>/index.json          [[set_num, name, year, parts], ...] for searching by name
  <out_dir>/meta.json           when the data was built and from what

Buckets are the first three characters of the set number, so a lookup fetches one small file.
Run weekly by .github/workflows/pages.yml.
"""
import csv, gzip, io, json, os, sys, urllib.request
from collections import defaultdict
from datetime import datetime, timezone

BASE = 'https://cdn.rebrickable.com/media/downloads/'
FILES = ['sets', 'inventories', 'inventory_parts', 'inventory_minifigs', 'parts']


def table(name):
    req = urllib.request.Request(BASE + name + '.csv.gz', headers={'User-Agent': 'brick2print-data-build'})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = gzip.decompress(r.read()).decode('utf-8')
    return list(csv.DictReader(io.StringIO(data)))


def bucket(set_num):
    b = ''.join(c for c in set_num.lower()[:3] if c.isalnum())
    return b or '_'


def main(out):
    t = {n: table(n) for n in FILES}
    part_name = {p['part_num']: p['name'] for p in t['parts']}

    newest = {}  # set_num -> (version, inventory id)
    for inv in t['inventories']:
        v = int(inv['version'])
        if inv['set_num'] not in newest or v > newest[inv['set_num']][0]:
            newest[inv['set_num']] = (v, inv['id'])
    inv_set = {iid: s for s, (_, iid) in newest.items()}

    parts = defaultdict(list)  # inventory id -> [(part, colour, qty, spare)]
    for row in t['inventory_parts']:
        if row['inventory_id'] in inv_set:
            parts[row['inventory_id']].append((row['part_num'], int(row['color_id']), int(row['quantity']), row['is_spare'] == 'True'))

    figs = defaultdict(list)  # inventory id -> [(fig_num, qty)]
    for row in t['inventory_minifigs']:
        figs[row['inventory_id']].append((row['fig_num'], int(row['quantity'])))

    shards, index = defaultdict(dict), []
    for s in t['sets']:
        sn = s['set_num']
        if sn not in newest:
            continue
        iid = newest[sn][1]
        merged = defaultdict(int)
        for part, col, qty, spare in parts[iid]:
            merged[(part, col, spare)] += qty
        for fig, fq in figs[iid]:
            if fig in newest:
                for part, col, qty, spare in parts[newest[fig][1]]:
                    merged[(part, col, spare)] += qty * fq
        if not merged:
            continue
        rows = [[p, c, q, 1 if sp else 0, part_name.get(p, '')] for (p, c, sp), q in sorted(merged.items())]
        shards[bucket(sn)][sn] = {'n': s['name'], 'y': int(s['year']), 'p': rows}
        index.append([sn, s['name'], int(s['year']), sum(q for (_, _, sp), q in merged.items() if not sp)])

    os.makedirs(os.path.join(out, 'sets'), exist_ok=True)
    for b, d in shards.items():
        with open(os.path.join(out, 'sets', b + '.json'), 'w', encoding='utf-8') as f:
            json.dump(d, f, separators=(',', ':'), ensure_ascii=False)
    index.sort(key=lambda r: (-r[2], r[0]))
    with open(os.path.join(out, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, separators=(',', ':'), ensure_ascii=False)
    with open(os.path.join(out, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump({'built': datetime.now(timezone.utc).strftime('%Y-%m-%d'), 'source': 'Rebrickable database downloads', 'sets': len(index)}, f)
    print(f'{len(index)} sets in {len(shards)} files')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'data')
