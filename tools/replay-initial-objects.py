"""Extract initial objects from replay headers; replay bytes arrive on stdin."""
import argparse
import io
import json
import math
import sys

from mgz.fast.header import decompress, parse_players
from mgz.util import Version

parser = argparse.ArgumentParser()
parser.add_argument('--players', type=int, required=True)
parser.add_argument('--save-version', type=float, required=True)
args = parser.parse_args()
if not 1 <= args.players <= 9:
    raise ValueError('Invalid player count')
header = decompress(io.BytesIO(sys.stdin.buffer.read(128 * 1024 * 1024 + 1)))
# Settings are already decoded by WASM. Parse the object section independently,
# so new DE settings fields cannot shift the player/object parser.
players, _, _ = parse_players(header, args.players, Version.DE, args.save_version)
objects = []
seen = set()
for player in players:
    for obj in player['objects']:
        x, y = obj['position']['x'], obj['position']['y']
        instance = obj['instance_id']
        if instance in seen or not all(math.isfinite(v) for v in [x, y]) or x < 0 or y < 0:
            continue
        seen.add(instance)
        objects.append(dict(player=player['number'], id=obj['object_id'], instance=instance,
                            classId=obj['class_id'], x=x, y=y))
        if len(objects) > 50000:
            raise ValueError('Initial object limit exceeded')
print(json.dumps(objects, separators=(',', ':')))
