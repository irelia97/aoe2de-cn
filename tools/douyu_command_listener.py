#!/usr/bin/env python3
"""Listen for explicit chat commands without a browser; never execute chat as code."""
import argparse
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import subprocess
from queue import Queue, Empty, Full
from threading import Event, Lock, Thread
import time
import urllib.request

import websocket
from douyu_direct_danmaku import MAX_MESSAGE_LENGTH, pack, unpack, send_many

COUNTRIES = json.loads((Path(__file__).resolve().parents[1] /
                       'config/danmaku-country-names-zh.json').read_text(encoding='utf-8'))

CIVILIZATIONS = {'armenians': '亚美尼亚', 'aztecs': '阿兹特克', 'bengalis': '孟加拉', 'berbers': '柏柏尔', 'bohemians': '波希米亚', 'britons': '不列颠', 'bulgarians': '保加利亚', 'burgundians': '勃艮第', 'burmese': '缅甸', 'byzantines': '拜占庭', 'celts': '凯尔特', 'chinese': '中国', 'cumans': '库曼', 'danes': '丹麦', 'dravidians': '达罗毗荼', 'ethiopians': '埃塞俄比亚', 'franks': '法兰克', 'georgians': '格鲁吉亚', 'goths': '哥特', 'gurjaras': '瞿折罗', 'hindustanis': '印度斯坦', 'huns': '匈奴', 'incas': '印加', 'inca': '印加', 'italians': '意大利', 'japanese': '日本', 'jurchens': '女真', 'khitans': '契丹', 'khmer': '高棉', 'koreans': '高丽', 'lithuanians': '立陶宛', 'magyars': '马扎尔', 'malay': '马来', 'malays': '马来', 'malians': '马里', 'mapuche': '马普切', 'maya': '玛雅', 'mayans': '玛雅', 'mongols': '蒙古', 'muisca': '穆伊斯卡', 'persians': '波斯', 'poles': '波兰', 'portuguese': '葡萄牙', 'romans': '罗马', 'saracens': '撒拉逊', 'saxons': '撒克逊', 'shu': '蜀', 'sicilians': '西西里', 'slavs': '斯拉夫', 'spanish': '西班牙', 'tatars': '鞑靼', 'teutons': '条顿', 'turks': '土耳其', 'tupi': '图皮', 'varangians': '瓦兰吉', 'vietnamese': '越南', 'vikings': '维京', 'wei': '魏', 'wu': '吴'}
MAPS = {'Arabia': '阿拉伯半岛', 'Archipelago': '群岛', 'Baltic': '波罗的海', 'Black Forest': '黑森林', 'Coastal': '沿海', 'Continental': '大陆', 'Crater Lake': '火山湖', 'Fortress': '堡垒', 'Gold Rush': '淘金潮', 'Highland': '高地', 'Islands': '岛屿', 'Mediterranean': '地中海', 'Migration': '迁移', 'Rivers': '河流', 'Team Islands': '团队岛屿', 'Full Random': '完全随机地图', 'Scandinavia': '斯堪的纳维亚', 'Socotra': '索科特拉岛', 'Mongolia': '蒙古', 'Salt Marsh': '盐碱沼泽', 'Yucatan': '尤卡坦', 'Arena': '竞技场', 'King of the Hill': '占山为王', 'Oasis': '绿洲', 'Ghost Lake': '幽灵湖', 'Random Land Map': '随机陆地地图', 'Execute On Load': '加载时执行', 'Nomad': '游牧', 'Blind Random': '绝对随机地图', 'Hidden': '隐藏', 'Objectives': '任务', 'Hints': '提示', 'Scouts': '侦察', 'Acropolis': '雅典卫城', 'Budapest': '布达佩斯', 'Cenotes': '岩坑池地', 'City of Lakes': '百湖之城', 'Golden Pit': '金矿谷', 'Hideout': '藏身之处', 'Hill Fort': '山寨', 'Lombardia': '伦巴第', 'Steppe': '干草原', 'Valley': '峡谷', 'MegaRandom': '超级随机', 'Hamburger': '汉堡包', 'CtR Random': '争夺圣物随机地图', 'CtR Monsoon': '争夺圣物雨季沼泽', 'CtR Pyramid Descent': '争夺圣物决战金字塔之巅', 'CtR Spiral': '争夺圣物漩涡迷航', 'Golden Swamp': '金沼泽', 'Four Lakes': '四片湖泊', 'Land Nomad': '陆地游牧', 'BR Battle On Ice': '大逃杀冰上战斗', 'BR El Dorado': '大逃杀黄金国', 'BR Fall of Axum': '大逃杀阿克苏姆的衰落', 'BR Fall of Rome': '大逃杀罗马的衰落', 'BR Majapahit Empire': '大逃杀满者伯夷帝国', 'Amazon Tunnel': '亚马逊隧道', 'Coastal Forest': '沿海森林', 'African Clearing': '非洲林中空地', 'Atacama': '阿塔卡马', 'Seize The Mountain': '攻占山头', 'Crater': '弹坑', 'Crossroads': '十字路口', 'Michi': '开道', 'Team Moats': '团队护城河', 'Volcanic Island': '火山岛', 'Acclivity': '上坡', 'Eruption': '火山喷发', 'Frigid Lake': '酷寒之湖', 'Greenland': '格陵兰', 'Lowland': '低地', 'Marketplace': '市场', 'Meadow': '草地', 'Mountain Range': '山脉', 'Northern Isles': '北方群岛', 'Ring Fortress': '环形要塞', 'Runestones': '符文石群', 'Aftermath': '余波荡漾', 'Enclosed': '与世隔绝', 'Haboob': '哈布风暴', 'Kawasan': '卡瓦森', 'Land Madness': '癫狂之地', 'Sacred Springs': '圣泉', 'Wade': '浅滩', 'Morass': '沼泽', 'Shoals': '浅滩', 'Cliffbound': '紧邻悬崖', 'Isthmus': '地峡', 'Dunesprings': '沙丘泉', 'Golden Stream': '金色溪流', 'Mountain Dunes': '山地沙丘', 'River Divide': '河流分叉口', 'Sandrift': '流沙', 'Shrubland': '灌木丛', 'The Passage': '走廊', 'Hollow Woodlands': '山谷林地', 'Karsts': '喀斯特地貌', 'Glade': '林间空地', 'Fortified Clearing': '强化空地', 'QS Arabia': 'QS 阿拉伯', 'QS Fortified Clearing': 'QS 强化空地', 'QS Glade': 'QS 林中空地', 'QS Nomad': 'QS 游牧', 'Canals': '运河', 'Capricious': '变幻莫测', 'Dingos': '澳洲野犬', 'Graveyards': '坟墓', 'Metropolis': '大都市', 'Moats': '护城河', 'Paradise Island': '天堂岛', 'Pilgrims': '朝圣者', 'Prairie': '大草原', 'Seasons': '四季', 'Sherwood Forest': '雪伍德森林', '': '', 'Shipwreck': '船只遗骸', 'Team Glaciers': '团队冰川', 'Stranded': '孤岛求生', 'Pregame Cinematic': '游戏片头过场动画', 'Victory Cinematic': '胜利过场动画', 'Loss Cinematic': '失败过场动画', 'Scenario Instruction Map': '场景指南地图', 'QS Runestones': 'QS 符文石群', 'QS Arena': 'QS 竞技场', 'QS Black Forest': 'QS 黑森林', 'Great Wall': '长城', 'Sardis': '萨迪斯', 'Aquarena': '水上竞技场', 'Forest Breach': '森林缺口', 'Border Dispute': '边境纷争', 'Graupel': '霰雪', 'Chaos Pit': '混沌之坑', 'Mired': '泥沼', 'Murkwood': '黑雾林', 'Crownwood': '克朗伍德', 'Dorothea Quarry': '多罗西亚采石场', 'Glacis': '格拉西斯', 'Hengehold': '亨格霍尔德', 'Loch Ness': '尼斯湖', 'Rampart': '壁垒', 'Stonefront': '石阵防线', 'Thames': '泰晤士河', 'Vulpine': '狐影林', 'Arabian Desert': '阿拉伯沙漠'}
SERVERS = {'australia': '澳大利亚', 'australiasoutheast': '澳大利亚东南部', 'brazilsouth': '巴西南部', 'eastasia': '东亚', 'koreacentral': '韩国中部', 'southeastasia': '东南亚', 'southafricanorth': '南非北部', 'uksouth': '英国南部', 'ukwest': '英国西部', 'westeurope': '西欧', 'centralindia': '印度中部', 'westindia': '印度西部', 'westus': '美国西部', 'westus2': '美国西部2', 'eastus': '美国东部', 'eastus2': '美国东部2', 'centralus': '美国中部'}

