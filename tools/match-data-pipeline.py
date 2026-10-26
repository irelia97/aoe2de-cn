#!/usr/bin/env python3
"""Download official daily match dumps and export validated ranked RM datasets."""
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import time
import urllib.request

import duckdb

BASE = Path('/var/lib/aoe2-match-data')
START = dt.date(2026, 9, 23)
END = dt.date(2026, 10, 25)
UA = 'https://aoe2cn.cc'
RUN = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
PROGRESS = BASE / 'reports/progress.json'
os.umask(0o027)

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + '.tmp')
    part.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(part, path)

def progress(stage, **kw):
    value = dict(stage=stage, updatedAt=now(), run=RUN, **kw)
    save(PROGRESS, value)
    print(json.dumps(value, ensure_ascii=False), flush=True)

def sql_path(path):
    return "'" + str(path).replace("'", "''") + "'"

def inspect_file(path, item):
    if not path.exists() or path.stat().st_size != item['size']:
        return None
    md5, sha = hashlib.md5(), hashlib.sha256()
    with path.open('rb') as stream:
        if stream.read(4) != b'PAR1':
            return None
        stream.seek(-4, 2)
        if stream.read(4) != b'PAR1':
            return None
        stream.seek(0)
        while block := stream.read(1024 * 1024):
            md5.update(block)
            sha.update(block)
    etag = item.get('eTag', '').strip('"')
    if re.fullmatch(r'[a-fA-F0-9]{32}', etag) and md5.hexdigest().lower() != etag.lower():
        return None
    return dict(filename=item['key'], bytes=item['size'], sha256=sha.hexdigest(),
                md5=md5.hexdigest(), etag=item.get('eTag'), lastModified=item.get('lastModified'),
                etagMd5Checked=bool(re.fullmatch(r'[a-fA-F0-9]{32}', etag)), status='verified')

def download(item):
    key = item['key']
    if not re.fullmatch(r'match-\d{4}-\d{2}-\d{2}\.parquet', key):
        raise ValueError('Unexpected object key')
    target = BASE / 'raw' / key
    existing = inspect_file(target, item)
    if existing:
        return existing
    url = 'https://dump.cdn.aoe2companion.com/' + key
    error = None
    for attempt in range(2):
        part = target.with_name(target.name + '.part')
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Encoding': 'identity',
                                                       'If-Match': item['eTag']})
            with urllib.request.urlopen(req, timeout=40) as response, part.open('wb') as stream:
                size = 0
                while block := response.read(256 * 1024):
                    size += len(block)
                    if size > item['size'] or size > 64 * 1024 * 1024:
                        raise ValueError('Download larger than advertised')
                    stream.write(block)
            result = inspect_file(part, item)
            if not result:
                raise ValueError('Parquet framing, length or checksum mismatch')
            os.replace(part, target)
            return result
        except Exception as exc:
            error = exc
            if attempt == 0:
                time.sleep(2)
    raise RuntimeError(f'{key}: {error}')


def connect(path):
    con = duckdb.connect(str(path))
    con.execute("SET memory_limit='640MB'")
    con.execute('SET threads=1')
    con.execute("SET TimeZone='UTC'")
    con.execute("SET temp_directory=" + sql_path(BASE / 'work/spill'))
    con.execute("SET max_temp_directory_size='8GB'")
    con.execute('SET preserve_insertion_order=false')
    return con


