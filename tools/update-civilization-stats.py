#!/usr/bin/env python3
"""Server-only weekly ETL; publish one validated SQLite snapshot atomically."""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import urllib.request
from zoneinfo import ZoneInfo

BEIJING = ZoneInfo('Asia/Shanghai')
FIRST_RUN = dt.datetime(2026, 11, 2, 8, tzinfo=BEIJING)
ROOT = Path('/var/lib/aoe2-match-data')


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def read_metadata(path):
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
        return json.loads(db.execute("SELECT value FROM metadata WHERE key='metadata'").fetchone()[0])


def embed_previous_snapshot(staged, live):
    # Bundle both snapshots into one atomic publication; never mix date versions.
    with sqlite3.connect(staged, uri=True) as db:
        db.execute('ATTACH DATABASE ? AS old', (f'file:{live}?mode=ro',))
        for name in ['metadata', 'civilization', 'matchup']:
            db.execute(f'CREATE TABLE previous_{name} AS SELECT * FROM old.{name}')
        db.execute('CREATE INDEX previous_civilization_filter ON previous_civilization(mode,map,elo,duration,civ)')
        db.execute('CREATE INDEX previous_matchup_filter ON previous_matchup(mode,civ,map,elo,duration,opponent)')
        previous = json.loads(db.execute("SELECT value FROM previous_metadata WHERE key='metadata'").fetchone()[0])
        current = json.loads(db.execute("SELECT value FROM metadata WHERE key='metadata'").fetchone()[0])
        current['comparison'] = {key: previous[key] for key in ['dateFrom', 'dateTo', 'generatedAt']}
        db.execute("UPDATE metadata SET value=? WHERE key='metadata'", (json.dumps(current, ensure_ascii=False),))


def plan(metadata, when):
    when = when.astimezone(BEIJING)
    monday = when.date() - dt.timedelta(days=when.weekday())
    end = monday - dt.timedelta(days=1)
    start = dt.date.fromisoformat(metadata['dateTo']) + dt.timedelta(days=1)
    action = 'skip_before_first_run' if when < FIRST_RUN else 'up_to_date' if start > end else 'update'
    return {'action': action, 'firstRun': FIRST_RUN.isoformat(), 'timezone': 'Asia/Shanghai',
            'previousWeekFrom': str(monday-dt.timedelta(days=7)), 'targetTo': str(end),
            'downloadFrom': str(start), 'dateFrom': metadata['dateFrom'], 'currentTo': metadata['dateTo']}


def dates(start, end):
    day = dt.date.fromisoformat(start)
    end = dt.date.fromisoformat(end)
    while day <= end:
        yield str(day)
        day += dt.timedelta(days=1)


