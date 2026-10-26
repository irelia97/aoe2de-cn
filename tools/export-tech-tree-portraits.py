"""Convert the game's original 256px unique-unit portraits for the civ banner."""
import argparse
import json
from pathlib import Path
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]

def export(game,raw_only=False):
    pictures=set()
    for path in (ROOT/'public/tech-tree-data/civs').glob('*.json'):
        tree=json.loads(path.read_text(encoding='utf8'))
        for node in tree['nodes']:
            if (node['unique'] or node['entity'] in ('Unit:2703', 'Unit:753')) and node['available'] and node['entity'].startswith('Unit:'):
                pictures.add(int(Path(node['icon']).stem))
    source=game/'widgetui/textures/ingame/units'
    output=ROOT/('public/assets/tech-tree/portraits-rgba' if raw_only else 'public/assets/tech-tree/portraits')
    output.mkdir(parents=True,exist_ok=True)
    for ident in sorted(pictures):
        files=sorted(source.glob(f'{ident:03d}_*.DDS'))
        if not files:
            raise ValueError(f'Missing original portrait {ident}')
        with Image.open(files[0]) as image:
            if min(image.size)<256:
                raise ValueError(f'Low-resolution source: {files[0]}')
            if raw_only:
                # Unmodified source channels for the browser's player-colour shader.
                (output/f'{ident}.rgba').write_bytes(image.convert('RGBA').tobytes())
            else:
                image.convert('RGBA').save(output/f'{ident}.webp',format='WEBP',quality=95,method=6)
    print(f'Exported {len(pictures)} original portraits')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game-dir',type=Path,required=True)
    parser.add_argument('--raw-only',action='store_true')
    args=parser.parse_args()
    export(args.game_dir,args.raw_only)
