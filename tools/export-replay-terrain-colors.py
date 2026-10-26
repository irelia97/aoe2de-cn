"""Export minimap colors from a local AoE2DE installation (read-only)."""
import argparse
import json
from pathlib import Path
from genieutils.datfile import DatFile

parser = argparse.ArgumentParser()
parser.add_argument('--game-dir', required=True, type=Path)
args = parser.parse_args()
game = args.game_dir
data = DatFile.parse(game / 'resources/_common/dat/empires2_x2_p1.dat')
palette = json.loads((game / 'widgetui/palette.json').read_text(encoding='utf-8-sig'))['Palette']

def color(index):
    entry = palette[index]
    return '#{:02x}{:02x}{:02x}'.format(entry['r'], entry['g'], entry['b'])

terrains = {str(i): color(t.colors[0]) for i, t in enumerate(data.terrain_block.terrains) if t.enabled}
# Shore fish use a different unit class than deep-water fish. Exclude obsolete
# fish placeholders and fishing ships rather than treating all sea fauna as food.
fish_ids = [i for i, u in enumerate(data.civs[0].units)
            if u and u.name.upper().startswith('FISH') and u.minimap_color != 0]
root = Path(__file__).resolve().parent.parent
target = root / 'public/replay-terrain-colors.js'
target.write_text('// Exported from AoE2DE terrain minimap palette indices and widgetui/palette.json.\n'
                  + 'export const replayTerrainColors = ' + json.dumps(terrains, indent=2) + ';\n'
                  + 'export const replayFishObjectIds = new Set(' + json.dumps(fish_ids) + ');\n', encoding='utf-8')
print(f'Exported {len(terrains)} terrain colors')
print(f'Fish resource IDs: {fish_ids}')