def clean(con, files, output):
    output.mkdir(parents=True, exist_ok=True)
    # Normalize each file before UNION: older dumps expose BLOB text while
    # newer ones have proper UTF-8 VARCHAR. A union before normalization tries
    # to cast non-ASCII VARCHAR into escaped BLOB and fails on player/lobby names.
    decoded_columns = set()
    normalized = []
    for index, file in enumerate(files):
        raw_view = 'raw_part_' + str(index)
        norm_view = 'normalized_part_' + str(index)
        con.from_parquet(str(file), filename=True).create_view(raw_view)
        columns = con.execute('DESCRIBE SELECT * FROM ' + raw_view).fetchall()
        projections = []
        for name, kind, *_ in columns:
            quoted = '\"' + name.replace('\"', '\"\"') + '\"'
            if kind == 'BLOB':
                projections.append('try(decode(' + quoted + ')) AS ' + quoted)
                decoded_columns.add(name)
            else:
                projections.append(quoted)
        con.execute('CREATE VIEW ' + norm_view + ' AS SELECT ' + ','.join(projections) + ' FROM ' + raw_view)
        normalized.append('SELECT * FROM ' + norm_view)
    con.execute('CREATE VIEW raw_data AS ' + ' UNION ALL BY NAME '.join(normalized))
    decoded_columns = sorted(decoded_columns)
    mode_counts = con.execute('SELECT leaderboard, COUNT(*), COUNT(DISTINCT matchId) FROM raw_data GROUP BY leaderboard ORDER BY COUNT(*) DESC').fetchall()
    raw_rows = sum(row[1] for row in mode_counts)
    progress('cleaning', phase='candidate_rows', inputPlayerRows=raw_rows)
    projection = r"""
        SELECT *, lower(trim(leaderboard)) AS _mode,
               try_cast(matchId AS BIGINT) AS _match_id,
               try_cast(profileId AS BIGINT) AS _profile_id,
               try_cast(regexp_extract(filename, 'match-(\d{4}-\d{2}-\d{2})\.parquet$', 1) AS DATE) AS _source_date
        FROM {source} WHERE lower(trim(leaderboard)) IN ('rm_1v1','rm_team')
    """
    # Bind the union schema without loading rows, then import one daily file at
    # a time so wide Parquet decoding cannot pin 32 independent read pipelines.
    con.execute('CREATE TABLE candidate_rows AS ' + projection.replace('{source}','raw_data') + ' LIMIT 0')
    for index in range(len(files)):
        con.execute('INSERT INTO candidate_rows BY NAME ' + projection.replace('{source}','normalized_part_'+str(index)))
        con.execute('CHECKPOINT')
        progress('cleaning',phase='normalized_day',daysImported=index+1,daysTotal=len(files))
    candidates = con.execute('SELECT COUNT(*) FROM candidate_rows').fetchone()[0]
    con.execute("""
        CREATE TABLE duplicate_conflicts AS
        SELECT DISTINCT _match_id FROM (
            SELECT _match_id, _profile_id FROM candidate_rows GROUP BY _match_id,_profile_id
            HAVING MIN(won)<>MAX(won) OR MIN(lower(trim(civ)))<>MAX(lower(trim(civ)))
                OR MIN(team)<>MAX(team) OR MIN(_mode)<>MAX(_mode)
        )
    """)
    con.execute("""
        CREATE TABLE deduplicated AS SELECT * FROM candidate_rows
        QUALIFY ROW_NUMBER() OVER (
            PARTITION BY _match_id,_profile_id
            ORDER BY (won IS NOT NULL) DESC, finished DESC NULLS LAST,
                     _source_date DESC NULLS LAST, filename DESC,
                     civ DESC NULLS LAST, team DESC NULLS LAST
        )=1
    """)
    dedup_rows = con.execute('SELECT COUNT(*) FROM deduplicated').fetchone()[0]
    progress('cleaning', phase='validate_matches', candidatePlayerRows=candidates,
             deduplicatedPlayerRows=dedup_rows, duplicatePlayerRowsRemoved=candidates-dedup_rows)
    con.execute("""
        CREATE TABLE sides AS
        SELECT _match_id,team,COUNT(*) AS n,COUNT_IF(won=TRUE) AS wins,COUNT_IF(won=FALSE) AS losses
        FROM deduplicated WHERE team IS NOT NULL GROUP BY _match_id,team
    """)
    con.execute("""
        CREATE TABLE side_checks AS SELECT _match_id,COUNT(*) AS side_count,
            MIN(n) AS min_size,MAX(n) AS max_size,
            COUNT_IF(wins=n) AS winning_sides,COUNT_IF(losses=n) AS losing_sides
        FROM sides GROUP BY _match_id
    """)
    con.execute("""
        CREATE TABLE game_checks AS
        WITH grouped AS (
            SELECT _match_id,MIN(_mode) AS mode,COUNT(*) AS player_count,
                COUNT(DISTINCT _mode) AS modes,
                BOOL_OR(_match_id IS NULL OR _match_id<=0 OR _profile_id IS NULL OR _profile_id<=0
                    OR coalesce(lower(trim(status)),'')<>'player') AS bad_player,
                BOOL_OR(started IS NULL OR finished IS NULL OR finished<started) AS bad_time,
                BOOL_OR(won IS NULL) AS missing_outcome,
                BOOL_OR(civ IS NULL OR lower(trim(civ)) IN ('','unknown','none','null','gaia','random','full_random')) AS bad_civ,
                BOOL_OR(team IS NULL OR team<1) AS bad_team
            FROM deduplicated GROUP BY _match_id
        )
        SELECT g.*,s.side_count,s.min_size,s.max_size,s.winning_sides,s.losing_sides,
          CASE
            WHEN bad_player THEN 'invalid_player_or_match_id'
            WHEN bad_time THEN 'unfinished_or_invalid_time'
            WHEN missing_outcome THEN 'missing_outcome'
            WHEN bad_civ THEN 'missing_or_unresolved_civilization'
            WHEN bad_team OR coalesce(side_count,0)<>2 THEN 'invalid_teams'
            WHEN modes<>1 THEN 'inconsistent_ladder'
            WHEN g._match_id IN (SELECT _match_id FROM duplicate_conflicts) THEN 'conflicting_duplicate_player'
            WHEN mode='rm_1v1' AND (player_count<>2 OR min_size<>1 OR max_size<>1) THEN 'invalid_1v1_structure'
            WHEN mode='rm_team' AND (player_count NOT IN (4,6,8) OR min_size<>max_size OR min_size NOT IN (2,3,4)) THEN 'invalid_team_structure'
            WHEN winning_sides<>1 OR losing_sides<>1 THEN 'inconsistent_team_outcomes'
            ELSE 'accepted'
          END AS reason
        FROM grouped g LEFT JOIN side_checks s ON g._match_id=s._match_id
    """)
    results = {}
    for mode in ('rm_1v1','rm_team'):
        folder = output / mode
        folder.mkdir(exist_ok=True)
        # Retain all upstream columns, adding source_date. Only optional invalid
        # ratings become NULL; no missing score is invented as zero.
        query = f"""
            SELECT p.* EXCLUDE(filename,_mode,_match_id,_profile_id,_source_date,civ,rating,ratingDiff),
                lower(trim(p.civ)) AS civ,
                CASE WHEN isfinite(p.rating) AND p.rating>=0 THEN p.rating ELSE NULL END AS rating,
                CASE WHEN isfinite(p.ratingDiff) THEN p.ratingDiff ELSE NULL END AS ratingDiff,
                p._source_date AS source_date
            FROM deduplicated p JOIN game_checks g ON p._match_id=g._match_id
            WHERE g.reason='accepted' AND g.mode='{mode}'
        """
        con.execute(f'CREATE TABLE clean_{mode} AS '+query)
        con.execute(f"COPY (SELECT * FROM clean_{mode} ORDER BY matchId,team,profileId) TO {sql_path(folder/'players.parquet')} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)")
        con.execute(f"""
            CREATE TABLE matches_{mode} AS
            SELECT matchId,MIN(leaderboard) AS leaderboard,MIN(started) AS started,MAX(finished) AS finished,
                date_diff('second',MIN(started),MAX(finished)) AS duration_seconds,
                MIN(map) AS map,MIN(patch) AS patch,COUNT(*) AS num_players,
                COUNT(DISTINCT team) AS num_teams,AVG(rating) AS avg_rating,
                MAX(source_date) AS source_date
            FROM clean_{mode} GROUP BY matchId
        """)
        con.execute(f"COPY (SELECT * FROM matches_{mode} ORDER BY started,matchId) TO {sql_path(folder/'matches.parquet')} (FORMAT PARQUET, COMPRESSION ZSTD)")
        row_count, games, people, civs = con.execute(f'SELECT COUNT(*),COUNT(DISTINCT matchId),COUNT(DISTINCT profileId),COUNT(DISTINCT civ) FROM clean_{mode}').fetchone()
        time_range = con.execute(f'SELECT MIN(started),MAX(started) FROM clean_{mode}').fetchone()
        structures = con.execute(f'SELECT num_players,COUNT(*) FROM matches_{mode} GROUP BY num_players ORDER BY num_players').fetchall()
        # Validate exports by reopening Parquet, rather than trusting COPY alone.
        export_rows, export_games = con.execute('SELECT COUNT(*),COUNT(DISTINCT matchId) FROM read_parquet(?)',[str(folder/'players.parquet')]).fetchone()
        if export_rows != row_count or export_games != games:
            raise RuntimeError('Export readback count mismatch')
        match_export = con.execute('SELECT COUNT(*) FROM read_parquet(?)',[str(folder/'matches.parquet')]).fetchone()[0]
        if match_export != games:
            raise RuntimeError('Match export count mismatch')
        results[mode] = dict(playerRows=row_count,matches=games,uniquePlayers=people,civilizations=civs,
                            startedRangeUTC=[str(v) for v in time_range],playersPerMatch=dict(structures),
                            playersFile=str(folder/'players.parquet'),matchesFile=str(folder/'matches.parquet'))
        progress('cleaning',phase='exported',mode=mode,playerRows=row_count,matches=games)
    rejections = con.execute("SELECT mode,reason,COUNT(*) AS matches,SUM(player_count) AS player_rows FROM game_checks GROUP BY mode,reason ORDER BY mode,reason").fetchall()
    con.execute(f"COPY (SELECT _match_id AS matchId,mode,reason,player_count FROM game_checks WHERE reason<>'accepted' ORDER BY mode,reason,matchId) TO {sql_path(output/'rejected_matches.csv')} (HEADER, DELIMITER ',')")
    if con.execute("SELECT COUNT(*) FROM game_checks WHERE reason='accepted'").fetchone()[0] != sum(v['matches'] for v in results.values()):
        raise RuntimeError('Accepted game accounting mismatch')
    return dict(decodedTextColumns=decoded_columns,inputPlayerRows=raw_rows,inputModes=[dict(mode=m,playerRows=n,matches=g) for m,n,g in mode_counts],
                candidatePlayerRows=candidates,deduplicatedPlayerRows=dedup_rows,
                duplicatePlayerRowsRemoved=candidates-dedup_rows,
                conflictingDuplicateMatches=con.execute('SELECT COUNT(*) FROM duplicate_conflicts').fetchone()[0],
                classifications=results,
                validationCounts=[dict(mode=m,reason=r,matches=n,playerRows=p) for m,r,n,p in rejections])


