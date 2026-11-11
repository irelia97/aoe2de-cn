
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AOE2DE top-2000 Random Map + Team Random Map player alias collector.

Important:
- The World's Edge community API is unofficial/undocumented. It may change.
- aoe2recs.com may rate-limit or block automated requests.
- This script uses one request at a time, does not rotate proxies, does not spoof
  browser fingerprints, does not solve CAPTCHAs, and stops on access denial.
- Profile data is requested through the site's WebSocket cls=13 protocol
  through a normal, user-opened Chrome session using the local DevTools port.
- The user must complete any Cloudflare challenge manually in Chrome.
- Requests are sequential with a fixed minimum 10-second interval.
- This script does not solve challenges, spoof browser fingerprints, or rotate proxies.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sqlite3
import subprocess
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

import requests
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter


API_BASE = "https://aoe-api.worldsedgelink.com/community/leaderboard"
AOE2RECS_PROFILE = "https://aoe2recs.com/profile/{profile_id}"
AOE2RECS_WS = "wss://aoe2recs.com/dashboard/api/"
AOE2RECS_ORIGIN = "https://aoe2recs.com"
PROFILE_RESPONSE_CLASS = 13
BATCH_RESPONSE_CLASS = 3
LADDERS = {
    3: "Random Map",
    4: "Team Random Map",
}
PAGE_SIZE = 100
TOP_N = 1000
TEST_PROFILE_ID = "9423131"
PROFILE_REQUEST_INTERVAL_SECONDS = 10.0
DEFAULT_CDP_PORT = 9222