def compact(value, limit, ellipsis='…'):
    value = ' '.join(str(value or '').split())
    return value if len(value) <= limit else value[:limit - len(ellipsis)] + ellipsis


def match_sides(match, profile_id):
    players = match.get('players') or []
    ids = [str(p.get('id') or '') for p in players]
    if len(set(ids)) != len(ids) or not all(ids):
        raise ValueError('Invalid match players')
    teams = match.get('teams') or []
    if teams:
        numbers = {str(p.get('number')): str(p['id']) for p in players}
        groups = [[numbers.get(str(member)) for member in team.get('members', [])] for team in teams]
    else:
        groups_by_team = {}
        for player in players:
            team = player.get('team')
            if team in (None, -1, 0):
                raise ValueError('Unknown team membership')
            groups_by_team.setdefault(str(team), []).append(str(player['id']))
        groups = list(groups_by_team.values())
    members = [pid for group in groups for pid in group]
    if (len(groups) != 2 or not all(groups) or None in members or
            len(members) != len(ids) or set(members) != set(ids)):
        raise ValueError('Expected two complete opposing teams')
    own = next((group for group in groups if str(profile_id) in group), None)
    if own is None:
        raise ValueError('Requested player missing from teams')
    other = next(group for group in groups if group is not own)
    return own, other


