"""Export replay technology names/icons from a local AoE2DE installation (read-only).

Requires genieutils-py and Pillow. Run with --game-dir pointing to AoE2DE.
The generated supplement is consumed by generate-replay-tech-map.mjs.
"""
import argparse
import json
import re
from pathlib import Path

from genieutils.datfile import DatFile
from PIL import Image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game-dir', required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    game = args.game_dir
    data = DatFile.parse(game / 'resources/_common/dat/empires2_x2_p1.dat')
    strings = {}
    locale_dir = game / 'resources/zh/strings/key-value'
    files = [locale_dir / 'key-value-strings-utf8.txt']
    files += sorted(p for p in locale_dir.glob('*.txt') if p != files[0])
    for file in files:
        for line in file.read_text(encoding='utf-8-sig').splitlines():
            match = re.match(r'^\s*(\d+)\s+"(.*)"\s*$', line)
            if match:
                strings.setdefault(int(match[1]), match[2])
    icon_dir = game / 'widgetui/textures/ingame/tech'
    icons = {int(p.name.split('_')[0]): p for p in icon_dir.iterdir()
             if p.name.split('_')[0].isdigit() and p.suffix.lower() == '.dds'}
    output_dir = root / 'public/assets/replay-tech-icons'
    output_dir.mkdir(parents=True, exist_ok=True)
    exported = set()
    entries = {}
    for tech_id, tech in enumerate(data.techs):
        if not tech.name.strip():
            continue
        localized = strings.get(tech.language_dll_name) if tech.language_dll_name not in (-1, 0, 7000) else None
        name = localized or tech.name.strip()
        name = re.sub(r'<[^>]*>', '', name).replace(r'\n', '').replace(r'\r', '').strip()
        icon = tech.icon_id if tech.icon_id in icons else None
        entries[str(tech_id)] = {
            'id': tech_id, 'name': name, 'internal_name': tech.name.strip(),
            'picture_index': icon, 'icon_type': 'GameTech',
        }
        if icon is not None and icon not in exported:
            with Image.open(icons[icon]) as image:
                image.convert('RGBA').resize((64, 64), Image.Resampling.LANCZOS).save(
                    output_dir / f'game-{icon}.png')
            exported.add(icon)
    supplement = {
        'source': {'game': 'AoE2DE', 'dat_version': data.version,
                   'total_tech_slots': len(data.techs)},
        'technologies': entries,
    }
    target = root / 'config/replay-game-tech-supplement.json'
    target.write_text(json.dumps(supplement, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Exported {len(entries)} named technologies and {len(exported)} game icons')


if __name__ == '__main__':
    main()