class StopCrawl(RuntimeError):
    """Raised when continuing would risk violating a site's access controls."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def make_session() -> requests.Session:
    session = requests.Session()
    # An identifying UA; intentionally not impersonating Chrome or the game client.
    session.headers.update({
        "User-Agent": "AOE2AliasCollector/1.0 (personal research; sequential requests)",
        "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
    })
    return session


def retry_after_seconds(response: requests.Response, fallback: float) -> float:
    value = response.headers.get("Retry-After", "").strip()
    if value.isdigit():
        return max(float(value), 1.0)
    if value:
        try:
            retry_at = parsedate_to_datetime(value)
            if retry_at.tzinfo is None:
                retry_at = retry_at.replace(tzinfo=timezone.utc)
            return max((retry_at - datetime.now(timezone.utc)).total_seconds(), 1.0)
        except (TypeError, ValueError, OverflowError):
            pass
    return fallback


def request_with_backoff(
    session: requests.Session,
    url: str,
    *,
    params: dict[str, Any] | None = None,
    timeout: int = 30,
    max_5xx_retries: int = 3,
    retry_429_once: bool = True,
) -> requests.Response:
    attempt_5xx = 0
    did_retry_429 = False

    while True:
        try:
            response = session.get(url, params=params, timeout=timeout)
        except requests.RequestException as exc:
            attempt_5xx += 1
            if attempt_5xx > max_5xx_retries:
                raise StopCrawl(f"网络请求连续失败，停止以避免持续重试：{exc}") from exc
            wait = min(60 * (2 ** (attempt_5xx - 1)), 600)
            print(f"[网络错误] {exc}；等待 {wait} 秒后重试。")
            time.sleep(wait)
            continue

        if response.status_code == 403:
            raise StopCrawl(
                f"服务器返回 HTTP 403：{response.url}\n"
                "已停止请求，不尝试绕过访问控制。"
            )

        if response.status_code == 429:
            if did_retry_429 or not retry_429_once:
                raise StopCrawl(
                    f"服务器再次返回 HTTP 429：{response.url}\n"
                    "已停止抓取；请等待网站允许后再手动续跑。"
                )
            wait = retry_after_seconds(response, 600.0)
            # Do not cap Retry-After: honor the server's requested delay.
            print(f"[限流] 收到 HTTP 429，遵循 Retry-After，等待 {wait:.0f} 秒。")
            time.sleep(wait)
            did_retry_429 = True
            continue

        if 400 <= response.status_code <= 499:
            raise StopCrawl(
                f"服务器返回 HTTP {response.status_code}：{response.url}\n"
                "该状态不是可安全重试的临时错误，已停止请求。"
            )

        if 500 <= response.status_code <= 599:
            attempt_5xx += 1
            if attempt_5xx > max_5xx_retries:
                raise StopCrawl(f"服务器连续返回 HTTP {response.status_code}，已停止。")
            wait = min(30 * (2 ** (attempt_5xx - 1)), 600)
            print(f"[服务器错误] HTTP {response.status_code}；等待 {wait} 秒后重试。")
            time.sleep(wait)
            continue

        return response


def fetch_json(
    session: requests.Session,
    endpoint: str,
    params: dict[str, Any],
    api_delay: float,
) -> dict[str, Any]:
    url = f"{API_BASE}/{endpoint}"
    response = request_with_backoff(session, url, params=params)
    response.raise_for_status()
    try:
        payload = response.json()
    except ValueError as exc:
        raise StopCrawl(f"API 返回的不是有效 JSON：{response.url}") from exc

    result = payload.get("result", {})
    if isinstance(result, dict) and result.get("code") not in (None, 0):
        raise StopCrawl(f"API 返回错误：{result}")
    time.sleep(api_delay)
    return payload


def discover_ladders(session: requests.Session, workdir: Path, api_delay: float) -> dict[str, Any]:
    cache_path = workdir / "cache" / "available_leaderboards.json"
    cached = load_json(cache_path, None)
    if cached:
        return cached

    payload = fetch_json(session, "getAvailableLeaderboards", {"title": "age2"}, api_delay)
    save_json(cache_path, payload)
    return payload


def extract_page_rows(payload: dict[str, Any], ladder_id: int, start: int) -> list[dict[str, Any]]:
    """
    Join leaderboardStats.statgroup_id to statGroups[].id and/or
    members[].personal_statgroup_id. Avoid cross-linking members in a group.
    """
    statgroup_to_members: dict[str, list[dict[str, Any]]] = {}

    for group in payload.get("statGroups", []) or []:
        if not isinstance(group, dict):
            continue
        members = [
            member for member in (group.get("members", []) or [])
            if isinstance(member, dict) and member.get("profile_id") is not None
        ]

        group_id = group.get("id")
        if group_id is not None:
            key = str(group_id)
            statgroup_to_members.setdefault(key, [])
            statgroup_to_members[key].extend(members)

        for member in members:
            personal_group_id = member.get("personal_statgroup_id")
            if personal_group_id is not None:
                key = str(personal_group_id)
                statgroup_to_members.setdefault(key, [])
                statgroup_to_members[key].append(member)

    rows: list[dict[str, Any]] = []
    fallback_rank = start

    for stat in payload.get("leaderboardStats", []) or []:
        if not isinstance(stat, dict):
            continue
        if stat.get("leaderboard_id") not in (None, ladder_id):
            continue

        key = str(stat.get("statgroup_id", ""))
        members = statgroup_to_members.get(key, [])
        if not members and stat.get("profile_id") is not None:
            members = [{"profile_id": stat.get("profile_id")}]

        unique_members = {}
        for member in members:
            unique_members[str(member.get("profile_id"))] = member

        for member in unique_members.values():
            profile_id = member.get("profile_id")
            try:
                profile_id = str(int(profile_id))
            except (TypeError, ValueError):
                profile_id = str(profile_id)

            rows.append({
                "profile_id": profile_id,
                "player_name": member.get("alias") or member.get("name") or "",
                "country": member.get("country") or "",
                "leaderboard_id": ladder_id,
                "leaderboard": LADDERS[ladder_id],
                "rank": stat.get("rank") if stat.get("rank") is not None else fallback_rank,
                "rating": stat.get("rating"),
                "wins": stat.get("wins"),
                "losses": stat.get("losses"),
                "last_match_date": stat.get("lastmatchdate"),
            })
        fallback_rank += 1

    return rows


def fetch_leaderboard(
    session: requests.Session,
    workdir: Path,
    ladder_id: int,
    api_delay: float,
) -> list[dict[str, Any]]:
    all_rows: list[dict[str, Any]] = []
    cache_dir = workdir / "cache" / "leaderboards"
    cache_dir.mkdir(parents=True, exist_ok=True)

    for start in range(1, TOP_N + 1, PAGE_SIZE):
        page_path = cache_dir / f"ladder_{ladder_id}_start_{start}.json"
        payload = load_json(page_path, None)
        if payload is None:
            print(f"[排行榜] {LADDERS[ladder_id]}：读取第 {start}–{min(start + PAGE_SIZE - 1, TOP_N)} 名")
            payload = fetch_json(
                session,
                "getLeaderBoard2",
                {
                    "title": "age2",
                    "leaderboard_id": ladder_id,
                    "sortBy": 1,
                    "start": start,
                    "count": PAGE_SIZE,
                },
                api_delay,
            )
            save_json(page_path, payload)
        else:
            print(f"[排行榜缓存] {LADDERS[ladder_id]}：start={start}")

        page_rows = extract_page_rows(payload, ladder_id, start)
        if not page_rows:
            # Empty page before top 2000 means API schema/pagination may have changed.
            raise StopCrawl(
                f"{LADDERS[ladder_id]} 的 start={start} 页面没有解析出选手。"
                "已保留缓存；请先检查 API 返回结构，不继续猜测。"
            )
        all_rows.extend(page_rows)

    # Keep only the best rank for duplicate profile IDs within the same ladder.
    dedup: dict[str, dict[str, Any]] = {}
    for row in all_rows:
        pid = row["profile_id"]
        if pid not in dedup or int(row["rank"]) < int(dedup[pid]["rank"]):
            dedup[pid] = row
    return sorted(dedup.values(), key=lambda x: int(x["rank"]))



def _profile_messages(message: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract cls=13 profile responses from direct or cls=3 batched messages."""
    if not isinstance(message, dict):
        return []
    if message.get("cls") == PROFILE_RESPONSE_CLASS:
        return [message]
    if message.get("cls") == BATCH_RESPONSE_CLASS:
        data = message.get("data")
        if isinstance(data, list):
            return [
                item for item in data
                if isinstance(item, dict) and item.get("cls") == PROFILE_RESPONSE_CLASS
            ]
    return []


