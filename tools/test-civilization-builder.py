"""Run with the server's isolated DuckDB Python environment; no upstream calls."""
import importlib.util
import json
from collections import Counter
from pathlib import Path
import sqlite3
import tempfile
import unittest

import duckdb

spec = importlib.util.spec_from_file_location('builder', Path(__file__).with_name('build-civilization-stats.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BuilderTests(unittest.TestCase):
    def test_all_published_history_survives_and_legacy_snapshot_is_imported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def cube(path, date, civ=1, map_id=1):
                meta = {'dateFrom':'2026-09-23','dateTo':date,'generatedAt':date,
                        'ratings':[], 'durations':[],
                        'civs':[{'id':civ,'slug':'mongols'}], 'maps':[{'id':map_id,'slug':'rm_arabia'}]}
                db = sqlite3.connect(path)
                db.executescript('CREATE TABLE metadata(key TEXT,value TEXT); CREATE TABLE civilization(mode,civ,map,elo,duration,n,w); CREATE TABLE matchup(mode,civ,map,elo,duration,opponent,n,w,games);')
                db.execute('INSERT INTO metadata VALUES (?,?)', ('metadata', json.dumps(meta)))
                db.execute('INSERT INTO civilization VALUES (?,?,?,?,?,?,?)', ('rm_1v1',civ,map_id,3,2,4,2))
                db.execute('INSERT INTO matchup VALUES (?,?,?,?,?,?,?,?,?)', ('rm_1v1',civ,map_id,3,2,civ,4,2,2))
                return db, meta
            previous = root/'previous.sqlite'
            db, meta = cube(previous,'2026-10-17',42,9)
            builder.record_trend_snapshot(db,dict(meta,dateTo='2026-10-10'))
            builder.record_trend_snapshot(db,meta)
            db.commit();db.close()
            for legacy in [False,True]:
                staged = root/f'staged-{legacy}.sqlite'
                db, meta = cube(staged,'2026-10-24')
                builder.record_trend_snapshot(db,meta)
                db.execute('ATTACH DATABASE ? AS prior',(str(previous),))
                for name in ['civilization','matchup']:
                    db.execute(f'CREATE TABLE previous_{name} AS SELECT * FROM prior.{name}')
                db.commit();db.close()
                if legacy:
                    with sqlite3.connect(previous) as old:
                        for name in ['trend_snapshots','trend_civilization','trend_matchup']:
                            old.execute(f'DROP TABLE {name}')
                builder.inherit_trend_history(staged,previous)
                builder.inherit_trend_history(staged,previous)
                with sqlite3.connect(staged) as check:
                    dates=[row[0] for row in check.execute('SELECT date FROM trend_snapshots ORDER BY date')]
                    self.assertEqual(dates,['2026-10-17','2026-10-24'] if legacy else ['2026-10-10','2026-10-17','2026-10-24'])
                    self.assertEqual(check.execute('SELECT DISTINCT civ,map FROM trend_civilization').fetchall(),[('mongols','rm_arabia')])
                    self.assertEqual(check.execute('SELECT SUM(n) FROM trend_civilization').fetchone()[0],4*len(dates))

    def test_exclusions_and_exact_rating_duration_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = {'requestedFrom': '2026-09-23', 'availableTo': '2026-10-24', 'classifications': {}}
            ratings = [1099, 1100, 1399, 1400, 1699, 1700, 1949, 1950, 2149, 2150, 2399, 2400, 2500]
            seconds = [600, 1199, 1200, 2099, 2100, 2999, 3000]
            expected_counts = {}
            for mode, seats in [('rm_1v1', 2), ('rm_team', 4)]:
                folder = root / mode
                folder.mkdir()
                con = duckdb.connect()
                con.execute('CREATE TABLE players(matchId BIGINT,team INTEGER,civ VARCHAR,won BOOLEAN,rating DOUBLE,map VARCHAR)')
                con.execute('CREATE TABLE matches(matchId BIGINT,map VARCHAR,duration_seconds DOUBLE)')
                mode_ratings = ratings if mode == 'rm_1v1' else [1099, 1100, 1399, 1400, 1649, 1650, 1849, 1850, 2000]
                cases = [(rating, seconds[index % len(seconds)], 'rm_arabia') for index, rating in enumerate(mode_ratings)]
                expected_counts[mode] = (len(cases), dict(Counter(1 if duration<1200 else 2 if duration<2100 else 3 if duration<3000 else 4 for _,duration,_ in cases)))
                cases += [(1500,300,'rm_arabia'),(1500,599,'rm_arabia')]
                cases += [(1500, 1200, 'unknown'), (None, 1200, 'rm_arabia'), (1500, 299, 'rm_arabia'), (1500, 1200, '')]
                for mid, (rating, duration, map_name) in enumerate(cases, 1):
                    con.execute('INSERT INTO matches VALUES(?,?,?)', [mid, map_name, duration / 1.7])
                    for index in range(seats):
                        win = index < seats / 2
                        # A single missing participant rating excludes the whole match.
                        score = None if rating is None and index == 0 else rating if rating is not None else 1500
                        con.execute('INSERT INTO players VALUES(?,?,?,?,?,?)', [mid, 1 if win else 2, 'mongols' if win else 'franks', win, score, map_name])
                for table in ['players', 'matches']:
                    con.execute(f"COPY {table} TO '{folder / (table + '.parquet')}' (FORMAT PARQUET)")
                con.close()
                report['classifications'][mode] = {'matches': len(cases), 'playerRows': len(cases) * seats}
            output = root / 'stats.sqlite'
            builder.build(root, output, report)
            db = sqlite3.connect(output)
            metadata = json.loads(db.execute('SELECT value FROM metadata').fetchone()[0])
            self.assertNotIn('unknown', [row[0] for row in db.execute('SELECT slug FROM maps')])
            for mode, seats in [('rm_1v1', 2), ('rm_team', 4)]:
                self.assertEqual(metadata['modes'][mode], {'games': expected_counts[mode][0], 'players': expected_counts[mode][0] * seats})
                self.assertEqual(metadata['exclusions'][mode]['excludedGames'], 6)
                self.assertEqual(dict(db.execute('SELECT elo,SUM(n) FROM games WHERE mode=? GROUP BY elo', [mode])), ({0: 1, 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2} if mode=='rm_1v1' else {0: 1, 1: 2, 2: 2, 3: 2, 4: 2}))
                self.assertEqual(dict(db.execute('SELECT duration,SUM(n) FROM games WHERE mode=? GROUP BY duration', [mode])), expected_counts[mode][1])
                for history, total in [('trend_civilization','civilization'),('trend_matchup','matchup')]:
                    self.assertEqual(db.execute(f'SELECT SUM(n),SUM(w) FROM {history} WHERE mode=?', [mode]).fetchone(), db.execute(f'SELECT SUM(n),SUM(w) FROM {total} WHERE mode=?', [mode]).fetchone())
                self.assertEqual(db.execute('SELECT date FROM trend_snapshots').fetchall(), [('2026-10-24',)])
            db.close()


if __name__ == '__main__':
    unittest.main()
