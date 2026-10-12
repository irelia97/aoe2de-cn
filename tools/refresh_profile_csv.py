from pathlib import Path
import concurrent.futures
import subprocess
import os
import sqlite3
import csv
import json
import uuid
import time

ROOT = Path(r"E:\Codex_Project\AOE2DE-CN")
DATA = ROOT / ".cache"
URL = "https://dump.cdn.aoe2companion.com/profile.csv"
SIZE = 756466662
PARTS = DATA / "profile-csv-parts"
PARTS.mkdir(exist_ok=True)
CHUNK = 64 * 1024 * 1024
ranges = [(i, min(SIZE - 1, i + CHUNK - 1)) for i in range(0, SIZE, CHUNK)]


def get_part(item):
    index, (start, end) = item
    out = PARTS / f"{index:02d}.part"
    expected = end - start + 1
    if out.exists() and out.stat().st_size == expected:
        return index, out.stat().st_size
    for attempt in range(20):
        out.unlink(missing_ok=True)
        try:
            subprocess.run([
                "curl.exe", "-L", "--fail", "--retry", "3", "-sS",
                "-H", f"Range: bytes={start}-{end}", URL, "-o", str(out)
            ], check=True)
        except subprocess.CalledProcessError:
            time.sleep(min(2 + attempt, 10))
            continue
        if out.stat().st_size == expected:
            return index, out.stat().st_size
        time.sleep(min(2 + attempt, 10))
    raise RuntimeError(f"part {index} size mismatch")


with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
    futures = [executor.submit(get_part, item) for item in enumerate(ranges)]
    for future in concurrent.futures.as_completed(futures):
        print("downloaded", future.result(), flush=True)

raw = DATA / "profile.csv"
with raw.open("wb") as target:
    for index, _ in enumerate(ranges):
        with (PARTS / f"{index:02d}.part").open("rb") as source:
            while chunk := source.read(1024 * 1024):
                target.write(chunk)
print("combined", raw.stat().st_size, flush=True)

identifier = f"{int(time.time() * 1000)}-{uuid.uuid4()}"
temp_db = DATA / f"profile-index-{identifier}.sqlite.tmp"
final_db = DATA / f"profile-index-{identifier}.sqlite"
connection = sqlite3.connect(temp_db)
connection.execute("PRAGMA journal_mode=OFF")
connection.execute("PRAGMA synchronous=OFF")
connection.execute("PRAGMA temp_store=MEMORY")
connection.executescript(
    "CREATE TABLE profiles(profile_id TEXT PRIMARY KEY, steam_id TEXT, name TEXT NOT NULL, "
    "clan TEXT, last_match_time TEXT, country TEXT); "
    "CREATE TABLE profile_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);"
)

rows = []
count = 0
with raw.open("r", encoding="utf-8-sig", newline="", errors="replace") as source:
    reader = csv.DictReader(source)
    for row in reader:
        profile_id = (row.get("profile_id") or "").strip()
        name = (row.get("name") or "").strip()
        if not profile_id or not name:
            continue
        rows.append((
            profile_id,
            (row.get("steam_id") or "").strip(),
            name,
            (row.get("clan") or "").strip(),
            (row.get("last_match_time") or "").strip(),
            (row.get("country") or "").strip(),
        ))
        if len(rows) >= 10000:
            connection.executemany("INSERT OR REPLACE INTO profiles VALUES (?,?,?,?,?,?)", rows)
            count += len(rows)
            rows.clear()
            if count % 100000 == 0:
                print("indexed", count, flush=True)
if rows:
    connection.executemany("INSERT OR REPLACE INTO profiles VALUES (?,?,?,?,?,?)", rows)
    count += len(rows)

connection.execute("CREATE VIRTUAL TABLE profile_search USING fts5(name, content='profiles', content_rowid='rowid', tokenize='trigram')")
connection.execute("INSERT INTO profile_search(profile_search) VALUES('rebuild')")
updated = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
connection.execute("INSERT INTO profile_meta(key,value) VALUES (?,?)", ("updatedAt", updated))
connection.commit()
connection.close()
os.replace(temp_db, final_db)

pointer = DATA / "profile-index-current.json"
pointer_temp = DATA / "profile-index-current.json.tmp"
pointer_temp.write_text(json.dumps({"filename": final_db.name, "updatedAt": updated, "format": "csv"}), encoding="utf-8")
os.replace(pointer_temp, pointer)
print("completed", count, final_db.name, updated, flush=True)
