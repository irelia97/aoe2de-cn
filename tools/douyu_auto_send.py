#!/usr/bin/env python3
"""Internal JSON bridge for automatic Douyu notifications; no browser."""
import argparse
import json
from pathlib import Path
import sys

from douyu_direct_danmaku import MAX_MESSAGE_LENGTH, send_many
from douyu_command_listener import format_match, solo_ratings


def opening_messages(raw, profile_id, api_base):
    players = [dict(player, id=str(player.get('profileId') or player.get('id')),
                    number=player.get('number', index),
                    civilization_id=player.get('civilizationId') or player.get('civilization_id') or '')
               for index, player in enumerate(raw.get('players') or [])]
    match = dict(raw, players=players, rms=raw.get('rms') or raw.get('map') or raw.get('mapName') or '')
    ratings = solo_ratings(players, api_base) if len(players) > 2 else None
    messages = format_match(match, profile_id, ratings)
    if any(not message or len(message) > MAX_MESSAGE_LENGTH for message in messages):
        raise ValueError('Invalid opening message length')
    return messages


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['format-start', 'send'], required=True)
    parser.add_argument('--room', type=int, required=True)
    parser.add_argument('--state', type=Path, default=Path(__file__).resolve().parents[1] / '.cache/danmaku/douyu_storage_state.json')
    parser.add_argument('--api-base', default='http://127.0.0.1:3000')
    args = parser.parse_args()
    try:
        payload = json.load(sys.stdin)
        if args.mode == 'format-start':
            print(json.dumps(opening_messages(payload['match'], str(payload['profileId']), args.api_base), ensure_ascii=False), flush=True)
        else:
            send_many(args.room, payload['messages'], args.state, interval=10)
    except Exception as error:
        print(json.dumps({'stage': 'auto_failed', 'error': type(error).__name__}), flush=True)
        sys.exit(1)