def solo_ratings(players, api_base):
    def lookup(player):
        pid = str(player['id'])
        try:
            data = api_json(api_base, f'/api/profile-leaderboards?id={pid}')
            row = next((row for row in data.get('leaderboards', []) if str(row.get('id')) == '3'), None)
            if row is None:
                raise ValueError('Missing solo leaderboard response')
            wins, losses = row.get('wins'), row.get('losses')
            if row.get('hasData') is False or (type(wins) is int and type(losses) is int and wins + losses == 0):
                return pid, None
            # Inactive/unranked players retain their current rating; rank is irrelevant.
            rating = row.get('rating')
            if type(rating) not in (int, float) or not 0 <= rating < 10000:
                raise ValueError('Solo rating unavailable for existing player')
            return pid, rating
        except Exception as error:
            print(json.dumps({'stage': 'solo_rating_failed', 'profileId': pid,
                              'error': type(error).__name__}), flush=True)
            raise
    with ThreadPoolExecutor(max_workers=4) as pool:
        return dict(pool.map(lookup, players))


def team_match_title(match, profile_id, ratings):
    own, other = match_sides(match, profile_id)
    colors = {str(p['id']): int(p['color']) for p in match['players']}
    if any(not 1 <= color <= 8 for color in colors.values()) or len(set(colors.values())) != len(colors):
        raise ValueError('Invalid player colors')
    def scores(members):
        ordered = sorted(members, key=lambda pid: colors[pid])
        return '/'.join('-' if ratings[pid] is None else str(int(ratings[pid])) for pid in ordered)
    own_scores, other_scores = scores(own), scores(other)
    return f'主播({own_scores}) vs 对手({other_scores})'


