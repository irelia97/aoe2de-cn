"""Export original DE building buttons as browser-readable PNGs (read-only source)."""
import argparse
import json
from pathlib import Path
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('--game-dir', required=True, type=Path)
args = parser.parse_args()
source = args.game_dir / 'widgetui/textures/ingame/buildings'
root = Path(__file__).resolve().parent.parent
target = root / 'public/assets/replay-building-icons'
target.mkdir(parents=True, exist_ok=True)
rows = [
    (109, '城镇中心', 'town-center', '028_town_center.DDS'),
    (79, '瞭望箭塔', 'watch-tower', '025_tower.DDS'),
    (234, '警戒箭塔', 'guard-tower', '027_tower_guard.DDS'),
    (235, '大型箭塔', 'keep', '026_tower_keep.DDS'),
    (236, '炮塔', 'bombard-tower', '042_bombard_tower.DDS'),
    (1251, '营垒', 'krepost', '055_krepost.DDS'),
    (1806, '强化教堂', 'fortified-church', '088_fortified_church.dds'),
    (1665, '塔楼', 'donjon', '084_donjon.DDS'),
    (82, '城堡', 'castle', '007_castle.DDS'),
    (45, '船坞', 'dock', '013_dock_1.DDS'),
    (12, '兵营', 'barracks', '002_barracks_1.DDS'),
    (101, '马厩', 'stable', '023_stable_1.DDS'),
    (87, '靶场', 'archery-range', '000_archery_range_1.DDS'),
    (49, '攻城武器厂', 'siege-workshop', '022_siege_workshop_2.DDS'),
    (104, '修道院', 'monastery', '010_monastery_1.DDS'),
]
manifest = []
for unit_id, name, slug, filename in rows:
    with Image.open(source / filename) as image:
        image.convert('RGBA').save(target / f'{slug}-de.png')
    manifest.append(dict(id=unit_id, name=name, icon=f'/assets/replay-building-icons/{slug}-de.png',
                         source=f'AoE2DE/widgetui/textures/ingame/buildings/{filename}'))
(target / 'de-sources.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'Exported {len(manifest)} original DE building buttons')
