"""Build an explicit AoE2 entity -> benefiting technologies map from Seicing.

The source occasionally serves a mixed/garbled copy, so pages containing its
known mojibake marker are retried instead of being silently imported.
"""
from __future__ import annotations

import concurrent.futures
import json
import re
import time
from pathlib import Path
from urllib.parse import unquote, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "public" / "tech-tree-data" / "benefit-techs.json"
INDEXES = {
    "Unit": ("https://seicing.com/html/aoe2/index-aoe2units.html", "/unit/"),
    "Building": ("https://seicing.com/html/aoe2/index-aoe2buildings.html", "/buildings/"),
}
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9",
}


def normalized(value: str) -> str:
    return re.sub(r"\s+", "", value or "").strip()


def fetch(url: str, require_index: bool = False) -> str:
    last = ""
    for attempt in range(8):
        response = requests.get(url, headers=HEADERS, timeout=25)
        response.raise_for_status()
        last = response.content.decode("utf-8-sig", errors="replace")
        good_index = not require_index or ("帝国时代II" in last and ("单位" in last or "建筑" in last))
        garbled = "�" in last
        if good_index and not garbled:
            return last
        time.sleep(0.18 * (attempt + 1))
    raise RuntimeError(f"页面连续返回乱码：{url}")


def index_entries(kind: str, url: str, marker: str) -> list[dict]:
    soup = BeautifulSoup(fetch(url, True), "html.parser")
    entries = {}
    for anchor in soup.find_all("a", href=True):
        absolute = urljoin(url, anchor["href"])
        if marker not in urlparse(absolute).path:
            continue
        name = unquote(Path(urlparse(absolute).path).stem)
        if name and name not in {"index-aoe2units", "index-aoe2buildings"}:
            entries[absolute] = {"kind": kind, "name": normalized(name), "url": absolute}
    return list(entries.values())


def parse_entry(entry: dict) -> dict:
    soup = BeautifulSoup(fetch(entry["url"]), "html.parser")
    title = soup.select_one('.aoe4title[data-pagefind-weight="99999"]') or soup.select_one(".aoe4title")
    title_text = normalized(title.get_text(" ", strip=True) if title else "")
    english_match = re.search(r"[（(]([^()（）]+)[）)]$", title_text)
    english_name = english_match.group(1).strip() if english_match else ""
    heading = next((text for text in soup.find_all(string=True) if normalized(text) == "科技收益"), None)
    benefits = []
    if heading:
        row = heading.find_parent("tr")
        for benefit_row in row.find_next_siblings("tr"):
            cells = benefit_row.find_all("td", recursive=False)
            if any(cell.get("colspan") for cell in cells):
                break
            if len(cells) < 2:
                continue
            stat = normalized(cells[0].get_text(" ", strip=True))
            lines, parts = [], []
            for child in cells[1].children:
                if getattr(child, "name", None) == "br":
                    lines.append("".join(parts))
                    parts = []
                elif getattr(child, "get_text", None):
                    parts.append(child.get_text("", strip=True))
                else:
                    parts.append(str(child))
            if parts:
                lines.append("".join(parts))
            for line in lines:
                tech = normalized(re.split(r"[（(]", line, maxsplit=1)[0])
                if tech and tech not in {"无", "-", "—"}:
                    benefits.append({"stat": stat, "tech": tech})
    return {**entry, "englishName": english_name, "benefits": benefits}


def main() -> None:
    entries = []
    for kind, (url, marker) in INDEXES.items():
        found = index_entries(kind, url, marker)
        print(f"{kind}: {len(found)} indexed pages", flush=True)
        entries.extend(found)
    results, failures = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(parse_entry, entry): entry for entry in entries}
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            try:
                results.append(future.result())
            except Exception as exc:  # Preserve a complete audit trail.
                failures.append({**futures[future], "error": str(exc)})
            if index % 25 == 0 or index == len(entries):
                print(f"processed {index}/{len(entries)}; failures={len(failures)}", flush=True)
    if failures:
        retrying, failures = failures, []
        for entry in retrying:
            try:
                results.append(parse_entry({key: value for key, value in entry.items() if key != "error"}))
            except Exception as exc:
                failures.append({**entry, "error": str(exc)})
    payload = {
        "schemaVersion": 1,
        "sources": [value[0] for value in INDEXES.values()],
        "entries": sorted(results, key=lambda item: (item["kind"], item["name"])),
        "failures": failures,
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUTPUT}: entries={len(results)}, failures={len(failures)}", flush=True)


if __name__ == "__main__":
    main()