def self_test():
    with tempfile.TemporaryDirectory(prefix='validation-',dir=BASE/'work') as temp:
        folder = Path(temp)
        con = connect(folder/'test.duckdb')
        con.execute('CREATE TABLE sample(matchId BIGINT,profileId BIGINT,leaderboard VARCHAR,started TIMESTAMP,finished TIMESTAMP,civ VARCHAR,team INTEGER,won BOOLEAN,status VARCHAR,rating DOUBLE,ratingDiff DOUBLE,map VARCHAR,patch INTEGER)')
        rows=[]
        begin=dt.datetime(2026,9,23,10);end=begin+dt.timedelta(minutes=30)
        def add(game,mode,teams,outcomes,civs=None,finish=end):
            for i,(team,won) in enumerate(zip(teams,outcomes)):
                rows.append((game,game*10+i,mode,begin,finish,(civs or ['mongols']*len(teams))[i],team,won,'player',1500.,5.,'arabia',1))
        add(1,'rm_1v1',[1,2],[True,False]);rows.append(rows[0])
        add(2,'rm_1v1',[1,2],[None,False])
        add(3,'rm_team',[1,1,2,2],[True,True,False,False])
        add(4,'rm_team',[1,1,1,2],[True,True,True,False])
        add(5,'rm_team',[1,1,2,2],[True,False,False,False])
        add(6,'ew_1v1',[1,2],[True,False])
        add(7,'rm_1v1',[1,2],[True,False],finish=begin-dt.timedelta(seconds=1))
        add(8,'rm_1v1',[1,2],[True,False],civs=['','mongols'])
        add(9,'rm_1v1',[1,2],[True,False]);r=list(rows[-1]);r[5]='aztecs';rows.append(tuple(r))
        con.executemany('INSERT INTO sample VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',rows)
        con.execute("UPDATE sample SET map='Sebastián'")
        path=folder/'match-2026-09-23.parquet';con.execute('COPY sample TO '+sql_path(path)+' (FORMAT PARQUET)')
        path2=folder/'match-2026-09-24.parquet'
        con.execute('COPY (SELECT * REPLACE(matchId+1000 AS matchId,profileId+10000 AS profileId,encode(leaderboard) AS leaderboard,encode(civ) AS civ,encode(status) AS status,encode(map) AS map) FROM sample) TO '+sql_path(path2)+' (FORMAT PARQUET)')
        result=clean(con,[path,path2],folder/'result')
        assert result['classifications']['rm_1v1']['matches']==2,result
        assert result['classifications']['rm_team']['matches']==2,result
        assert result['duplicatePlayerRowsRemoved']==4,result
        assert result['conflictingDuplicateMatches']==2,result
        con.close()
    progress('self_test_passed')


if __name__ == '__main__':
    if '--self-test' in sys.argv:
        self_test()
    else:
        raise SystemExit('Use tools/update-civilization-stats.py for scheduled imports')
