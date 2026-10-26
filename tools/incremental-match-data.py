"""Merge validated new matches into durable history without historical raw dumps."""
import datetime as dt
import hashlib
import json
from pathlib import Path

import duckdb

MODES = ('rm_1v1', 'rm_team')


def checksum(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while block := stream.read(1024*1024):
            value.update(block)
    return value.hexdigest()


def dataset_path(root, metadata):
    path = Path(metadata.get('datasetPath') or root/'processed'/f"{metadata['dateFrom']}_to_{metadata['dateTo']}")
    if path.is_symlink() or not path.resolve().is_relative_to((root/'processed').resolve()) or not path.is_dir():
        raise RuntimeError('Committed clean history is unavailable or outside processed directory')
    return path


def connection(root):
    con = duckdb.connect()
    con.execute("SET memory_limit='400MB'")
    con.execute('SET threads=1')
    con.execute('SET preserve_insertion_order=false')
    spill=root/'work/incremental-spill'
    spill.mkdir(parents=True,exist_ok=True)
    con.execute("SET temp_directory='"+str(spill).replace("'","''")+"'")
    con.execute("SET max_temp_directory_size='8GB'")
    return con


def verify(root, dataset, metadata=None):
    expected = dict((metadata or {}).get('datasetChecksums') or {})
    try:
        legacy = json.loads((root/'reports/verification-report.json').read_text())
        for mode, entry in legacy['classifications'].items():
            for item in entry['files']:
                if Path(item['path']).parent == dataset/mode:
                    expected.setdefault(mode+'/'+Path(item['path']).name, item['sha256'])
    except FileNotFoundError:
        pass
    result, hashes = {}, {}
    con = connection(root)
    try:
        for mode in MODES:
            for name in ['players.parquet', 'matches.parquet']:
                path = dataset/mode/name
                if path.is_symlink() or not path.is_file():
                    raise RuntimeError('Missing clean history file: '+str(path))
                key = mode+'/'+name
                hashes[key] = checksum(path)
                if key in expected and hashes[key] != expected[key]:
                    raise RuntimeError('Clean history checksum mismatch: '+key)
            players_path = "'"+str(dataset/mode/'players.parquet').replace("'","''")+"'"
            con.execute(f'CREATE OR REPLACE VIEW p AS SELECT * FROM read_parquet({players_path})')
            matches_path = "'"+str(dataset/mode/'matches.parquet').replace("'","''")+"'"
            con.execute(f'CREATE OR REPLACE VIEW m AS SELECT * FROM read_parquet({matches_path})')
            rows, unique_rows, games, people, civs = con.execute('SELECT count(*),count(DISTINCT (matchId,profileId)),count(DISTINCT matchId),count(DISTINCT profileId),count(DISTINCT civ) FROM p').fetchone()
            match_rows, unique_games = con.execute('SELECT count(*),count(DISTINCT matchId) FROM m').fetchone()
            if rows != unique_rows or games != match_rows or games != unique_games:
                raise RuntimeError('Duplicate player or match in clean history')
            if con.execute('SELECT count(*) FROM p WHERE won IS NULL OR started IS NULL OR finished IS NULL OR finished<started OR profileId IS NULL OR profileId<=0 OR civ IS NULL OR trim(civ)=\'\' OR team IS NULL OR team<1').fetchone()[0]:
                raise RuntimeError('Invalid clean history player')
            allowed = '1' if mode=='rm_1v1' else '2,3,4'
            bad = con.execute(f'''WITH sides AS (
                SELECT matchId,team,count(*) n,count_if(won) wins FROM p GROUP BY matchId,team)
                SELECT count(*) FROM (SELECT matchId FROM sides GROUP BY matchId
                  HAVING count(*)<>2 OR min(n)<>max(n) OR min(n) NOT IN ({allowed})
                    OR count_if(wins=n)<>1 OR count_if(wins=0)<>1)''').fetchone()[0]
            if bad:
                raise RuntimeError('Invalid team structure in clean history')
            if metadata and games != metadata['exclusions'][mode]['sourceGames']:
                raise RuntimeError('Clean history counts do not match the committed statistics')
            result[mode] = {'matches': games, 'playerRows': rows, 'uniquePlayers': people, 'civilizations': civs,
                            'playersFile': str(dataset/mode/'players.parquet'), 'matchesFile': str(dataset/mode/'matches.parquet')}
    finally:
        con.close()
    return result, hashes


def merge(root, previous, batch, output):
    output.mkdir(parents=True)
    con = connection(root)
    replacements = {}
    try:
        new_matches = [str(batch/mode/'matches.parquet') for mode in MODES]
        con.execute('CREATE TABLE incoming AS SELECT DISTINCT matchId FROM read_parquet(?)', [new_matches])
        for mode in MODES:
            folder = output/mode
            folder.mkdir()
            replacements[mode] = con.execute('SELECT count(*) FROM read_parquet(?) WHERE matchId IN (SELECT matchId FROM incoming)', [str(previous/mode/'matches.parquet')]).fetchone()[0]
            # Replace whole accepted matches, never combine players from different versions.
            for name in ['players.parquet', 'matches.parquet']:
                con.execute('''CREATE OR REPLACE TABLE merged AS
                    SELECT * FROM read_parquet(?) WHERE matchId NOT IN (SELECT matchId FROM incoming)
                    UNION ALL BY NAME SELECT * FROM read_parquet(?)''', [str(previous/mode/name), str(batch/mode/name)])
                target = "'"+str(folder/name).replace("'", "''")+"'"
                con.execute(f'COPY (SELECT * FROM merged ORDER BY matchId) TO {target} (FORMAT PARQUET, COMPRESSION ZSTD)')
                con.execute('DROP TABLE merged')
    finally:
        con.close()
    classifications, hashes = verify(root, output)
    return {'classifications': classifications, 'datasetChecksums': hashes, 'overlappingMatchesReplaced': replacements}


def prune_raw(root, metadata, retain_days=28):
    import re
    parent = (root/'raw').resolve()
    cutoff = dt.date.fromisoformat(metadata['dateTo']) - dt.timedelta(days=retain_days-1)
    removed = []
    for path in sorted(parent.iterdir()):
        if path.is_symlink() or not path.is_file() or not re.fullmatch(r'match-\d{4}-\d{2}-\d{2}\.parquet',path.name):
            continue
        day = path.name[6:16]
        if metadata['dateFrom'] <= day < str(cutoff):
            if not path.resolve().is_relative_to(parent):
                raise RuntimeError('Unsafe raw retention path')
            removed.append({'filename':path.name,'bytes':path.stat().st_size,'sha256':checksum(path)})
    # Persist the deletion inventory before unlinking any verified, covered original.
    report = {'completedAt':dt.datetime.now(dt.timezone.utc).isoformat(), 'retainDays':retain_days,
              'cutoff':str(cutoff), 'coveredThrough':metadata['dateTo'], 'removed':removed}
    journal = root/'reports/raw-retention.jsonl'
    with journal.open('a',encoding='utf-8') as stream:
        stream.write(json.dumps(report)+'\n')
    for item in removed:
        (parent/item['filename']).unlink()
    return {'files':len(removed),'bytes':sum(item['bytes'] for item in removed),'cutoff':str(cutoff)}