def normalize_profile_payload(profile_id: str, data: Any) -> dict[str, Any]:
    """
    Normalize the cls=13 `data` object used by the aoe2recs profile page.

    Confirmed from the uploaded frontend bundles:
      person.accounts -> account rows
      account.name / account.id -> Account label
      account.akas -> Aliases
      account.platform, account.country, account.url -> displayed metadata
    """
    profile_url = AOE2RECS_PROFILE.format(profile_id=profile_id)

    if not isinstance(data, dict):
        raise StopCrawl(
            f"Profile {profile_id} 的 cls=13 响应 data 不是对象，无法安全解析。"
        )

    if data.get("found") is False or (data.get("player") is None and data.get("found") is not True):
        return {
            "profile_id": profile_id,
            "status": "NOT_FOUND",
            "accounts": [],
            "checked_at": utc_now(),
            "profile_url": profile_url,
            "protocol": "aoe2recs_ws_cls13_v1",
            "note": "WebSocket cls=13 returned no player profile.",
            "player": data.get("player"),
        }

    if "accounts" not in data:
        raise StopCrawl(
            f"Profile {profile_id} 的 cls=13 响应没有 accounts 字段。"
            "已停止，避免把不完整响应误判为没有关联账号。"
        )

    raw_accounts = data.get("accounts")
    if raw_accounts is None:
        raw_accounts = []
    if not isinstance(raw_accounts, list):
        raise StopCrawl(
            f"Profile {profile_id} 的 accounts 字段不是数组，已停止。"
        )

    accounts: list[dict[str, Any]] = []
    for item in raw_accounts:
        if not isinstance(item, dict):
            continue

        raw_akas = item.get("akas") or []
        if isinstance(raw_akas, str):
            akas = [raw_akas] if raw_akas.strip() else []
        elif isinstance(raw_akas, list):
            akas = [str(alias).strip() for alias in raw_akas if str(alias).strip()]
        else:
            akas = []

        account_name = item.get("name")
        account_id = item.get("id")
        account_label = str(account_name).strip() if account_name not in (None, "") else str(account_id or "")

        accounts.append({
            "account": account_label,
            "account_id": account_id,
            "aliases": ", ".join(akas),
            "akas": akas,
            "platform": item.get("platform", ""),
            "country": item.get("country", ""),
            "url": item.get("url", ""),
            "last": item.get("last", ""),
        })

    return {
        "profile_id": profile_id,
        "status": "OK",
        "accounts": accounts,
        "checked_at": utc_now(),
        "profile_url": profile_url,
        "protocol": "aoe2recs_ws_cls13_v1",
        "note": "",
        "player": data.get("player") or {},
    }


