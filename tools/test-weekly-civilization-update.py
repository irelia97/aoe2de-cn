"""Isolated weekly ETL rehearsal; no network or live statistics writes."""
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import duckdb

spec = importlib.util.spec_from_file_location('weekly', Path(__file__).with_name('update-civilization-stats.py'))
weekly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(weekly)


class WeeklyTests(unittest.TestCase):
    def test_schedule_dates_and_skip(self):
        meta = {'dateFrom': '2026-09-23', 'dateTo': '2026-10-24'}
        def at(value): return dt.datetime.fromisoformat(value)
        self.assertEqual(weekly.plan(meta, at('2026-10-26T08:00:00+08:00'))['action'], 'skip_before_first_run')
        self.assertEqual(weekly.plan(meta, at('2026-11-02T07:59:59+08:00'))['action'], 'skip_before_first_run')
        first = weekly.plan(meta, at('2026-11-02T08:00:00+08:00'))
        self.assertEqual(first['action'], 'update')
        self.assertEqual(first['previousWeekFrom'], '2026-10-26')
        self.assertEqual(first['downloadFrom'], '2026-10-25')
        self.assertEqual(first['targetTo'], '2026-11-01')
        next_week = weekly.plan({**meta, 'dateTo': '2026-11-01'}, at('2026-11-09T08:00:00+08:00'))
        self.assertEqual(next_week['downloadFrom'], '2026-11-02')
        self.assertEqual(next_week['targetTo'], '2026-11-08')

    def test_full_pipeline_failure_preserves_live_and_success_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for folder in ['raw', 'reports', 'processed', 'stats', 'work']:
                (root/folder).mkdir()
            pipeline = weekly.module('fixture_pipeline', 'match-data-pipeline.py')
            pipeline.BASE = root
            pipeline.PROGRESS = root/'reports/fixture-progress.json'
            listing = []
            for index, day in enumerate(weekly.dates('2026-10-24', '2026-11-01')):
                con = duckdb.connect()
                con.execute('CREATE TABLE sample(matchId BIGINT,profileId BIGINT,leaderboard VARCHAR,started TIMESTAMP,finished TIMESTAMP,civ VARCHAR,team INTEGER,won BOOLEAN,status VARCHAR,rating DOUBLE,ratingDiff DOUBLE,map VARCHAR,patch INTEGER)')
                start = dt.datetime.fromisoformat(day+'T10:00:00')
                for mode, seats in [('rm_1v1', 2), ('rm_team', 4)]:
                    match_id = index*2 + (1 if mode=='rm_1v1' else 2)
                    rows = []
                    for seat in range(seats):
                        win = seat < seats/2
                        rows.append((match_id, match_id*10+seat, mode, start, start+dt.timedelta(minutes=20),
                                     'mongols' if win else 'chinese', 1 if win else 2, win, 'player', 1500, 5, 'rm_arabia', 1))
                    con.executemany('INSERT INTO sample VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', rows)
                path = root/'raw'/('match-'+day+'.parquet')
                con.execute('COPY sample TO '+pipeline.sql_path(path)+' (FORMAT PARQUET)')
                con.close()
                listing.append({'key': path.name, 'size': path.stat().st_size,
                                'eTag': '"'+hashlib.md5(path.read_bytes()).hexdigest()+'"', 'lastModified': day})
            baseline = root/'processed/baseline'
            con = pipeline.connect(root/'work/baseline.duckdb')
            report = pipeline.clean(con, [root/'raw'/listing[0]['key']], baseline)
            con.close()
            report.update(requestedFrom='2026-10-24', availableTo='2026-10-24')
            builder = weekly.module('fixture_builder', 'build-civilization-stats.py')
            live = root/'stats/civilization-stats.sqlite'
            builder.build(baseline, live, report)
            manifest = {'files': [pipeline.inspect_file(root/'raw'/listing[0]['key'], listing[0])]}
            (root/'reports/download-manifest.json').write_text(json.dumps(manifest))
            # Historical originals are optional once their clean records are durable.
            (root/'raw'/listing[0]['key']).unlink()
            digest = hashlib.sha256(live.read_bytes()).hexdigest()
            no_network = lambda: self.fail('Skipped or idempotent run requested upstream data')
            self.assertEqual(weekly.run(root, dt.datetime(2026,10,26,8,tzinfo=weekly.BEIJING), no_network)['action'], 'skip_before_first_run')
            when = dt.datetime(2026,11,2,8,tzinfo=weekly.BEIJING)
            with self.assertRaisesRegex(RuntimeError, 'not fully published'):
                weekly.run(root, when, lambda: listing[:-1])
            self.assertEqual(hashlib.sha256(live.read_bytes()).hexdigest(), digest)
            real_module = weekly.module
            failing_builder = type('FailingBuilder', (), {'build': staticmethod(lambda *args: (_ for _ in ()).throw(RuntimeError('build failed')))})
            with patch.object(weekly, 'module', side_effect=lambda name, filename: failing_builder if filename=='build-civilization-stats.py' else real_module(name,filename)):
                with self.assertRaisesRegex(RuntimeError, 'build failed'):
                    weekly.run(root, when, lambda: listing)
            self.assertEqual(hashlib.sha256(live.read_bytes()).hexdigest(), digest)
            self.assertEqual(len(json.loads((root/'reports/download-manifest.json').read_text())['files']),1)
            # The new originals are preseeded and verified, so any network call is a test failure.
            with patch('urllib.request.urlopen', side_effect=AssertionError('Unexpected network request')):
                result = weekly.run(root, when, lambda: listing)
            self.assertEqual(result['action'], 'published')
            meta = weekly.read_metadata(live)
            self.assertEqual(meta['dateTo'], '2026-11-01')
            self.assertEqual(meta['modes']['rm_1v1']['games'], 9)
            self.assertEqual(meta['modes']['rm_team']['games'], 9)
            self.assertEqual(meta['updateSchedule']['hour'], 8)
            self.assertEqual(len(meta['datasetChecksums']),4)
            cleaning=json.loads((root/'reports/cleaning-report.json').read_text())
            self.assertEqual(cleaning['processingMode'],'incremental')
            self.assertEqual(cleaning['newDailyFiles'],8)
            self.assertEqual(cleaning['incrementalCleaning']['classifications']['rm_1v1']['matches'],8)
            self.assertEqual(meta['comparison']['dateTo'], '2026-10-24')
            self.assertTrue(live.with_suffix('.previous.sqlite').exists())
            self.assertEqual(weekly.run(root, when, no_network)['action'], 'up_to_date')
            with sqlite3.connect(live) as db:
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
                self.assertEqual(db.execute('SELECT SUM(n) FROM previous_civilization WHERE mode=?',('rm_1v1',)).fetchone()[0],2)
                previous = json.loads(db.execute("SELECT value FROM previous_metadata WHERE key='metadata'").fetchone()[0])
                self.assertEqual(previous['dateTo'],'2026-10-24')
                self.assertEqual(db.execute('SELECT date FROM trend_snapshots ORDER BY date').fetchall(), [('2026-10-24',),('2026-11-01',)])
                self.assertEqual(db.execute("SELECT SUM(n) FROM trend_civilization WHERE snapshot='2026-10-24' AND mode='rm_1v1'").fetchone()[0],2)
                self.assertEqual(db.execute("SELECT SUM(n) FROM trend_civilization WHERE snapshot='2026-11-01' AND mode='rm_1v1'").fetchone()[0],18)
                self.assertEqual(meta['trendSnapshots'],['2026-10-24','2026-11-01'])

    def test_raw_retention_only_unlinks_covered_originals_older_than_four_weeks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'raw').mkdir();(root/'reports').mkdir()
            for day in ['2026-09-23','2026-10-04','2026-10-05','2026-11-01','2026-11-02']:
                (root/'raw'/('match-'+day+'.parquet')).write_bytes(b'fixture')
            (root/'raw/notes.txt').write_text('retain')
            incremental=weekly.module('retention_fixture','incremental-match-data.py')
            result=incremental.prune_raw(root,{'dateFrom':'2026-09-23','dateTo':'2026-11-01'})
            self.assertEqual(result['files'],2);self.assertEqual(result['cutoff'],'2026-10-05')
            self.assertTrue((root/'raw/match-2026-10-05.parquet').exists())
            self.assertTrue((root/'raw/match-2026-11-02.parquet').exists())
            self.assertTrue((root/'raw/notes.txt').exists())
            self.assertEqual(len(json.loads((root/'reports/raw-retention.jsonl').read_text())['removed']),2)

    def test_merge_replaces_whole_overlapping_games_and_preserves_other_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'reports').mkdir()
            for version,ids in [('previous',[1,2]),('batch',[1,3])]:
                for mode,seats in [('rm_1v1',2),('rm_team',4)]:
                    folder=root/version/mode;folder.mkdir(parents=True)
                    con=duckdb.connect()
                    con.execute('CREATE TABLE p(matchId BIGINT,profileId BIGINT,team INTEGER,won BOOLEAN,civ VARCHAR,started TIMESTAMP,finished TIMESTAMP,rating INTEGER)')
                    for mid in ids:
                        for seat in range(seats):
                            own=seat<seats/2
                            winner=own if version=='previous' else not own
                            con.execute("INSERT INTO p VALUES(?,?,?,?,?,'2026-10-24 10:00:00','2026-10-24 10:20:00',1500)",[mid,mid*10+seat,1 if own else 2,winner,'mongols' if own else 'chinese'])
                    con.execute('COPY p TO '+"'"+str(folder/'players.parquet')+"' (FORMAT PARQUET)")
                    con.execute('COPY (SELECT DISTINCT matchId FROM p) TO '+"'"+str(folder/'matches.parquet')+"' (FORMAT PARQUET)")
                    con.close()
            incremental=weekly.module('merge_fixture','incremental-match-data.py')
            result=incremental.merge(root,root/'previous',root/'batch',root/'output')
            self.assertEqual(result['overlappingMatchesReplaced'],{'rm_1v1':1,'rm_team':1})
            self.assertEqual(result['classifications']['rm_1v1']['matches'],3)
            con=duckdb.connect()
            self.assertEqual(con.execute('SELECT won FROM read_parquet(?) WHERE matchId=1 AND profileId=10',[str(root/'output/rm_1v1/players.parquet')]).fetchone()[0],False)
            self.assertEqual(con.execute('SELECT won FROM read_parquet(?) WHERE matchId=2 AND profileId=20',[str(root/'output/rm_1v1/players.parquet')]).fetchone()[0],True)
            con.close()
            source=root/'output/rm_1v1/players.parquet'
            source.write_bytes(source.read_bytes()+b'corrupt')
            with self.assertRaisesRegex(RuntimeError,'checksum mismatch'):
                incremental.verify(root,root/'output',{'datasetChecksums':result['datasetChecksums']})


if __name__ == '__main__':
    unittest.main()
