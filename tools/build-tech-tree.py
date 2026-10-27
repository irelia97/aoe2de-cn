"""Build the local Chinese AoE2DE reference from a pinned aoe2techtree export.

python tools/build-tech-tree.py --source-dir <extracted aoe2techtree directory>
Download: https://codeload.github.com/SiegeEngineers/aoe2techtree/zip/<REVISION>
No network calls or changes to existing replay assets are made by this builder.
"""
import argparse
import html
import json
from pathlib import Path
import re
import shutil

REVISION = '3bb43b1439eef88dfe7fe892d7f7dc41ac9dd76f'
ROOT = Path(__file__).resolve().parents[1]


def text(value):
    value = re.sub(r'<br\s*/?>', '\n', value or '', flags=re.I)
    value = re.sub(r'<[^>]*>', '', value)
    value = re.sub(r'‹[^›]*›', '', value)
    value = html.unescape(value).replace('()', '').replace('( )', '')
    return '\n'.join(line.strip() for line in value.splitlines() if line.strip())


def category(building_id):
    if building_id in [45, 1189, 199]:
        return 'naval'
    if building_id in [598, 79, 234, 235, 236, 72, 792, 487, 117, 155, 209, 1665]:
        return 'defense'
    if building_id in [109, 621, 70, 276, 584, 562, 84, 68, 50, 1808, 1754, 2556, 1889, 1734, 1021]:
        return 'economy'
    if building_id in [87, 12, 101, 49, 103, 82, 104, 1251, 1806]:
        return 'military'
    raise ValueError(f'Building {building_id} needs an explicit category')


