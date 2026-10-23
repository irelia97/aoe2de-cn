"""Export localized unit/building ID names from a read-only AoE2DE install."""
import argparse
import json
import re
from pathlib import Path
from genieutils.datfile import DatFile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--game-dir', required=True, type=Path)
args = parser.parse_args()
strings = {}
locale = args.game_dir / 'resources/zh/strings/key-value'
primary = locale / 'key-value-strings-utf8.txt'
for path in [primary, *sorted(p for p in locale.glob('*.txt') if p != primary)]:
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        match = re.match(r'^\s*(\d+)\s+"(.*)"\s*$', line)
        if match:
            strings.setdefault(int(match[1]), match[2])
data = DatFile.parse(args.game_dir / 'resources/_common/dat/empires2_x2_p1.dat')
names = {}
buildings = set()
for civ in data.civs:
    for unit_id, unit in enumerate(civ.units):
        if unit and unit.type == 80:
            buildings.add(unit_id)
        if not unit or unit_id in names:
            continue
        name = strings.get(unit.language_dll_name, '')
        name = re.sub(r'<[^>]*>', '', name).replace(r'\n', ' ').strip()
        if name and re.search(r'[\u3400-\u9fff]', name):
            names[unit_id] = name
target = Path(__file__).resolve().parent.parent / 'public/replay-object-names.js'
target.write_text('// Exported from AoE2DE DAT IDs and official Chinese strings.\n'
                  + 'export const replayObjectNames = '
                  + json.dumps(dict(sorted(names.items())), ensure_ascii=False, indent=2)
                  + ';\nexport const replayBuildingObjectIds = new Set(' + json.dumps(sorted(buildings)) + ');\n', encoding='utf-8')
print(f'Exported {len(names)} localized object names; 1808: {names.get(1808)}')