def format_match(match, profile_id, ratings=None):
    players = match.get('players') or []
    player = next((p for p in players if str(p.get('id')) == str(profile_id)), None)
    if player is None:
        raise ValueError('Requested player missing from match')
    if len(players) > 2:
        first = team_match_title(match, profile_id, ratings or {})
    else:
        opponents = [p for p in players if p is not player and
                     (player.get('team') in (None, -1, 0) or p.get('team') != player.get('team'))]
        if not opponents:
            opponents = [p for p in players if p is not player]
        def label(p, limit):
            rating = p.get('rating')
            rating = str(rating) if rating is not None else '未知分数'
            civ = str(p.get('civilization') or p.get('civilization_id') or '未知民族')
            civ = CIVILIZATIONS.get(civ.lower(), civ)
            return f"{compact(p.get('name') or p.get('id'), limit, '.')}({rating},{compact(civ, 8, '.')})"

        for name_limit in (16, 12, 8, 5, 3):
            rival = label(opponents[0], name_limit) if opponents else '未知对手'
            if len(opponents) > 1:
                rival += f'等{len(opponents)}人'
            allies = sum(1 for p in players if p is not player and player.get('team') not in (None, -1, 0)
                         and p.get('team') == player.get('team'))
            own = label(player, name_limit) + (f'+{allies}' if allies else '')
            first = f'{own} vs {rival}'
            if len(first) <= MAX_MESSAGE_LENGTH:
                break
        else:
            raise ValueError('Player summary exceeds message limit')
    map_name = str(match.get('rms') or '未知地图')
    map_name = MAPS.get(map_name, map_name)
    mode = {'RM 1V1': '1v1', 'RM TG': '组排'}.get(profile_ladder(match), '大厅局')
    server = str(match.get('server') or '未知服务器')
    server = SERVERS.get(server.lower().replace(' ', '').replace('-', ''), server)
    second = f"{compact(map_name, 20, '.')}, {mode}, {compact(server, 20, '.')}"
    return [first, second]


def is_one_vs_one(match):
    players = match.get('players') or []
    if len(players) != 2:
        return False
    ids = [str(p.get('id') or '') for p in players]
    if not all(ids) or ids[0] == ids[1]:
        return False
    modes = [str(match.get(key) or '').upper().replace('_', ' ')
             for key in ('leaderboard', 'type', 'diplomacy')]
    if any(mode in ('TG', 'FFA', 'TEAM', 'TEAMS') or mode.endswith(' TG') for mode in modes):
        return False
    teams = [p.get('team') for p in players]
    return not (teams[0] not in (None, -1, 0) and teams[0] == teams[1])