def build(source):
    data = json.loads((source/'data/data.json').read_text(encoding='utf-8'))
    strings = json.loads((source/'data/locales/zh/strings.json').read_text(encoding='utf-8'))
    output = ROOT/'public/tech-tree-data'
    assets = ROOT/'public/assets/tech-tree'
    (output/'civs').mkdir(parents=True, exist_ok=True)
    entities, civs, icons = {}, [], set()

    def add_icon(kind, index):
        relative = f'{kind}/{index}.png'
        path = source/'img'/relative
        if not path.exists():
            raise ValueError(f'Missing upstream icon: {relative}')
        icons.add(relative)
        return '/assets/tech-tree/'+relative

    for name, civ in data['civs'].items():
        if civ.get('era') != 'base':
            continue
        tree = json.loads((source/'data/trees'/f'{name.upper()}.json').read_text(encoding='utf-8'))
        civ_id = name.lower()
        primary = {int(b['node_id']): b for b in tree['buildings'] if any(n for row in b['grid'] for n in row)}
        groups, nodes = {}, []
        originals = tree['buildings'] + tree['units_techs']
        # Build actual upgrade/prerequisite links from the game's node types,
        # rather than inferring a relationship from the drawing's positions.
        by_type_id = {(n['use_type'], n['node_id'], n['building_id']): n['id'] for n in originals}
        for raw in originals:
            kind, ident = raw['use_type'], int(raw['node_id'])
            entity_key = f'{kind}:{ident}'
            metadata = data['data'].get(kind, {}).get(str(ident), {})
            display_name = text(strings.get(str(raw['name_string_id']), raw['name']))
            help_text = text(strings.get(str(raw['help_string_id']-79000), ''))
            icon = add_icon(kind, raw['picture_index'])
            if entity_key not in entities:
                entities[entity_key] = {'id':ident, 'type':kind, 'name':display_name,
                    'englishName':raw['name'], 'description':help_text, 'icon':icon,
                    'stats':metadata,
                    'upgrade':data['data']['unit_upgrades'].get(str(ident)) if kind == 'Unit' else None,
                    'civilizations':[]}
            # The tree's availability status also covers unique/regional nodes
            # and nodes the civilization unlocks automatically.
            available = raw['node_status'] != 'NotAvailable'
            if available and civ_id not in entities[entity_key]['civilizations']:
                entities[entity_key]['civilizations'].append(civ_id)
            building_id = int(raw['building_id'])
            parent_kind = {'BuildingTech':'Building', 'UnitUpgrade':'Unit', 'UniqueUnit':'Unit',
                           'Research':'Tech', 'UniqueTech':'Tech', 'Unit':'Unit'}.get(raw.get('link_node_type'))
            parent = by_type_id.get((parent_kind, raw.get('link_id'), building_id))
            if not parent and parent_kind == 'Building':
                parent = next((n['id'] for n in originals if n['use_type']=='Building' and n['node_id']==raw.get('link_id')), None)
            # The export omits the Heavy Mounted Crossbowman's unit-upgrade link.
            if not parent and kind == 'Unit' and ident == 2701:
                parent = by_type_id.get(('Unit', 2700, building_id))
            if building_id in primary:
                group_key = f'building-{building_id}'
                group_name = text(strings.get(str(primary[building_id]['name_string_id']), primary[building_id]['name']))
            else:
                group_key = category(ident if kind == 'Building' else building_id)+'-structures'
                group_name = {'military':'军事建筑', 'defense':'城防建筑', 'naval':'海上建筑', 'economy':'经济建筑'}[category(ident if kind == 'Building' else building_id)]
            groups.setdefault(group_key, {'id':group_key, 'name':group_name,
                'category':category(building_id), 'building':f'Building:{building_id}' if building_id in primary else None})
            grid = primary.get(building_id, {}).get('grid', [])
            position = next(((r,c) for r,row in enumerate(grid) for c,v in enumerate(row) if v==raw['id']), (raw.get('row',0),0))
            nodes.append({'key':raw['id'], 'entity':entity_key, 'group':group_key, 'age':int(raw['age_id']),
                'available':available, 'status':raw['node_status'], 'unique':raw['node_type'] in ['UniqueUnit','UniqueTech'],
                'parent':parent, 'icon':icon, 'row':position[0], 'column':position[1]})
        summary = {'id':civ_id, 'name':strings.get(str(civ['name_string_id']),name), 'englishName':name,
            'icon':add_icon('Civs',civ_id), 'description':text(strings.get(str(civ['help_string_id']),''))}
        civs.append(summary)
        (output/'civs'/f'{civ_id}.json').write_text(json.dumps({'id':civ_id, 'groups':list(groups.values()), 'nodes':nodes},ensure_ascii=False,separators=(',',':')),encoding='utf-8')

    for relative in icons:
        target = assets/relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source/'img'/relative,target)
    manifest = {'schemaVersion':1, 'gameVersion':'185872', 'revision':REVISION, 'sourceDate':'2026-09-22',
        'sourceUrl':'https://github.com/SiegeEngineers/aoe2techtree',
        'patchUrl':'https://www.ageofempires.com/news/age-of-empires-ii-definitive-edition-update-185872/',
        'ages':[strings[v] for v in data['age_names']['base']], 'civilizations':civs,
        'counts':{kind:sum(e['type']==kind for e in entities.values()) for kind in ['Unit','Building','Tech']}}
    (output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    (output/'entities.json').write_text(json.dumps(entities,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    shutil.copyfile(source/'LICENSE',output/'LICENSE-aoe2techtree.txt')
    (output/'NOTICE.txt').write_text('Data and icons derived from SiegeEngineers/aoe2techtree, revision '+REVISION+'.\n'+
        'aoe2techtree code: MIT License, Copyright (c) 2018 HSZemi. See LICENSE-aoe2techtree.txt.\n'+
        'Age of Empires II © Microsoft Corporation. Game content remains owned by its respective owners.\n'+
        'Created under Microsoft Game Content Usage Rules: https://www.xbox.com/en-us/developers/rules\n'+
        'Not endorsed by or affiliated with Microsoft.\n',encoding='utf-8')
    print(json.dumps({'civilizations':len(civs),'entities':len(entities),'icons':len(icons),'counts':manifest['counts']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir',type=Path,required=True)
    build(parser.parse_args().source_dir)