def extract_cls13_messages(payload: Any) -> list[dict[str, Any]]:
    """Find cls=13 responses in a raw frame, cls=3 batch, list, or export wrapper."""
    found: list[dict[str, Any]] = []

    def walk(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                walk(item)
            return
        if not isinstance(value, dict):
            return
        if value.get("cls") == PROFILE_RESPONSE_CLASS and isinstance(value.get("data"), dict):
            found.append(value)
            return
        # Browser-export wrapper: {requested_profile_id, response: {...}}
        if isinstance(value.get("response"), dict):
            response = value["response"]
            if response.get("cls") == PROFILE_RESPONSE_CLASS:
                wrapped = dict(response)
                if value.get("requested_profile_id") is not None:
                    wrapped["requested_profile_id"] = value["requested_profile_id"]
                found.append(wrapped)
                return
        if value.get("cls") == BATCH_RESPONSE_CLASS:
            walk(value.get("data"))
        if isinstance(value.get("responses"), list):
            walk(value["responses"])
        if isinstance(value.get("messages"), list):
            walk(value["messages"])

    walk(payload)
    return found


def import_ws_response_files(
    paths: list[Path],
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Import user-exported aoe2recs WebSocket frames; no live site connection."""
    profiles = dict(existing or {})
    imported = 0

    for path in paths:
        if not path.exists():
            raise StopCrawl(f"找不到 WebSocket JSON 文件：{path}")
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as exc:
            raise StopCrawl(f"无法读取 JSON 文件 {path}：{exc}") from exc

        responses = extract_cls13_messages(payload)
        if not responses:
            raise StopCrawl(
                f"文件 {path.name} 中没有找到 cls=13 Profile 响应。"
                "请确认导出的是 WebSocket Messages/Frames 中的服务器响应。"
            )

        for response in responses:
            data = response.get("data") or {}
            player = data.get("player") or {}
            profile_id = response.get("requested_profile_id") or player.get("id")
            if profile_id is None:
                raise StopCrawl(
                    f"文件 {path.name} 的 cls=13 响应没有 player.id，无法确定 Profile ID。"
                )
            profile_id = str(profile_id)
            profile = normalize_profile_payload(profile_id, data)
            profile["source_file"] = path.name
            profiles[profile_id] = profile
            imported += 1

    print(f"[导入] 从 {len(paths)} 个文件导入 {imported} 条 Profile 响应；当前缓存 {len(profiles)} 人。")
    return profiles


def load_cached_leaderboard_rows(workdir: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Rebuild leaderboard rows from the existing page cache, if present."""
    result: dict[int, list[dict[str, Any]]] = {3: [], 4: []}
    cache_dir = workdir / "cache" / "leaderboards"
    for ladder_id in (3, 4):
        for start in range(1, TOP_N + 1, PAGE_SIZE):
            page_path = cache_dir / f"ladder_{ladder_id}_start_{start}.json"
            payload = load_json(page_path, None)
            if payload is None:
                break
            result[ladder_id].extend(extract_page_rows(payload, ladder_id, start))
        dedup: dict[str, dict[str, Any]] = {}


        for row in result[ladder_id]:
            pid = row["profile_id"]
            if pid not in dedup or int(row["rank"]) < int(dedup[pid]["rank"]):
                dedup[pid] = row
        result[ladder_id] = sorted(dedup.values(), key=lambda x: int(x["rank"]))
    return result[3], result[4]


def load_profile_cache(path: Path) -> dict[str, Any]:
    cached = load_json(path, {})
    return cached if isinstance(cached, dict) else {}


def save_profile_cache(path: Path, data: dict[str, Any]) -> None:
    save_json(path, data)


def finish_background_refresh(args: argparse.Namespace, completed: int) -> None:
    if args.site_chat_db:
        timestamp = int(time.time() * 1000)
        key = "aoe2recs-top1000-refresh-20261110"
        content = (
            "AoE2Recs 榜单玩家资料更新完成："
            f"1v1随机地图和组队随机地图各前1000名，去重后共 {completed} 人。"
        )
        with sqlite3.connect(args.site_chat_db, timeout=10) as db:
            exists = db.execute(
                "SELECT 1 FROM messages WHERE kind='system' AND ip_hash=? LIMIT 1", (key,)
            ).fetchone()
            if not exists:
                db.execute(
                    "INSERT INTO messages(kind,author,content,url,ip_hash,created_at) VALUES('system','系统',?,'',?,?)",
                    (content, key, timestamp),
                )
                db.commit()
    if args.restart_service_on_complete:
        subprocess.run(["systemctl", "restart", args.restart_service_on_complete], check=False)


def players_from_profiles(profiles: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for pid, profile in profiles.items():
        player = profile.get("player") or {}
        rows.append({
            "profile_id": str(pid),
            "player_name": player.get("name", ""),
            "country": player.get("country_code") or player.get("country", ""),
            "rm_rank": None,
            "rm_rating": None,
            "team_rm_rank": None,
            "team_rm_rating": None,
        })
    return sorted(rows, key=lambda x: x["profile_id"])


def prepare_profile_queue(workdir: Path, rm_rows: list[dict[str, Any]], team_rows: list[dict[str, Any]]) -> Path:
    players = build_player_rows(rm_rows, team_rows)
    profiles = load_profile_cache(workdir / "profiles.json")
    pending = [
        player for player in players
        if not (
            profiles.get(player["profile_id"])
            and profiles[player["profile_id"]].get("status") in ("OK", "NOT_FOUND")
            and profiles[player["profile_id"]].get("protocol") == "aoe2recs_ws_cls13_v1"
        )
    ]
    queue = {
        "protocol": "aoe2recs_manual_ws_export_queue_v1",
        "created_at": utc_now(),
        "requested_total": len(players),
        "already_imported": len(players) - len(pending),
        "profiles": pending,
    }
    path = workdir / "profile_ids_for_manual_capture.json"
    save_json(path, queue)
    print(f"[队列] 榜单去重后 {len(players)} 个 Profile ID；尚未导入 {len(pending)} 个。")
    print(f"[队列文件] {path}")
    return path


def build_player_rows(
    rm_rows: list[dict[str, Any]],
    team_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    players: dict[str, dict[str, Any]] = {}

    for row in rm_rows + team_rows:
        pid = row["profile_id"]
        player = players.setdefault(pid, {
            "profile_id": pid,
            "player_name": row.get("player_name", ""),
            "country": row.get("country", ""),
            "rm_rank": None,
            "rm_rating": None,
            "team_rm_rank": None,
            "team_rm_rating": None,
        })
        if row["leaderboard_id"] == 3:
            player["rm_rank"] = row.get("rank")
            player["rm_rating"] = row.get("rating")
        elif row["leaderboard_id"] == 4:
            player["team_rm_rank"] = row.get("rank")
            player["team_rm_rating"] = row.get("rating")
        if not player["player_name"] and row.get("player_name"):
            player["player_name"] = row["player_name"]
        if not player["country"] and row.get("country"):
            player["country"] = row["country"]

    return sorted(
        players.values(),
        key=lambda p: (
            min(
                p["rm_rank"] if p["rm_rank"] is not None else 999999,
                p["team_rm_rank"] if p["team_rm_rank"] is not None else 999999,
            ),
            p["profile_id"],
        ),
    )


def style_sheet(ws) -> None:
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    header_fill = PatternFill("solid", fgColor="1F4E78")
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")
    for col_cells in ws.columns:
        values = [len(str(c.value)) if c.value is not None else 0 for c in col_cells[:300]]
        width = min(max(max(values, default=10) + 2, 12), 55)
        ws.column_dimensions[get_column_letter(col_cells[0].column)].width = width
    ws.row_dimensions[1].height = 24


def export_excel(
    output_path: Path,
    players: list[dict[str, Any]],
    profiles: dict[str, Any],
    rm_rows: list[dict[str, Any]],
    team_rows: list[dict[str, Any]],
    errors: list[dict[str, Any]] | None = None,
) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "Players"

    headers = [
        "Profile ID", "Player Name", "Country",
        "Random Map Rank", "Random Map Elo",
        "Team Random Map Rank", "Team Random Map Elo",
        "Account Rows", "Profile URL", "Scrape Status", "Last Checked",
    ]
    ws.append(headers)

    accounts_ws = wb.create_sheet("Accounts")
    accounts_ws.append([
        "Profile ID", "Account", "Account ID", "Aliases",
        "Platform", "Country", "Account URL", "Last Active", "Profile URL", "Checked At"
    ])

    for player in players:
        pid = player["profile_id"]
        profile = profiles.get(pid, {})
        accounts = profile.get("accounts", []) or []
        combined_accounts = " | ".join(a.get("account", "") for a in accounts if a.get("account"))
        combined_aliases = " | ".join(a.get("aliases", "") for a in accounts if a.get("aliases"))
        profile_url = profile.get("profile_url") or AOE2RECS_PROFILE.format(profile_id=pid)
        ws.append([
            pid,
            player.get("player_name", ""),
            player.get("country", ""),
            player.get("rm_rank"),
            player.get("rm_rating"),
            player.get("team_rm_rank"),
            player.get("team_rm_rating"),
            len(accounts),
            profile_url,
            profile.get("status", "PENDING"),
            profile.get("checked_at", ""),
        ])
        url_cell = ws.cell(ws.max_row, 9)
        url_cell.hyperlink = profile_url
        url_cell.style = "Hyperlink"

        for account in accounts:
            accounts_ws.append([
                pid,
                account.get("account", ""),
                account.get("account_id", ""),
                account.get("aliases", ""),
                account.get("platform", ""),
                account.get("country", ""),
                account.get("url", ""),
                account.get("last", ""),
                profile_url,
                profile.get("checked_at", ""),
            ])

    raw_ws = wb.create_sheet("Leaderboard Raw")
    raw_ws.append([
        "Profile ID", "Player Name", "Country", "Leaderboard",
        "Rank", "Rating", "Wins", "Losses", "Last Match Date",
    ])
    for row in sorted(rm_rows + team_rows, key=lambda r: (r["leaderboard_id"], int(r["rank"]))):
        raw_ws.append([
            row.get("profile_id"), row.get("player_name"), row.get("country"),
            row.get("leaderboard"), row.get("rank"), row.get("rating"),
            row.get("wins"), row.get("losses"), row.get("last_match_date"),
        ])

    err_ws = wb.create_sheet("Errors")
    err_ws.append(["Profile ID", "Status", "Note", "Checked At"])
    for item in errors or []:
        err_ws.append([
            item.get("profile_id"), item.get("status"),
            item.get("note"), item.get("checked_at"),
        ])

    for sheet in wb.worksheets:
        style_sheet(sheet)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(output_path)



def run_test_response(args: argparse.Namespace, workdir: Path) -> None:
    profiles = import_ws_response_files([Path(args.test_response)])
    if len(profiles) != 1:
        raise StopCrawl(f"单人测试模式预期 1 个 Profile，实际导入 {len(profiles)} 个。")
    pid, profile = next(iter(profiles.items()))
    player_data = profile.get("player") or {}
    test_player = [{
        "profile_id": pid,
        "player_name": player_data.get("name") or f"Profile {pid}",
        "country": player_data.get("country_code") or player_data.get("country", ""),
        "rm_rank": None,
        "rm_rating": None,
        "team_rm_rank": None,
        "team_rm_rating": None,
    }]
    export_excel(workdir / "aoe2_alias_test.xlsx", test_player, {pid: profile}, [], [], [])
    save_profile_cache(workdir / "profiles.json", profiles)
    print(f"[完成] 测试 Excel：{workdir / 'aoe2_alias_test.xlsx'}")
    print(f"[验证] Profile ID={pid}；Account/Aliases 行数={len(profile.get('accounts', []))}")


def run_prepare_leaderboards(args: argparse.Namespace, session: requests.Session, workdir: Path) -> None:
    print("[准备] 从 Age of Empires 官方排行榜 API 获取两个榜单前 2000 名。")
    available = discover_ladders(session, workdir, args.api_delay)
    save_json(workdir / "available_leaderboards_snapshot.json", available)
    rm_rows = fetch_leaderboard(session, workdir, 3, args.api_delay)
    team_rows = fetch_leaderboard(session, workdir, 4, args.api_delay)
    players = build_player_rows(rm_rows, team_rows)
    queue_path = prepare_profile_queue(workdir, rm_rows, team_rows)
    profiles = load_profile_cache(workdir / "profiles.json")
    export_excel(workdir / "aoe2_aliases_partial.xlsx", players, profiles, rm_rows, team_rows, [])
    print(f"[完成] 已生成 Profile ID 队列：{queue_path}")
    print("[说明] 下一步运行 开始批量采集.bat；程序会使用你正常打开并完成验证的 Chrome 会话。")


def run_import(args: argparse.Namespace, workdir: Path) -> None:
    profile_cache_path = workdir / "profiles.json"
    profiles = import_ws_response_files(
        [Path(p) for p in args.import_ws_json],
        existing=load_profile_cache(profile_cache_path),
    )
    save_profile_cache(profile_cache_path, profiles)

    rm_rows, team_rows = load_cached_leaderboard_rows(workdir)
    if rm_rows or team_rows:


        players = build_player_rows(rm_rows, team_rows)
        pending = [p for p in players if p["profile_id"] not in profiles]
        errors = [p for p in profiles.values() if p.get("status") not in ("OK", "NOT_FOUND")]
        output = workdir / ("aoe2_aliases.xlsx" if not pending else "aoe2_aliases_partial.xlsx")
        export_excel(output, players, profiles, rm_rows, team_rows, errors)
        prepare_profile_queue(workdir, rm_rows, team_rows)
    else:
        players = players_from_profiles(profiles)
        errors = [p for p in profiles.values() if p.get("status") not in ("OK", "NOT_FOUND")]
        output = workdir / "aoe2_aliases_imported.xlsx"
        export_excel(output, players, profiles, [], [], errors)

    print(f"[完成] Excel：{output}")
    print(f"[统计] 已导入 Profile：{len(profiles)}；关联账号总数：{sum(len(p.get('accounts', [])) for p in profiles.values())}")



class ChromeDevTools:
    """Small synchronous Chrome DevTools Protocol client for a local Chrome instance."""

    def __init__(self, port: int = DEFAULT_CDP_PORT):
        try:
            import websocket
        except ImportError as exc:
            raise StopCrawl(
                "缺少 websocket-client。请运行：py -m pip install websocket-client"
            ) from exc

        self.websocket_module = websocket
        self.port = port
        self.ws = None
        self.command_id = 0
        self.target_url = ""

    def connect(self) -> None:
        endpoint = f"http://127.0.0.1:{self.port}/json/list"
        try:
            response = requests.get(endpoint, timeout=4)
            response.raise_for_status()
            targets = response.json()
        except Exception as exc:
            raise StopCrawl(
                f"无法连接本机 Chrome DevTools（{endpoint}）。"
                "请使用随工具提供的 BAT 启动 Chrome，不要关闭该浏览器。"
            ) from exc

        pages = [
            item for item in targets
            if item.get("type") == "page"
            and "aoe2recs.com" in item.get("url", "")
            and item.get("webSocketDebuggerUrl")
        ]
        if not pages:
            raise StopCrawl(
                "没有找到已打开 aoe2recs.com 的 Chrome 页面。"
                "请先用配套 BAT 启动浏览器并打开 Lucho 资料页。"
            )

        # Prefer a profile page; otherwise use the first aoe2recs tab.
        pages.sort(key=lambda item: ("/profile/" not in item.get("url", ""), item.get("url", "")))
        target = pages[0]
        self.target_url = target.get("url", "")
        try:
            self.ws = self.websocket_module.create_connection(
                target["webSocketDebuggerUrl"],
                timeout=15,
                suppress_origin=True,
                enable_multithread=False,
            )
        except Exception as exc:
            raise StopCrawl(f"连接本机 Chrome DevTools 失败：{exc}") from exc

        self.command("Page.enable")
        self.command("Runtime.enable")

    def close(self) -> None:
        if self.ws is not None:
            try:
                self.ws.close()
            except Exception:
                pass
            self.ws = None

    def command(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if self.ws is None:
            raise StopCrawl("Chrome DevTools 尚未连接。")
        self.command_id += 1
        command_id = self.command_id
        payload = {"id": command_id, "method": method, "params": params or {}}
        try:
            self.ws.send(json.dumps(payload, separators=(",", ":")))
            while True:
                raw = self.ws.recv()
                message = json.loads(raw)
                if message.get("id") != command_id:
                    # Ignore asynchronous CDP events; profile frames are captured in page JS.
                    continue
                if "error" in message:
                    raise StopCrawl(f"Chrome DevTools 命令失败：{message['error']}")
                return message.get("result", {})
        except StopCrawl:
            raise
        except Exception as exc:
            raise StopCrawl(f"Chrome DevTools 通信中断：{exc}") from exc

    def evaluate(self, expression: str) -> Any:
        result = self.command(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
                "userGesture": True,
            },
        )
        if result.get("exceptionDetails"):
            details = result["exceptionDetails"]
            raise StopCrawl(f"浏览器页面脚本执行失败：{details.get('text', details)}")
        remote = result.get("result", {})
        return remote.get("value")

    def install_capture_and_reload(self) -> None:
        # Instrument only the page's own WebSocket instance. The browser itself
        # performs Cloudflare's normal JavaScript/cookie checks; no challenge is solved here.
        capture_script = r"""
(() => {
  if (window.__aoe2recs_capture_installed) return;
  window.__aoe2recs_capture_installed = true;
  window.__aoe2recs_sockets = [];
  window.__aoe2recs_profile_frames = [];
  const NativeWebSocket = window.WebSocket;

  function CapturedWebSocket(url, protocols) {
    const socket = protocols === undefined
      ? new NativeWebSocket(url)
      : new NativeWebSocket(url, protocols);

    if (String(url).includes("aoe2recs.com/dashboard/api/")) {
      window.__aoe2recs_sockets.push(socket);
      socket.addEventListener("message", event => {
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data);
          if (message && message.cls === 13) {
            window.__aoe2recs_profile_frames.push(message);
          } else if (message && message.cls === 3 && Array.isArray(message.data)) {
            for (const item of message.data) {
              if (item && item.cls === 13) window.__aoe2recs_profile_frames.push(item);
            }
          }
        } catch (_) {}
      });
    }
    return socket;
  }

  CapturedWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(CapturedWebSocket, NativeWebSocket);
  window.WebSocket = CapturedWebSocket;
})();
"""
        self.command(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": capture_script},
        )
        print("[浏览器] 已安装只记录 cls=13 响应的页面监听器，正在重新加载资料页。")
        self.command("Page.reload", {"ignoreCache": True})

    def wait_for_profile_socket(self, timeout_seconds: int = 240) -> None:
        print(
            "[浏览器] 请在新打开的 Chrome 中正常完成 Cloudflare 验证（如出现）。"
            "程序不会自动解题；验证完成后会自动继续。"
        )
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            try:
                states = self.evaluate(
                    """(window.__aoe2recs_sockets || []).map(s => ({
                        url: s.url, state: s.readyState
                    }))"""
                ) or []
            except StopCrawl:
                time.sleep(2)
                continue
            if any(
                item.get("state") == 1
                and "aoe2recs.com/dashboard/api/" in item.get("url", "")
                for item in states
            ):
                print("[浏览器] 已检测到 aoe2recs WebSocket 连接（OPEN）。")
                return
            time.sleep(2)
        raise StopCrawl(
            "等待 aoe2recs WebSocket 超时。请确认 Cloudflare 验证已在 Chrome 中正常完成，"
            "且资料页能够正常显示；程序未尝试绕过验证。"
        )

    def request_profile(self, profile_id: str, timeout_seconds: int = 45) -> dict[str, Any]:
        reset = self.evaluate("""(() => {
          if (!Array.isArray(window.__aoe2recs_profile_frames)) return false;
          window.__aoe2recs_profile_frames.length = 0;
          return true;
        })()""")
        if reset is not True:
            raise StopCrawl("页面没有安装 cls=13 响应监听器，请重新启动配套 BAT。")

        send_expression = f"""(() => {{
          const sockets = window.__aoe2recs_sockets || [];
          const socket = [...sockets].reverse().find(s =>
            s.readyState === 1 &&
            s.url.includes("aoe2recs.com/dashboard/api/")
          );
          if (!socket) return {{ok:false, reason:"no_open_socket"}};
          socket.send(JSON.stringify({{profile_id:{json.dumps(int(profile_id) if str(profile_id).isdigit() else str(profile_id))}}}));
          return {{ok:true}};
        }})()"""
        sent = self.evaluate(send_expression)
        if not isinstance(sent, dict) or not sent.get("ok"):
            raise StopCrawl(
                f"Profile {profile_id} 请求未发送：没有可用的 OPEN WebSocket。"
                "程序停止，不自动重连。"
            )

        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            # Remove frames as soon as they are inspected. Keeping hundreds of
            # full profile payloads in the page eventually exhausts Chrome's
            # memory and makes even the timeout loop itself unresponsive.
            frames = self.evaluate(
                "(window.__aoe2recs_profile_frames || []).splice(0)"
            ) or []
            for response in frames:
                if not isinstance(response, dict) or response.get("cls") != PROFILE_RESPONSE_CLASS:
                    continue
                data = response.get("data")
                if not isinstance(data, dict):
                    continue
                if data.get("found") is False:
                    return response
                ids = []
                player = data.get("player")
                if isinstance(player, dict) and player.get("id") is not None:
                    ids.append(str(player["id"]))
                for account in data.get("accounts") or []:
                    if isinstance(account, dict) and account.get("id") is not None:
                        ids.append(str(account["id"]))
                # Ignore cls=13 intermediate frames with no populated identity,
                # and unrelated frames emitted by the shared persistent socket.
                if str(profile_id) in ids:
                    return response

            state = self.evaluate(
                """(() => {
                  const sockets = window.__aoe2recs_sockets || [];
                  const socket = [...sockets].reverse().find(s =>
                    s.url.includes("aoe2recs.com/dashboard/api/")
                  );
                  return socket ? socket.readyState : -1;
                })()"""
            )
            if state != 1:
                raise StopCrawl(
                    "aoe2recs WebSocket 已关闭或断开。已停止，不自动重连或重复发送请求。"
                )
            time.sleep(0.5)

        raise StopCrawl(
            f"Profile {profile_id} 在 {timeout_seconds} 秒内没有收到 cls=13 响应。"
            "已停止，以免重复发送请求。"
        )

def run_browser_collection(args: argparse.Namespace, workdir: Path) -> None:
    """Fetch profile responses through a user-opened Chrome session, one at a time."""
    queue_path = workdir / "profile_ids_for_manual_capture.json"
    profile_cache_path = workdir / "profiles.json"
    profiles = load_profile_cache(profile_cache_path)

    if args.profile_id:
        # Explicit single-profile test intentionally re-requests the selected ID,
        # even if an older cache entry exists, so the live browser path is tested.
        queue_profiles = [{"profile_id": str(args.profile_id)}]
        pending = list(queue_profiles)
    else:
        queue = load_json(queue_path, None)
        if not isinstance(queue, dict) or not isinstance(queue.get("profiles"), list):
            raise StopCrawl(
                f"找不到待采集队列：{queue_path}。"
                "请先运行 准备排行榜.bat 获取两个榜单前 2000 名。"
            )
        queue_profiles = queue["profiles"]
        pending = [
            row for row in queue_profiles
            if str(row.get("profile_id", "")) not in profiles
        ]
    if args.limit is not None:
        pending = pending[:args.limit]

    if not pending:
        print("[完成] 当前没有待采集的 Profile ID。")
        finish_background_refresh(args, len(queue_profiles))
        return

    print(f"[队列] 本次待采集 {len(pending)} 人；请求间隔固定至少 10 秒。")
    client = ChromeDevTools(port=args.cdp_port)
    errors: list[dict[str, Any]] = []
    last_request_started: float | None = None

    try:
        client.connect()
        client.install_capture_and_reload()
        client.wait_for_profile_socket()

        for index, row in enumerate(pending, 1):
            pid = str(row["profile_id"])

            if last_request_started is not None:
                elapsed = time.monotonic() - last_request_started
                wait_seconds = max(0.0, PROFILE_REQUEST_INTERVAL_SECONDS - elapsed)
                if wait_seconds:
                    print(f"[间隔] 距上次请求不足 10 秒，等待 {wait_seconds:.1f} 秒。")
                    time.sleep(wait_seconds)

            print(f"[采集] {index}/{len(pending)}：Profile ID {pid}")
            last_request_started = time.monotonic()
            try:
                response = client.request_profile(pid)
            except StopCrawl as exc:
                if "没有收到 cls=13 响应" not in str(exc):
                    raise
                profile = {
                    "profile_id": pid,
                    "status": "TIMEOUT",
                    "accounts": [],
                    "checked_at": utc_now(),
                    "profile_url": AOE2RECS_PROFILE.format(profile_id=pid),
                    "protocol": "aoe2recs_ws_cls13_v1",
                    "note": str(exc),
                    "player": {},
                }
                profiles[pid] = profile
                save_profile_cache(profile_cache_path, profiles)
                errors.append(profile)
                print(f"[跳过] {pid}：45 秒内没有资料响应，继续下一个账号。")
                continue

            raw_dir = workdir / "ws_responses"
            raw_dir.mkdir(parents=True, exist_ok=True)
            raw_path = raw_dir / f"profile_{pid}.json"
            save_json(raw_path, {
                "requested_profile_id": pid,
                "response": response,
            })

            data = response.get("data")
            profile = normalize_profile_payload(pid, data)
            profile["source_file"] = str(raw_path)
            profiles[pid] = profile
            save_profile_cache(profile_cache_path, profiles)
            if args.site_cache_dir:
                site_cache_dir = Path(args.site_cache_dir)
                save_json(site_cache_dir / f"{pid}.json", {
                    "savedAt": int(time.time() * 1000),
                    "profile": data,
                })

            print(
                f"[成功] {pid}：{len(profile.get('accounts', []))} 个关联账号；"
                f"累计完成 {len(profiles)} 人。"
            )

            # Periodically refresh the partial workbook; JSON cache is saved after every profile.
            if index % 10 == 0 or index == len(pending):
                rm_rows, team_rows = load_cached_leaderboard_rows(workdir)
                if rm_rows or team_rows:
                    players = build_player_rows(rm_rows, team_rows)
                else:
                    players = players_from_profiles(profiles)
                errors = [p for p in profiles.values() if p.get("status") not in ("OK", "NOT_FOUND")]
                output = workdir / "aoe2_aliases_partial.xlsx"
                export_excel(output, players, profiles, rm_rows, team_rows, errors)
                print(f"[保存] {output}")

        rm_rows, team_rows = load_cached_leaderboard_rows(workdir)
        players = build_player_rows(rm_rows, team_rows) if (rm_rows or team_rows) else players_from_profiles(profiles)
        remaining = [row for row in queue_profiles if str(row.get("profile_id", "")) not in profiles]
        output = workdir / ("aoe2_aliases.xlsx" if not remaining and not args.profile_id else "aoe2_aliases_partial.xlsx")
        export_excel(output, players, profiles, rm_rows, team_rows, errors)
        print(f"[完成] Excel：{output}")
        print(f"[统计] 已缓存 Profile：{len(profiles)}；本次处理：{len(pending)}")
        finish_background_refresh(args, len(queue_profiles))
    finally:
        client.close()



def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="AOE2DE RM/TG RM leaderboard account-alias collector."
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--test-response", metavar="FILE", help="导入单个 cls=13 响应，生成 Lucho 测试 Excel。")
    mode.add_argument("--import-ws-json", nargs="+", metavar="FILE", help="导入一个或多个 WebSocket JSON 导出文件。")
    mode.add_argument("--prepare-leaderboards", action="store_true", help="获取两个榜单前 2000 名并生成 Profile ID 队列。")
    mode.add_argument("--collect-browser", action="store_true", help="通过正常打开的 Chrome 会话顺序采集 Profile。")
    parser.add_argument("--workdir", default="aoe2_alias_output", help="缓存与结果目录。")
    parser.add_argument("--api-delay", type=float, default=2.0, help="官方排行榜 API 请求间隔秒数。")
    parser.add_argument("--cdp-port", type=int, default=DEFAULT_CDP_PORT, help="本机 Chrome DevTools 端口，默认 9222。")
    parser.add_argument("--profile-id", help="只采集指定 Profile ID，例如 Lucho 的 9423131。")
    parser.add_argument("--limit", type=int, help="本次最多采集多少个待处理 Profile，用于小规模测试。")
    parser.add_argument("--site-cache-dir", help="每次成功后同时写入网站 AoE2Recs 资料缓存目录。")
    parser.add_argument("--site-chat-db", help="全部完成后写入一条站内聊天系统通知。")
    parser.add_argument("--restart-service-on-complete", help="全部完成后重启指定服务以清空进程内旧缓存。")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.api_delay < 1:
        print("参数无效：官方排行榜 API 请求间隔不得低于 1 秒。")
        return 2
    if args.cdp_port < 1 or args.cdp_port > 65535:
        print("参数无效：CDP 端口必须在 1 到 65535 之间。")
        return 2
    if args.limit is not None and args.limit < 1:
        print("参数无效：--limit 必须大于 0。")
        return 2
    if args.profile_id and not args.collect_browser:
        print("参数无效：--profile-id 只能与 --collect-browser 一起使用。")
        return 2

    workdir = Path(args.workdir).resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    session = make_session()
    try:
        if args.test_response:
            run_test_response(args, workdir)
        elif args.import_ws_json:
            run_import(args, workdir)
        elif args.prepare_leaderboards:
            run_prepare_leaderboards(args, session, workdir)
        elif args.collect_browser:
            run_browser_collection(args, workdir)
    except StopCrawl as exc:
        print("\n[安全停止]")
        print(exc)
        print("已有缓存与部分结果均保留。")
        return 3
    except KeyboardInterrupt:
        print("\n[用户中断] 已保留缓存与已导入数据。")
        return 130
    finally:
        session.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