def fetch_listing():
    request = urllib.request.Request('https://data.aoe2companion.com/api/dump/list',
                                    headers={'User-Agent': 'https://aoe2cn.cc', 'Accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=40) as response:
        raw = response.read(8*1024*1024+1)
    if len(raw) > 8*1024*1024:
        raise ValueError('Upstream listing too large')
    result = json.loads(raw)
    if not isinstance(result, list):
        raise ValueError('Invalid upstream listing')
    return result


def clean_listing(listing):
    result = {}
    for item in listing:
        key = item.get('key', '')
        if not re.fullmatch(r'match-\d{4}-\d{2}-\d{2}\.parquet', key):
            continue
        dt.date.fromisoformat(key[6:16])
        if key in result or type(item.get('size')) is not int or not 8 <= item['size'] <= 64*1024*1024:
            raise ValueError('Invalid or duplicate daily dump')
        if not isinstance(item.get('eTag'), str):
            raise ValueError('Daily dump missing ETag')
        result[key] = item
    return result


def permissions(root):
    if os.name == 'nt':
        return
    import grp
    gid = grp.getgrnam('aoe2').gr_gid
    for item in [root, *root.rglob('*')]:
        if item.is_symlink():
            continue
        os.chown(item, 0, gid)
        os.chmod(item, 0o750 if item.is_dir() else 0o640)


def prune_generated_datasets(root):
    # Keep the two latest successful cumulative exports and all legacy folders.
    parent = (root/'processed').resolve()
    generated = sorted((path for path in parent.iterdir() if path.is_dir() and not path.is_symlink()
                        and re.fullmatch(r'\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}-\d{8}T\d{12}Z', path.name)),
                       key=lambda path: path.name[-23:])
    for path in generated[:-2]:
        if path.resolve().is_relative_to(parent):
            shutil.rmtree(path)


def run(root, when=None, listing_reader=fetch_listing):
    when = when or dt.datetime.now(BEIJING)
    live = root/'stats/civilization-stats.sqlite'
    current = read_metadata(live)
    task = plan(current, when)
    print(json.dumps(task), flush=True)
    if task['action'] != 'update':
        return task
    listing = clean_listing(listing_reader())
    keys = ['match-'+day+'.parquet' for day in dates(task['downloadFrom'], task['targetTo'])]
    missing = [key for key in keys if key not in listing]
    if missing:
        raise RuntimeError('Previous week is not fully published; retain old statistics: '+','.join(missing))
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    report_dir = root/'reports/weekly'/stamp
    report_dir.mkdir(parents=True)
    pipeline = module('weekly_match_pipeline', 'match-data-pipeline.py')
    pipeline.BASE = root
    pipeline.PROGRESS = report_dir/'progress.json'
    pipeline.RUN = stamp
    manifest_path = root/'reports/download-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    verified = {item['filename']: item for item in manifest['files']}
    incremental = module('incremental_match_data', 'incremental-match-data.py')
    previous_dataset = incremental.dataset_path(root, current)
    incremental.verify(root, previous_dataset, current)
    for key in keys:
        verified[key] = pipeline.download(listing[key])
    all_keys = ['match-'+day+'.parquet' for day in dates(task['dateFrom'], task['targetTo'])]
    manifest = dict(requestedFrom=task['dateFrom'], requestedTo=task['targetTo'], availableTo=task['targetTo'],
                    notPublished=[], files=[verified[key] for key in all_keys])
    pipeline.save(report_dir/'download-manifest.json', manifest)
    work = root/'work'/('weekly-'+stamp)
    work.mkdir(parents=True)
    dataset = root/'processed'/f"{task['dateFrom']}_to_{task['targetTo']}-{stamp}"
    published = False
    try:
        con = pipeline.connect(work/'clean.duckdb')
        try:
            batch_report = pipeline.clean(con, [root/'raw'/key for key in keys], work/'batch')
        finally:
            con.close()
        report = incremental.merge(root, previous_dataset, work/'batch', dataset)
        report.update(requestedFrom=task['dateFrom'], requestedTo=task['targetTo'], availableTo=task['targetTo'],
                      outputDirectory=str(dataset), completedAt=dt.datetime.now(dt.timezone.utc).isoformat(),
                      rawFiles=len(all_keys), rawBytes=sum(item['bytes'] for item in manifest['files']),
                      processingMode='incremental', incrementalCleaning=batch_report,
                      newDailyFiles=len(keys), rawRetentionDays=28,
                      updateSchedule={'timezone': 'Asia/Shanghai', 'weekday': 'Monday', 'hour': 8,
                                      'firstRun': FIRST_RUN.isoformat()})
        pipeline.save(report_dir/'cleaning-report.json', report)
        builder = module('weekly_civilization_builder', 'build-civilization-stats.py')
        staged = work/'civilization-stats.sqlite'
        builder.build(dataset, staged, report)
        embed_previous_snapshot(staged, live)
        builder.inherit_trend_history(staged, live)
        new = read_metadata(staged)
        if new['dateFrom'] != current['dateFrom'] or new['dateTo'] != task['targetTo']:
            raise RuntimeError('Statistics date range mismatch')
        with sqlite3.connect(staged, uri=True) as db:
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Statistics database verification failed')
        # Prepare all supporting files first. The live database is the commit point.
        permissions(dataset)
        permissions(report_dir)
        shutil.copy2(live, live.with_suffix('.previous.sqlite.tmp'))
        os.replace(live.with_suffix('.previous.sqlite.tmp'), live.with_suffix('.previous.sqlite'))
        for name, source in [('download-manifest.json', report_dir/'download-manifest.json'),
                             ('cleaning-report.json', report_dir/'cleaning-report.json')]:
            target = root/'reports'/name
            shutil.copy2(source, target.with_suffix('.json.next'))
            os.replace(target.with_suffix('.json.next'), target)
        os.replace(staged, live)
        published = True
        result = {**task, 'action': 'published', 'completedAt': report['completedAt'],
                  'modes': new['modes'], 'reportDirectory': str(report_dir)}
        pipeline.save(root/'reports/weekly-latest.json', result)
        permissions(root/'stats')
        permissions(root/'reports')
        prune_generated_datasets(root)
        retention = incremental.prune_raw(root, new)
        permissions(root/'reports')
        print(json.dumps({'rawRetention':retention}),flush=True)
        print(json.dumps(result), flush=True)
        return result
    finally:
        if work.resolve().is_relative_to((root/'work').resolve()):
            shutil.rmtree(work)
        if not published and dataset.exists() and dataset.resolve().is_relative_to((root/'processed').resolve()):
            shutil.rmtree(dataset)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--plan', action='store_true', help='Read-only plan; no downloads or writes')
    parser.add_argument('--at', help='Simulate a date for --plan only, ISO 8601 including timezone')
    parser.add_argument('--prune-raw', action='store_true', help='Verify committed clean history, then retain only the latest 28 covered raw days')
    args = parser.parse_args()
    if args.at and not args.plan:
        parser.error('--at is only allowed with --plan')
    if args.prune_raw and args.plan:
        parser.error('--prune-raw cannot be combined with --plan')
    if args.plan:
        when = dt.datetime.fromisoformat(args.at) if args.at else dt.datetime.now(BEIJING)
        if when.tzinfo is None:
            parser.error('--at requires an explicit timezone')
        print(json.dumps(plan(read_metadata(args.root/'stats/civilization-stats.sqlite'), when)))
        return
    import fcntl
    os.umask(0o027)
    # Lock the whole download/clean/build/publish transaction, including retries.
    with (args.root/'work/weekly-update.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.prune_raw:
            metadata = read_metadata(args.root/'stats/civilization-stats.sqlite')
            incremental = module('incremental_match_data', 'incremental-match-data.py')
            incremental.verify(args.root, incremental.dataset_path(args.root,metadata), metadata)
            print(json.dumps(incremental.prune_raw(args.root,metadata)))
        else:
            run(args.root)


if __name__ == '__main__':
    main()