def api_json(api_base, path):
    request = urllib.request.Request(
        f'{api_base.rstrip("/")}{path}',
        headers={'Accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def latest_match(profile_id, api_base, live_only=True, one_vs_one_only=True):
    payload = api_json(api_base, f'/api/profile-matches?id={profile_id}&latest=1')
    matches = payload.get('matches') or []
    if not matches or payload.get('stale') is True:
        return None
    match = matches[0]
    if live_only and (match.get('live') is not True or match.get('finished') or match.get('abandoned')):
        return None
    if one_vs_one_only and not is_one_vs_one(match):
        return None
    if not match.get('id'):
        raise ValueError('Missing match ID')
    if not any(str(p.get('id')) == str(profile_id) for p in match['players']):
        raise ValueError('Requested player missing from match')
    return match


def latest_reply(profile_id, api_base):
    match = latest_match(profile_id, api_base, one_vs_one_only=False)
    if not match or len(match.get('players') or []) < 2:
        return None, []
    ratings = None
    if len(match['players']) > 2:
        # Validate membership before querying: never merge unrelated enemy teams.
        match_sides(match, profile_id)
        ratings = solo_ratings(match['players'], api_base)
    return str(match['id']), format_match(match, profile_id, ratings)


def profile_ladder(match):
    raw = re.sub(r'\s+', '_', str(match.get('leaderboard') or '').strip().upper())
    aliases = {'RM_1V1': 'RM 1V1', 'RM_TG': 'RM TG', 'RM_TEAM': 'RM TG',
               'EW_1V1': 'EW 1V1', 'EW_TG': 'EW TG', 'EW_TEAM': 'EW TG',
               'DM_1V1': 'DM 1V1', 'DM_TG': 'DM TG', 'DM_TEAM': 'DM TG'}
    if raw in aliases:
        return aliases[raw]
    if not raw or raw == 'UNRANKED':
        return 'LOBBY'
    return raw.replace('_', ' ')


def favorite_civilization(matches, player_id, current_match):
    # Match the profile page's 100-match window and per-leaderboard groups.
    target = profile_ladder(current_match)
    counts = Counter()
    for match in matches:
        if profile_ladder(match) != target or match.get('live') is True:
            continue
        if not match.get('finished') and match.get('abandoned') is not True:
            continue
        player = next((p for p in match.get('players', []) if str(p.get('id')) == str(player_id)), None)
        if not player:
            continue
        raw = str(player.get('civilization') or '').strip()
        stripped = re.sub(r'\s+\(.*\)$', '', raw)
        name = CIVILIZATIONS.get(stripped.lower(), raw or '未知民族')
        if name != '未知民族':
            counts[name] += 1
    if not counts:
        return '暂无', None
    highest = max(counts.values())
    tied = [name for name, count in counts.items() if count == highest]
    if len(tied) == 1:
        return tied[0], highest
    # The page breaks ties with localeCompare('zh-CN'); use the same Node ICU.
    script = ('let input="";process.stdin.setEncoding("utf8");'
              'process.stdin.on("data",s=>input+=s);process.stdin.on("end",()=>'
              'process.stdout.write(JSON.parse(input).sort((a,b)=>a.localeCompare(b,"zh-CN"))[0]));')
    result = subprocess.run(['/usr/bin/node', '-e', script], input=json.dumps(tied),
                            text=True, capture_output=True, check=True, timeout=5)
    return result.stdout.strip(), highest


def format_player(player, profile, leaderboards, favorite='暂无', favorite_count=None):
    country_code = str(profile.get('country_code') or player.get('country') or '').upper()
    country = compact(COUNTRIES.get(country_code, '未知地区'), 8)

    def ladder(ladder_id, label):
        row = next((row for row in leaderboards if str(row.get('id')) == str(ladder_id)), {})
        rating = row.get('rating')
        rating = str(rating) if rating is not None else '暂无'
        return f'{label} {rating}'

    favorite_text = compact(favorite, 10)
    if favorite_count is not None:
        favorite_text += f'{favorite_count}场'
    suffix = f", 来自{country}, {ladder(3, '1v1')}, {ladder(4, '组排')}, 近期最爱{favorite_text}"
    name_limit = MAX_MESSAGE_LENGTH - len(suffix)
    if name_limit < 2:
        raise ValueError('Player details exceed message limit')
    return compact(player.get('name') or profile.get('name') or player.get('id'), name_limit) + suffix


def player_reply(profile_id, color, api_base):
    match = latest_match(profile_id, api_base, one_vs_one_only=False)
    if not match:
        return None, None
    players = [p for p in match['players'] if str(p.get('color')) == str(color)]
    if len(players) != 1:
        print(json.dumps({'stage': 'player_not_found', 'color': color, 'matchId': match['id']}), flush=True)
        return None, None
    player = players[0]
    player_id = str(player['id'])
    profile = api_json(api_base, f'/api/profile-details?id={player_id}')
    stats = api_json(api_base, f'/api/profile-leaderboards?id={player_id}')
    if not isinstance(stats.get('leaderboards'), list):
        raise ValueError('Missing player leaderboard data')
    try:
        history = api_json(api_base, f'/api/profile-matches?id={player_id}&offset=0&limit=100')
        if not isinstance(history.get('matches'), list):
            raise ValueError('Missing recent matches')
        favorite, favorite_count = favorite_civilization(history['matches'], player_id, match)
    except Exception as error:
        print(json.dumps({'stage': 'favorite_query_failed', 'profileId': player_id,
                          'error': type(error).__name__}), flush=True)
        favorite = '未知'
        favorite_count = None
    return player_id, format_player(player, profile.get('player') or {}, stats['leaderboards'], favorite, favorite_count)


def handle_player_command(room, profile_id, color, api_base, state, player_cooldown, dry_run=False):
    if player_cooldown.blocked(str(color), time.monotonic()):
        print(json.dumps({'stage': 'player_cooldown', 'color': color}), flush=True)
        return False
    player_id, message = player_reply(profile_id, color, api_base)
    if not message:
        return False
    print(json.dumps({'stage': 'player_reply', 'profileId': player_id,
                      'message': message, 'dryRun': dry_run}, ensure_ascii=False), flush=True)
    if not dry_run:
        send_many(room, [message], state, interval=0)
        player_cooldown.mark_sent(str(color), time.monotonic())
        print(json.dumps({'stage': 'player_sent', 'profileId': player_id,
                          'cooldownSeconds': player_cooldown.seconds}), flush=True)
    return True


class MatchCooldown:
    def __init__(self, seconds=0):
        self.seconds = seconds
        self.sent_at = {}

    def blocked(self, match_id, now):
        if self.seconds <= 0:
            return False
        self.sent_at = {key: timestamp for key, timestamp in self.sent_at.items()
                        if now - timestamp < self.seconds}
        return str(match_id) in self.sent_at

    def mark_sent(self, match_id, now):
        if self.seconds > 0:
            self.sent_at[str(match_id)] = now


def publish_reply(room, match_id, replies, state, match_cooldown, dry_run=False):
    if match_cooldown.blocked(match_id, time.monotonic()):
        print(json.dumps({'stage': 'match_cooldown', 'room': room, 'matchId': match_id}), flush=True)
        return False
    if len(replies) != 2:
        raise ValueError('Expected two match messages')
    for index, message in enumerate(replies, 1):
        print(json.dumps({'stage': 'reply', 'room': room, 'part': index,
                          'message': message, 'dryRun': dry_run}, ensure_ascii=False), flush=True)
    if not dry_run:
        try:
            send_many(room, replies, state, interval=10)
        except Exception as error:
            # Never retry an uncertain or rejected send.
            print(json.dumps({'stage': 'send_failed', 'error': type(error).__name__}), flush=True)
            return False
    if not dry_run:
        match_cooldown.mark_sent(match_id, time.monotonic())
        print(json.dumps({'stage': 'pair_sent', 'room': room, 'matchId': match_id,
                          'cooldownSeconds': match_cooldown.seconds}), flush=True)
    return True


def lastmatch_age(match, now=None):
    finished = match.get('finished')
    if type(finished) not in (int, float) or not finished > 0:
        return '结束时间未知'
    seconds = max(0, int((time.time() if now is None else now) - finished))
    if seconds < 60:
        return '刚刚'
    if seconds < 3600:
        return f'{seconds // 60}分钟前'
    if seconds < 86400:
        return f'{seconds // 3600}小时前'
    return f'{seconds // 86400}天前'


def format_lastmatch(match, profile_id):
    players = match.get('players') or []
    player = next((p for p in players if str(p.get('id')) == str(profile_id)), None)
    if player is None or len(players) < 2:
        raise ValueError('Invalid previous match players')
    own_team = next((team for team in match.get('teams', [])
                     if str(player.get('number')) in [str(n) for n in team.get('members', [])]), {})
    if match.get('abandoned'):
        result = '已中止'
    elif player.get('winner') is True or own_team.get('winner') is True:
        result = '胜利'
    elif any(p.get('winner') is True for p in players) or any(t.get('winner') is True for t in match.get('teams', [])):
        result = '失败'
    else:
        result = '结果未知'
    ladder = profile_ladder(match)
    modes = {'RM 1V1': '1v1', 'RM TG': '组排',
             'EW 1V1': '1v1帝国战争', 'EW TG': '团队帝国战争',
             'DM 1V1': '1v1死亡竞赛', 'DM TG': '团队死亡竞赛'}
    mode = modes.get(ladder, '大厅局')
    raw_map = str(match.get('rms') or '未知地图')
    map_name = compact(MAPS.get(raw_map, raw_map), 12, '.')
    delta = None
    if mode != '大厅局':
        value = player.get('ratingDelta')
        delta = f'{int(value):+d}' if type(value) in (int, float) and -10000 < value < 10000 else '积分未知'
    for limit in (16, 12, 8, 5, 3, 1):
        parts = [result]
        if len(players) == 2:
            other = next(p for p in players if p is not player)
            parts.append(f"vs {compact(other.get('name') or other['id'], limit, '.')}")
        parts.extend([map_name, mode])
        if delta is not None:
            parts.append(delta)
        parts.append(lastmatch_age(match))
        message = ', '.join(parts)
        if len(message) <= MAX_MESSAGE_LENGTH:
            return message
    raise ValueError('Previous match summary exceeds message limit')


def lastmatch_reply(profile_id, api_base, position=1):
    if type(position) is not int or not 1 <= position <= 10:
        raise ValueError('Previous match position must be 1–10')
    history = api_json(api_base, f'/api/profile-matches?id={profile_id}&offset=0&limit=100')
    if not isinstance(history.get('matches'), list):
        raise ValueError('Missing recent matches')
    matches = sorted(history['matches'], key=lambda match: float(match.get('started') or 0), reverse=True)
    seen = set()
    completed = 0
    for match in matches:
        if match.get('live') is True or (not match.get('finished') and not match.get('abandoned')):
            continue
        if not any(str(p.get('id')) == str(profile_id) for p in match.get('players', [])):
            continue
        if not match.get('id'):
            raise ValueError('Missing previous match ID')
        if str(match['id']) in seen:
            continue
        seen.add(str(match['id']))
        completed += 1
        if completed != position:
            continue
        return str(match['id']), format_lastmatch(match, profile_id)
    return None, None


def handle_lastmatch_command(room, profile_id, api_base, state, last_cooldown, dry_run=False, position=1):
    if last_cooldown.blocked('lastmatch', time.monotonic()):
        print(json.dumps({'stage': 'lastmatch_cooldown', 'position': position}), flush=True)
        return False
    match_id, message = lastmatch_reply(profile_id, api_base, position)
    if not message:
        print(json.dumps({'stage': 'no_previous_match', 'profileId': profile_id, 'position': position}), flush=True)
        return False
    print(json.dumps({'stage': 'lastmatch_reply', 'matchId': match_id, 'position': position,
                      'message': message, 'dryRun': dry_run}, ensure_ascii=False), flush=True)
    if not dry_run:
        send_many(room, [message], state, interval=0)
        last_cooldown.mark_sent('lastmatch', time.monotonic())
    return True


class Commands:
    def __init__(self, own_uid):
        self.own_uid = str(own_uid)
        self.seen = set()
        self.order = deque()

    def reply(self, fields):
        if fields.get('type') != 'chatmsg' or str(fields.get('uid')) == self.own_uid:
            return None
        content = fields.get('txt', '').strip()
        if content != '#match' and not re.fullmatch(r'#lastmatch(?:[1-9]|10)?|#p[1-8]', content):
            return None
        if content == '#lastmatch1':
            content = '#lastmatch'
        identity = fields.get('cid')
        if not identity or identity in self.seen:
            return None
        self.seen.add(identity)
        self.order.append(identity)
        if len(self.order) > 5000:
            self.seen.remove(self.order.popleft())
        return content


class CommandWorker:
    """One sender owns all cooldown state; the receiver never waits for I/O."""

    def __init__(self, process, cooldown=0, capacity=19, max_age=60):
        self.process = process
        self.cooldown = cooldown
        self.max_age = max_age
        self.queue = Queue(maxsize=capacity)
        self.pending = set()
        self.lock = Lock()
        self.stopping = Event()
        self.thread = Thread(target=self.run, name='douyu-command-worker', daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.stopping.set()
        self.thread.join(timeout=1)

    def submit(self, command):
        with self.lock:
            if self.stopping.is_set():
                return False
            if command in self.pending:
                print(json.dumps({'stage': 'command_skipped', 'command': command,
                                  'reason': 'already_pending'}), flush=True)
                return False
            try:
                self.queue.put_nowait((command, time.monotonic()))
            except Full:
                print(json.dumps({'stage': 'command_skipped', 'command': command,
                                  'reason': 'queue_full'}), flush=True)
                return False
            self.pending.add(command)
            print(json.dumps({'stage': 'command_queued', 'command': command}), flush=True)
            return True

    def run(self):
        next_ready = 0
        while not self.stopping.is_set():
            try:
                command, received_at = self.queue.get(timeout=0.2)
            except Empty:
                continue
            try:
                if self.stopping.wait(max(0, next_ready - time.monotonic())):
                    return
                if time.monotonic() - received_at > self.max_age:
                    print(json.dumps({'stage': 'command_skipped', 'command': command,
                                      'reason': 'queue_expired'}), flush=True)
                    continue
                self.process(command)
            except Exception as error:
                print(json.dumps({'stage': 'command_failed', 'command': command,
                                  'error': type(error).__name__}), flush=True)
            finally:
                next_ready = time.monotonic() + self.cooldown
                with self.lock:
                    self.pending.discard(command)
                self.queue.task_done()


def listen(room, state, cooldown=0, duration=0, dry_run=False,
           profile_id='4153011', api_base='http://127.0.0.1:3000'):
    cookies = json.loads(state.read_text())['cookies']
    uid = next(c['value'] for c in cookies if c['name'] == 'acf_uid')
    commands = Commands(uid)
    match_cooldown = MatchCooldown(seconds=300)
    player_cooldown = MatchCooldown(seconds=300)
    last_cooldown = MatchCooldown(seconds=30)
    def process_command(triggered):
        print(json.dumps({'stage': 'command', 'room': room, 'command': triggered}), flush=True)
        if triggered.startswith('#lastmatch'):
            position = int(triggered[len('#lastmatch'):] or '1')
            handle_lastmatch_command(room, profile_id, api_base, state, last_cooldown, dry_run, position)
            return
        if triggered != '#match':
            handle_player_command(room, profile_id, int(triggered[2:]),
                                  api_base, state, player_cooldown, dry_run)
            return
        match_id, replies = latest_reply(profile_id, api_base)
        if not replies:
            print(json.dumps({'stage': 'no_live_match', 'room': room}), flush=True)
            return
        publish_reply(room, match_id, replies, state, match_cooldown, dry_run)

    with CommandWorker(process_command, cooldown=cooldown) as worker:
        end = time.monotonic() + duration if duration else float('inf')
        while time.monotonic() < end:
            ws = None
            try:
                ws = websocket.create_connection('wss://danmuproxy.douyu.com:8506/',
                    origin='https://www.douyu.com', timeout=5)
                ws.send_binary(pack(dict(type='loginreq', roomid=room)))
                ws.send_binary(pack(dict(type='joingroup', rid=room, gid=-9999)))
                pending = b''
                heartbeat = 0
                ready = False
                while time.monotonic() < end:
                    if time.monotonic() >= heartbeat:
                        ws.send_binary(pack(dict(type='mrkl')))
                        heartbeat = time.monotonic() + 30
                    try:
                        incoming = ws.recv()
                    except websocket.WebSocketTimeoutException:
                        continue
                    if not incoming:
                        raise ConnectionError('Chat connection closed')
                    pending += incoming.encode() if isinstance(incoming, str) else incoming
                    messages, pending = unpack(pending)
                    for fields in messages:
                        if fields.get('type') == 'loginres' and not ready:
                            ready = True
                            print(json.dumps({'stage': 'listening', 'room': room,
                                'commands': ['#match', '#lastmatch[1–10]', '#p1–#p8'], 'profileId': profile_id, 'dryRun': dry_run}, ensure_ascii=False), flush=True)
                        if fields.get('type') == 'error':
                            raise RuntimeError('Chat server returned an error')
                        triggered = commands.reply(fields) if ready else None
                        if triggered:
                            worker.submit(triggered)
            except Exception as error:
                print(json.dumps({'stage': 'reconnecting', 'error': type(error).__name__}), flush=True)
                time.sleep(min(5, max(0, end - time.monotonic())))
            finally:
                if ws:
                    ws.close()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--room', type=int, required=True)
    parser.add_argument('--state', type=Path, default=Path(__file__).resolve().parents[1] / '.cache/danmaku/douyu_storage_state.json')
    parser.add_argument('--cooldown', type=float, default=0)
    parser.add_argument('--duration', type=float, default=0)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--profile-id', default='4153011')
    parser.add_argument('--api-base', default='http://127.0.0.1:3000')
    args = parser.parse_args()
    if args.cooldown < 0 or args.duration < 0:
        parser.error('cooldown must be >= 0 seconds; duration must be >= 0')
    if not args.profile_id.isdigit():
        parser.error('profile-id must be numeric')
    listen(args.room, args.state, args.cooldown, args.duration, args.dry_run,
           args.profile_id, args.api_base)
