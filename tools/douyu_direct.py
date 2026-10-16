#!/usr/bin/env python3
"""Experimental direct Douyu WebSocket sender.

The browser is only needed to refresh the short-lived login request template;
the actual room login, join and message send happen over a raw WebSocket.
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import struct
import time
import asyncio
from pathlib import Path

import websocket
from playwright.async_api import async_playwright


def esc(value: object) -> str:
    return str(value).replace('@', '@A').replace('/', '@S')


def packet(body: str) -> bytes:
    raw = body.encode('utf-8') + b'\x00'
    length = len(raw) + 8
    return struct.pack('<III', length, length, 689) + raw


def unpack(raw: bytes) -> str:
    if len(raw) < 13:
        return ''
    return raw[12:].rstrip(b'\x00').decode('utf-8', 'replace')


def fields(body: str) -> dict[str, str]:
    result = {}
    for item in body.split('/'):
        if '@=' in item:
            key, value = item.split('@=', 1)
            result[key] = value.replace('@S', '/').replace('@A', '@')
    return result


def load_login_body(path: Path) -> str:
    data = json.loads(path.read_text(encoding='utf-8'))
    if isinstance(data, str):
        return data
    return str(data['body'])


async def refresh_login_body(state_path: Path, room: str) -> str:
    """Bootstrap a fresh short-lived loginreq without sending a message."""
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=('--disable-blink-features=AutomationControlled',))
        context = await browser.new_context(storage_state=str(state_path), locale='zh-CN', timezone_id='Asia/Shanghai')
        page = await context.new_page()
        found: asyncio.Future[str] = asyncio.get_running_loop().create_future()

        def on_ws(ws):
            if 'wsproxy.douyu.com' not in ws.url:
                return
            def on_frame(payload):
                raw = payload if isinstance(payload, bytes) else str(payload).encode()
                if len(raw) < 13:
                    return
                body = raw[12:].rstrip(b'\x00').decode('utf-8', 'replace')
                if body.startswith('type@=loginreq') and not found.done():
                    found.set_result(body)
            ws.on('framesent', on_frame)

        page.on('websocket', on_ws)
        try:
            await page.goto(f'https://www.douyu.com/{room}', wait_until='domcontentloaded', timeout=30000)
            return await asyncio.wait_for(found, timeout=15)
        finally:
            await browser.close()


def send(room: str, message: str, state_path: Path, loginreq_path: Path, dry_run: bool = False, refresh: bool = True) -> tuple[bool, str]:
    if refresh:
        try:
            login_body = asyncio.run(refresh_login_body(state_path, room))
        except Exception as error:
            return False, f'刷新 loginreq 失败: {error}'
    else:
        login_body = load_login_body(loginreq_path)
    login = fields(login_body)
    if login.get('type') != 'loginreq':
        raise RuntimeError('loginreq 模板无效')
    login['roomid'] = room
    login_body = '/'.join(f'{k}@={esc(v)}' for k, v in login.items()) + '/'
    state = json.loads(state_path.read_text(encoding='utf-8'))
    cookie_header = '; '.join(f"{c['name']}={c['value']}" for c in state.get('cookies', []))
    ws = websocket.create_connection(
        'wss://wsproxy.douyu.com:6675',
        timeout=12,
        origin='https://www.douyu.com',
        host='wsproxy.douyu.com:6675',
        cookie=cookie_header,
        header=['User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36'],
    )
    try:
        ws.send(packet(login_body), opcode=websocket.ABNF.OPCODE_BINARY)
        logged_in = False
        deadline = time.time() + 12
        while time.time() < deadline:
            body = unpack(ws.recv())
            fs = fields(body)
            if fs.get('type') == 'loginres':
                logged_in = True
                break
        if not logged_in:
            return False, '未收到 loginres'
        ws.send(packet(f'type@=joingroup/rid@={esc(room)}/gid@=1/'), opcode=websocket.ABNF.OPCODE_BINARY)
        time.sleep(0.15)
        if dry_run:
            return True, 'loginres_and_joingroup_ok'
        now = int(time.time())
        uid = login.get('username', login.get('uid', ''))
        did = login.get('devid', '')
        body = (
            f'pe@=0/content@={esc(message)}/col@=5/type@=chatmessage/'
            f'dy@={esc(did)}/sender@={esc(uid)}/ifs@=0/nc@=0/dat@=0/'
            f'rev@=0/tts@={now}/admzq@=0/cst@={int(time.time()*1000)}/'
        )
        ws.send(packet(body), opcode=websocket.ABNF.OPCODE_BINARY)
        deadline = time.time() + 8
        while time.time() < deadline:
            incoming = unpack(ws.recv())
            fs = fields(incoming)
            if fs.get('type') == 'chatres':
                result = fs.get('res', '')
                return result == '0', f'chatres={result}'
        return False, '未收到 chatres'
    finally:
        ws.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--room', required=True)
    parser.add_argument('--message', required=True)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--loginreq', type=Path, required=True)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--no-refresh', action='store_true', help='使用已有 loginreq，不启动浏览器刷新')
    args = parser.parse_args()
    try:
        ok, detail = send(args.room, args.message, args.state, args.loginreq, args.dry_run, not args.no_refresh)
    except Exception as error:
        print(f'direct websocket failed: {error}')
        return 1
    print(detail)
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
