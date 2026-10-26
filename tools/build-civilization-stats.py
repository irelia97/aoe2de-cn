"""Build a read-only statistics cube; never query raw games from web requests."""
import argparse
import datetime
import json
import os
from pathlib import Path
import sqlite3
import tempfile

import duckdb

RATINGS = [(0, '1100以下'), (1, '1100~1399'), (2, '1400~1699'),
           (3, '1700~1949'), (4, '1950~2149'), (5, '2150~2399'), (6, '2400以上')]
TEAM_RATINGS = [(0, '1100以下'), (1, '1100~1399'), (2, '1400~1649'),
                (3, '1650~1849'), (4, '1850以上')]
DURATIONS = [(1, '10~20分钟'), (2, '20~35分钟'),
             (3, '35~50分钟'), (4, '50分钟以上')]


def quoted(path):
    return "'" + str(path).replace("'", "''") + "'"


def record_trend_snapshot(db, metadata, prefix=''):
    """Keep published cumulative cubes, including their dimension vocabulary."""
    if prefix not in ('', 'previous_'):
        raise ValueError('Invalid snapshot source')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS trend_snapshots(date TEXT PRIMARY KEY,generated_at TEXT,rules TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trend_civilization(snapshot TEXT,mode TEXT,civ TEXT,map TEXT,elo INTEGER,duration INTEGER,n INTEGER,w INTEGER,
        PRIMARY KEY(mode,civ,snapshot,map,elo,duration)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS trend_matchup(snapshot TEXT,mode TEXT,civ TEXT,map TEXT,elo INTEGER,duration INTEGER,opponent TEXT,n INTEGER,w INTEGER,games INTEGER,
        PRIMARY KEY(mode,civ,snapshot,map,elo,duration,opponent)) WITHOUT ROWID;
    ''')
    date = metadata['dateTo']
    if db.execute('SELECT 1 FROM trend_snapshots WHERE date=?', (date,)).fetchone():
        return
    db.execute('CREATE TEMP TABLE IF NOT EXISTS trend_civs(id INTEGER PRIMARY KEY,slug TEXT)')
    db.execute('CREATE TEMP TABLE IF NOT EXISTS trend_maps(id INTEGER PRIMARY KEY,slug TEXT)')
    for name, items in [('trend_civs', metadata['civs']), ('trend_maps', metadata['maps'])]:
        db.execute(f'DELETE FROM {name}')
        db.executemany(f'INSERT INTO {name} VALUES (?,?)', [(item['id'], item['slug']) for item in items])
    rules = {'ratingsByMode': {mode: metadata.get('ratingsByMode', {}).get(mode, metadata.get('ratings'))
                              for mode in ('rm_1v1', 'rm_team')}, 'durations': metadata.get('durations'),
             'dateFrom': metadata['dateFrom']}
    db.execute('INSERT INTO trend_snapshots VALUES (?,?,?)', (date, metadata.get('generatedAt'), json.dumps(rules)))
    db.execute(f'''INSERT INTO trend_civilization
      SELECT ?,a.mode,c.slug,m.slug,a.elo,a.duration,a.n,a.w FROM {prefix}civilization a
      JOIN trend_civs c ON c.id=a.civ JOIN trend_maps m ON m.id=a.map''', (date,))
    db.execute(f'''INSERT INTO trend_matchup
      SELECT ?,a.mode,c.slug,m.slug,a.elo,a.duration,o.slug,a.n,a.w,a.games FROM {prefix}matchup a
      JOIN trend_civs c ON c.id=a.civ JOIN trend_maps m ON m.id=a.map JOIN trend_civs o ON o.id=a.opponent''', (date,))


def inherit_trend_history(staged, previous):
    """Retain every published snapshot when the next weekly cube replaces it."""
    with sqlite3.connect(staged) as db:
        db.execute('ATTACH DATABASE ? AS prior', (str(previous),))
        if db.execute("SELECT 1 FROM prior.sqlite_master WHERE name='trend_snapshots'").fetchone():
            for table in ('trend_snapshots', 'trend_civilization', 'trend_matchup'):
                db.execute(f'INSERT OR IGNORE INTO {table} SELECT * FROM prior.{table}')
        else:
            # Upgrades from a legacy cube still preserve its published snapshot.
            with sqlite3.connect(previous) as source:
                meta = json.loads(source.execute("SELECT value FROM metadata WHERE key='metadata'").fetchone()[0])
            record_trend_snapshot(db, meta, 'previous_')
        meta = json.loads(db.execute("SELECT value FROM metadata WHERE key='metadata'").fetchone()[0])
        meta['trendSnapshots'] = [row[0] for row in db.execute('SELECT date FROM trend_snapshots ORDER BY date')]
        db.execute("UPDATE metadata SET value=? WHERE key='metadata'", (json.dumps(meta, ensure_ascii=False),))


def build(dataset, output, report):
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + '.building')
    if temporary.exists():
        temporary.unlink()
    work = output.with_name(output.name + '.work.duckdb')
    if work.exists():
        work.unlink()
    con = duckdb.connect(str(work))
    con.execute("SET memory_limit='640MB'")
    con.execute('SET threads=1')
    con.execute('SET preserve_insertion_order=false')
    db = sqlite3.connect(temporary)
    db.execute('PRAGMA journal_mode=OFF')
    db.execute('PRAGMA synchronous=OFF')
    db.executescript('''
      CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE civs(id INTEGER PRIMARY KEY,slug TEXT UNIQUE NOT NULL);
      CREATE TABLE maps(id INTEGER PRIMARY KEY,slug TEXT UNIQUE NOT NULL);
      CREATE TABLE games(mode TEXT,map INTEGER,elo INTEGER,duration INTEGER,n INTEGER,
        PRIMARY KEY(mode,map,elo,duration)) WITHOUT ROWID;
      CREATE TABLE civilization(mode TEXT,civ INTEGER,map INTEGER,elo INTEGER,duration INTEGER,n INTEGER,w INTEGER,
        PRIMARY KEY(mode,civ,map,elo,duration)) WITHOUT ROWID;
      CREATE TABLE matchup(mode TEXT,civ INTEGER,map INTEGER,elo INTEGER,duration INTEGER,opponent INTEGER,n INTEGER,w INTEGER,games INTEGER,
        PRIMARY KEY(mode,civ,map,elo,duration,opponent)) WITHOUT ROWID;
    ''')
    files = [dataset / mode / 'players.parquet' for mode in ('rm_1v1', 'rm_team')]
    civs = [r[0] for r in con.execute('SELECT DISTINCT civ FROM read_parquet(?) ORDER BY civ', [[str(p) for p in files]]).fetchall()]
    maps = [r[0] for r in con.execute("SELECT DISTINCT map FROM read_parquet(?) WHERE map IS NOT NULL AND trim(map)<>'' AND lower(trim(map)) NOT IN ('unknown','unknow') ORDER BY 1", [[str(p) for p in files]]).fetchall()]
    civ_rows = [(i+1, slug) for i, slug in enumerate(civs)]
    map_rows = [(i+1, slug) for i, slug in enumerate(maps)]
    for name, rows in [('civs', civ_rows), ('maps', map_rows)]:
        db.executemany(f'INSERT INTO {name} VALUES (?,?)', rows)
        con.execute(f'CREATE TABLE {name}(id INTEGER,slug VARCHAR)')
        con.executemany(f'INSERT INTO {name} VALUES (?,?)', rows)

    def export(query, table, count):
        cursor = con.execute(query)
        total = 0
        while batch := cursor.fetchmany(4000):
            db.executemany(f'INSERT INTO {table} VALUES ({",".join("?" for _ in range(count))})', batch)
            total += len(batch)
        db.commit()
        return total

    sizes, included, exclusions = {}, {}, {}
    for mode in ('rm_1v1', 'rm_team'):
        print(json.dumps({'stage': 'build', 'mode': mode}), flush=True)
        players = dataset / mode / 'players.parquet'
        matches = dataset / mode / 'matches.parquet'
        con.execute(f'''CREATE OR REPLACE TABLE p AS
          SELECT p.matchId,p.team,c.id AS civ,p.won,p.rating
          FROM read_parquet({quoted(players)}) p JOIN civs c ON c.slug=p.civ''')
        edges = [1100, 1400, 1650, 1850] if mode == 'rm_team' else [1100, 1400, 1700, 1950, 2150, 2400]
        rating_case = 'CASE ' + ' '.join(f'WHEN r.elo<{edge} THEN {index}' for index, edge in enumerate(edges)) + f' ELSE {len(edges)} END'
        con.execute(f'''CREATE OR REPLACE TABLE g AS
          WITH ratings AS (SELECT matchId,
            CASE WHEN COUNT(rating)=COUNT(*) THEN AVG(rating) ELSE NULL END AS elo
            FROM p GROUP BY matchId)
          SELECT m.matchId,dim.id AS map,
            {rating_case} AS elo,
            CASE WHEN m.duration_seconds*1.7<1200 THEN 1
              WHEN m.duration_seconds*1.7<2100 THEN 2 WHEN m.duration_seconds*1.7<3000 THEN 3
              ELSE 4 END AS duration
          FROM read_parquet({quoted(matches)}) m JOIN ratings r USING(matchId)
          JOIN maps dim ON dim.slug=m.map
          WHERE r.elo IS NOT NULL AND m.duration_seconds*1.7>=600''')
        expected = report['classifications'][mode]['matches']
        source_count = con.execute(f'SELECT COUNT(*) FROM read_parquet({quoted(matches)})').fetchone()[0]
        if expected != source_count:
            raise ValueError('Source game count differs from cleaning report')
        actual = con.execute('SELECT COUNT(*) FROM g').fetchone()[0]
        player_count = con.execute('SELECT COUNT(*) FROM p JOIN g USING(matchId)').fetchone()[0]
        included[mode] = {'games': actual, 'players': player_count}
        exclusions[mode] = {'sourceGames': source_count, 'excludedGames': source_count-actual}
        sizes[mode] = {'games': export(f"SELECT '{mode}',map,elo,duration,COUNT(*) FROM g GROUP BY map,elo,duration", 'games', 5)}
        sizes[mode]['civilization'] = export(f'''
          SELECT '{mode}',p.civ,g.map,g.elo,g.duration,COUNT(*),SUM(CASE WHEN p.won THEN 1 ELSE 0 END)
          FROM p JOIN g USING(matchId) GROUP BY p.civ,g.map,g.elo,g.duration''', 'civilization', 7)
        # Repeated teammates with the same civ do not multiply matchup samples.
        # A mirror can have one observation per side, with a combined 50% rate.
        con.execute('CREATE OR REPLACE TABLE sides AS SELECT DISTINCT matchId,team,civ,won FROM p')
        con.execute('''CREATE OR REPLACE TABLE pairs AS
          SELECT a.matchId,a.civ,b.civ AS opponent,COUNT(*) AS n,
            SUM(CASE WHEN a.won THEN 1 ELSE 0 END) AS w
          FROM sides a JOIN sides b ON a.matchId=b.matchId AND a.team<>b.team
          GROUP BY a.matchId,a.civ,b.civ''')
        sizes[mode]['matchup'] = export(f'''
          SELECT '{mode}',a.civ,g.map,g.elo,g.duration,a.opponent,SUM(a.n),SUM(a.w),COUNT(*)
          FROM pairs a JOIN g USING(matchId)
          GROUP BY a.civ,g.map,g.elo,g.duration,a.opponent''', 'matchup', 9)
        print(json.dumps({'stage': 'exported', 'mode': mode, 'cells': sizes[mode]}), flush=True)
        con.execute('CHECKPOINT')
    metadata = {
        'version': 6, 'trendGranularity': 'weekly_cumulative', 'trendSnapshots': [report['availableTo']],
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'dateFrom': report['requestedFrom'], 'dateTo': report['availableTo'],
        'source': 'AoE2 Companion Daily Matches',
        'updateSchedule': report.get('updateSchedule'), 'datasetPath': str(dataset),
        'datasetChecksums': report.get('datasetChecksums'),
        'modes': included, 'exclusions': exclusions, 'minimumGameSeconds': 600,
        'civs': [{'id': i, 'slug': s} for i, s in civ_rows],
        'maps': [{'id': i, 'slug': s} for i, s in map_rows],
        'ratings': [{'id': i, 'label': label} for i, label in RATINGS],
        'ratingsByMode': {mode: [{'id': i, 'label': label} for i, label in bands]
                          for mode, bands in [('rm_1v1', RATINGS), ('rm_team', TEAM_RATINGS)]},
        'durations': [{'id': i, 'label': label} for i, label in DURATIONS],
        'durationFormula': '(finished-started)*1.7', 'cellCounts': sizes,
    }
    db.execute('INSERT INTO metadata VALUES (?,?)', ('metadata', json.dumps(metadata, ensure_ascii=False)))
    for mode, data in metadata['modes'].items():
        games = db.execute('SELECT SUM(n) FROM games WHERE mode=?', (mode,)).fetchone()[0]
        n, w = db.execute('SELECT SUM(n),SUM(w) FROM civilization WHERE mode=?', (mode,)).fetchone()
        if games != data['games'] or n != data['players'] or n != w*2:
            raise ValueError('Aggregate counts or wins/losses do not reconcile')
    record_trend_snapshot(db, metadata)
    db.commit()
    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise ValueError('SQLite integrity check failed')
    db.close()
    con.close()
    os.chmod(temporary, 0o640)
    if os.name != 'nt':
        import grp
        os.chown(temporary, 0, grp.getgrnam('aoe2').gr_gid)
        os.chown(output.parent, 0, grp.getgrnam('aoe2').gr_gid)
        os.chmod(output.parent, 0o750)
    os.replace(temporary, output)
    work.unlink(missing_ok=True)
    print(json.dumps({'stage': 'complete', 'path': str(output), 'bytes': output.stat().st_size}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset', type=Path, default=Path('/var/lib/aoe2-match-data/processed/2026-09-23_to_2026-10-24'))
    parser.add_argument('--output', type=Path, default=Path('/var/lib/aoe2-match-data/stats/civilization-stats.sqlite'))
    parser.add_argument('--report', type=Path, default=Path('/var/lib/aoe2-match-data/reports/cleaning-report.json'))
    args = parser.parse_args()
    build(args.dataset, args.output, json.loads(args.report.read_text()))
