#!/usr/bin/env python3
"""Send one authenticated Douyu message without loading a room web page.

Protocol reference: ordinaryroad-live-chat-client DouyuMsgFactory/LoginreqMsg.
Requires websocket-client; reuses the private Playwright cookie state only.
No automatic resend: a missing acknowledgement has an uncertain outcome.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
import struct
import time
import urllib.request
from pathlib import Path

import websocket

MAX_MESSAGE_LENGTH = 60


@contextmanager
def sending_lock(state):
    # Automatic notifications and chat commands run in separate processes.
    if os.name != 'posix':
        yield
        return
    import fcntl
    path = Path(state).parent / 'douyu_send.lock'
    with os.fdopen(os.open(path, os.O_CREAT | os.O_RDWR, 0o600), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)

def pack(fields):
    def escape(value):
        return str(value).replace('@', '@A').replace('/', '@S')
    body = (''.join(f'{escape(k)}@={escape(v)}/' for k, v in fields.items()) + '\0').encode()
    length = len(body) + 8
    return struct.pack('<IIHBB', length, length, 689, 0, 0) + body


def unpack(data):
    result = []
    while len(data) >= 12:
        length = struct.unpack_from('<I', data)[0]
        if length < 9 or length > 4_000_000:
            raise ValueError('Invalid Douyu frame length')
        if len(data) < length + 4:
            break
        body = data[12:length + 4].rstrip(b'\0').decode('utf-8', 'replace')
        fields = {}
        for item in body.split('/'):
            if '@=' in item:
                key, value = item.split('@=', 1)
                fields[key] = value.replace('@S', '/').replace('@A', '@')
        result.append(fields)
        data = data[length + 4:]
    return result, data


def send(room, message, state):
    return send_many(room, [message], state, interval=0)


def send_many(room, messages, state, interval=10):
    messages = list(messages)
    if not messages or any(not message.strip() or len(message) > MAX_MESSAGE_LENGTH for message in messages):
        raise ValueError(f'Messages must each contain 1–{MAX_MESSAGE_LENGTH} characters')
    with sending_lock(state):
        return _send_many(room, messages, state, interval)


def _send_many(room, messages, state, interval=10):
    messages = list(messages)
    if not messages or any(not message.strip() or len(message) > MAX_MESSAGE_LENGTH for message in messages):
        raise ValueError(f'Messages must each contain 1–{MAX_MESSAGE_LENGTH} characters')
    if interval < 0:
        raise ValueError('Interval must be nonnegative')
    cookies = {c['name']: c['value'] for c in json.loads(state.read_text())['cookies']
               if c['domain'].lstrip('.') == 'douyu.com' or c['domain'].endswith('.douyu.com')}
    for key in ['acf_uid', 'acf_ltkid', 'acf_stk', 'dy_did']:
        if not cookies.get(key):
            raise ValueError(f'Missing login cookie: {key}')
    request = urllib.request.Request(
        f'https://www.douyu.com/lapi/live/gateway/web/{room}?isH5=1', data=b'',
        headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.douyu.com/'})
    with urllib.request.urlopen(request, timeout=20) as response:
        gateway = json.load(response)
    if gateway.get('error') != 0:
        raise RuntimeError(f'Gateway error: {gateway.get("error")}')
    endpoint = gateway['data']['wss'][0]
    started = time.monotonic()
    ws = websocket.create_connection(f'wss://{endpoint["domain"]}:{endpoint["port"]}/',
                                     origin='https://www.douyu.com', timeout=15)
    pending = b''
    def wait_for(kind):
        nonlocal pending
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            incoming = ws.recv()
            if not incoming:
                raise RuntimeError('Connection closed')
            pending += incoming.encode() if isinstance(incoming, str) else incoming
            messages, pending = unpack(pending)
            for fields in messages:
                if fields.get('type') == 'error':
                    raise RuntimeError(f'Douyu error: {fields.get("code", fields.get("res", "unknown"))}')
                if fields.get('type') == kind:
                    return fields
        raise TimeoutError(f'No {kind} acknowledgement; do not resend automatically')
    try:
        now = int(time.time())
        did = cookies['dy_did']
        ws.send_binary(pack(dict(type='loginreq', roomid=room, dfl='sn@A=105@Sss@A=1',
            username=cookies['acf_uid'], password='', ltkid=cookies['acf_ltkid'], biz='1',
            stk=cookies['acf_stk'], devid=did, ct=0, pt=2, cvr=0, tvr=7, apd='', rt=now,
            vk=hashlib.md5((str(now) + "r5*^5;}2#${XF[h+;'./.Q'1;,-]f'p[" + did).encode()).hexdigest(),
            ver='20220825', aver='218101901', dmbt='chrome', dmbv='123')))
        login = wait_for('loginres')
        if login.get('userid', login.get('uid', cookies['acf_uid'])) != cookies['acf_uid']:
            raise RuntimeError('Login returned a different user')
        print(json.dumps({'stage': 'authenticated', 'room': room}, ensure_ascii=False), flush=True)
        ws.send_binary(pack(dict(type='keeplive', tick=int(time.time()), cnd='hs-h5')))
        for index, message in enumerate(messages, 1):
            if index > 1:
                time.sleep(interval)
                ws.send_binary(pack(dict(type='keeplive', tick=int(time.time()), cnd='hs-h5')))
            now_ms = int(time.time() * 1000)
            ws.send_binary(pack(dict(type='chatmessage', pe=0, content=message, col=0,
                dy=did, sender=cookies['acf_uid'], ifs=0, nc=0, dat=0, rev=0,
                tts=now_ms // 1000, admzq=0, cst=now_ms + 9000)))
            ack = wait_for('chatres')
            result = {'room': room, 'part': index, 'message': message, 'res': ack.get('res'),
                      'elapsedSeconds': round(time.monotonic() - started, 2)}
            print(json.dumps(result, ensure_ascii=False), flush=True)
            if ack.get('res') != '0':
                raise RuntimeError(f'Douyu rejected message: {ack.get("res")}')
    finally:
        ws.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--room', required=True, type=int)
    parser.add_argument('--message', required=True)
    parser.add_argument('--state', type=Path, default=Path(__file__).resolve().parents[1] / '.cache/danmaku/douyu_storage_state.json')
    args = parser.parse_args()
    try:
        send(args.room, args.message, args.state)
    except Exception as error:
        # Never print login packets, cookie values, or websocket headers.
        print(json.dumps({'error': type(error).__name__, 'reason': str(error)}, ensure_ascii=False))
        raise SystemExit(1)
