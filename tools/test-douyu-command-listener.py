"""Concurrency regressions; all sockets, API calls and sends are mocked."""
import contextlib
import importlib.util
import io
import json
import os
import sys
from pathlib import Path
from threading import Event
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import Mock, patch

source = Path(os.environ.get('LISTENER_UNDER_TEST', Path(__file__).with_name('douyu_command_listener.py')))
sys.path.insert(0, str(source.parent))
spec = importlib.util.spec_from_file_location('listener_under_test', source)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def chat(cid, text, uid='viewer'):
    return dict(type='chatmsg', cid=cid, txt=text, uid=uid)


def wait_idle(worker):
    deadline = time.monotonic() + 2
    while worker.queue.unfinished_tasks and time.monotonic() < deadline:
        time.sleep(0.002)
    assert worker.queue.unfinished_tasks == 0


class WorkerTests(unittest.TestCase):
    def test_sender_accepts_sixty_characters_and_rejects_sixty_one(self):
        self.assertEqual(m.MAX_MESSAGE_LENGTH, 60)
        with TemporaryDirectory() as directory, patch.object(Path, 'read_text', side_effect=RuntimeError('validation passed')) as read:
            state = Path(directory) / 'state.json'
            with self.assertRaisesRegex(RuntimeError, 'validation passed'):
                m.send_many(1, ['x' * 60], state)
            read.reset_mock()
            with self.assertRaises(ValueError):
                m.send_many(1, ['x' * 61], state)
            read.assert_not_called()

    def test_zero_duration_cooldown_is_disabled(self):
        guard = m.MatchCooldown()
        guard.mark_sent('match', 100)
        self.assertFalse(guard.blocked('match', 100))
        self.assertFalse(guard.blocked('match', 101))
        self.assertEqual(guard.sent_at, {})
        self.assertEqual(m.CommandWorker(lambda _: None).cooldown, 0)

    def setUp(self):
        self.wall_clock = patch.object(m.time, 'time', return_value=500)
        self.wall_clock.start()
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()

    def tearDown(self):
        self.wall_clock.stop()
        self.output.__exit__(None, None, None)

    def test_receive_continues_during_blocked_query(self):
        started, received, release, completed = (Event() for _ in range(4))
        handled = []

        def latest(*args):
            started.set()
            if not release.wait(1):
                raise AssertionError('Receiver stalled during query')
            return 'match', ['one', 'two']

        def publish(*args):
            handled.append('#match')

        def player(*args):
            handled.append(f'#p{args[2]}')
            if args[2] == 2:
                completed.set()

        class Socket:
            step = 0

            def send_binary(self, frame):
                pass

            def close(self):
                pass

            def recv(self):
                self.step += 1
                if self.step == 1:
                    return m.pack(dict(type='loginres')) + m.pack(chat('a', '#match'))
                if self.step == 2:
                    if not started.wait(1):
                        raise AssertionError('Worker did not start')
                    return (m.pack(chat('b', '#p1')) + m.pack(chat('c', '#p2')) +
                            m.pack(chat('d', '#match')) + m.pack(chat('self', '#p3', 'self')))
                received.set()
                release.set()
                time.sleep(0.002)
                raise m.websocket.WebSocketTimeoutException()

        state = Mock()
        state.read_text.return_value = json.dumps(dict(cookies=[dict(name='acf_uid', value='self')]))
        with patch.object(m.websocket, 'create_connection', return_value=Socket()), \
             patch.object(m, 'latest_reply', side_effect=latest), \
             patch.object(m, 'publish_reply', side_effect=publish), \
             patch.object(m, 'handle_player_command', side_effect=player), \
             patch.object(m, 'send_many') as send:
            m.listen(1, state, cooldown=0, duration=0.25, dry_run=True)
            send.assert_not_called()
        self.assertTrue(received.is_set())
        self.assertTrue(completed.is_set())
        self.assertEqual(handled, ['#match', '#p1', '#p2'])

    def test_pending_commands_merge_and_process_in_order(self):
        started, release = Event(), Event()
        handled = []

        def process(command):
            if command == '#match':
                started.set()
                release.wait(1)
            handled.append(command)

        with m.CommandWorker(process, cooldown=0) as worker:
            self.assertTrue(worker.submit('#match'))
            self.assertTrue(started.wait(1))
            self.assertFalse(worker.submit('#match'))
            self.assertTrue(worker.submit('#p1'))
            self.assertTrue(worker.submit('#p2'))
            release.set()
            wait_idle(worker)
        self.assertEqual(handled, ['#match', '#p1', '#p2'])

    def test_worker_failure_does_not_stop_later_commands(self):
        handled = []

        def process(command):
            handled.append(command)
            if command == '#match':
                raise RuntimeError('Simulated API/send failure')

        with m.CommandWorker(process, cooldown=0) as worker:
            worker.submit('#match')
            worker.submit('#p1')
            wait_idle(worker)
            self.assertTrue(worker.thread.is_alive())
        self.assertEqual(handled, ['#match', '#p1'])

    def test_three_second_setting_is_worker_throttle(self):
        times = []
        with m.CommandWorker(lambda _: times.append(time.monotonic()), cooldown=0.05) as worker:
            worker.submit('#p1')
            worker.submit('#p2')
            wait_idle(worker)
        self.assertEqual(len(times), 2)
        self.assertGreaterEqual(times[1] - times[0], 0.045)

    def test_expired_commands_and_queue_capacity(self):
        started, release = Event(), Event()
        handled = []

        def process(command):
            handled.append(command)
            started.set()
            release.wait(1)

        with m.CommandWorker(process, cooldown=0, capacity=1, max_age=0.02) as worker:
            worker.submit('#match')
            self.assertTrue(started.wait(1))
            self.assertTrue(worker.submit('#p1'))
            self.assertFalse(worker.submit('#p2'))
            time.sleep(0.04)
            release.set()
            wait_idle(worker)
        self.assertEqual(handled, ['#match'])

    def test_exact_commands_dedup_self_filter_and_bursts(self):
        commands = m.Commands('self')
        self.assertEqual(commands.reply(chat('1', ' #p1 ')), '#p1')
        self.assertEqual(commands.reply(chat('2', '#p2')), '#p2')
        self.assertEqual(commands.reply(chat('last', ' #lastmatch ')), '#lastmatch')
        self.assertIsNone(commands.reply(chat('1', '#p1')))
        self.assertIsNone(commands.reply(chat('3', '#p3', 'self')))
        for text in ('#p0', '#p9', '#p01', '#p1 extra', '#P1', '#pnum', '!match', '#lastmatch extra', '#Lastmatch'):
            self.assertIsNone(commands.reply(chat(text, text)))

    def test_five_minute_cooldowns_start_only_on_success(self):
        guard = m.MatchCooldown(seconds=300)
        with patch.object(m, 'player_reply', return_value=('42', 'player message')), \
             patch.object(m, 'send_many', side_effect=RuntimeError('reject')):
            with self.assertRaises(RuntimeError):
                m.handle_player_command(1, '1', 1, 'unused', None, guard)
        self.assertFalse(guard.blocked('1', time.monotonic()))
        with patch.object(m, 'player_reply', return_value=('42', 'player message')), \
             patch.object(m, 'send_many'), patch.object(m.time, 'monotonic', return_value=100):
            self.assertTrue(m.handle_player_command(1, '1', 1, 'unused', None, guard))
        self.assertTrue(guard.blocked('1', 399.99))
        self.assertFalse(guard.blocked('2', 399.99))
        self.assertFalse(guard.blocked('1', 400))

    def test_player_numbers_have_independent_five_minute_cooldowns(self):
        guard = m.MatchCooldown(seconds=300)
        with patch.object(m, 'player_reply', return_value=('same-profile', 'player')) as query, \
             patch.object(m, 'send_many') as send:
            with patch.object(m.time, 'monotonic', return_value=100):
                self.assertTrue(m.handle_player_command(1, 'host', 1, 'unused', None, guard))
                self.assertFalse(m.handle_player_command(1, 'host', 1, 'unused', None, guard))
                self.assertTrue(m.handle_player_command(1, 'host', 2, 'unused', None, guard))
                self.assertEqual(query.call_count, 2)
            with patch.object(m.time, 'monotonic', return_value=399.99):
                self.assertFalse(m.handle_player_command(1, 'host', 1, 'unused', None, guard))
            with patch.object(m.time, 'monotonic', return_value=400):
                self.assertTrue(m.handle_player_command(1, 'host', 1, 'unused', None, guard))
            self.assertEqual(send.call_count, 3)

    def test_match_cooldown_requires_pair_success_and_allows_new_match(self):
        guard = m.MatchCooldown(seconds=300)
        with patch.object(m, 'send_many', side_effect=RuntimeError('rejected')):
            self.assertFalse(m.publish_reply(1, 'match', ['one', 'two'], None, guard))
        self.assertFalse(guard.blocked('match', time.monotonic()))
        with patch.object(m, 'send_many') as send:
            with patch.object(m.time, 'monotonic', return_value=100):
                self.assertTrue(m.publish_reply(1, 'match', ['one', 'two'], None, guard))
                self.assertFalse(m.publish_reply(1, 'match', ['one', 'two'], None, guard))
                self.assertTrue(m.publish_reply(1, 'new-match', ['one', 'two'], None, guard))
            self.assertEqual(send.call_count, 2)
        self.assertTrue(guard.blocked('match', 399.99))
        self.assertFalse(guard.blocked('match', 400))

    def test_player_format_has_favorite_and_no_rank_or_accounts(self):
        message = m.format_player(dict(name='Hoang', country='vn'), {},
                                  [dict(id=3, rating=2466, rank=112),
                                   dict(id=4, rating=1727, rank=996)], '波希米亚', 12)
        self.assertEqual(message, 'Hoang, 来自越南, 1v1 2466, 组排 1727, 近期最爱波希米亚12场')
        self.assertNotIn('#', message)
        self.assertNotIn('小号', message)
        self.assertLessEqual(len(m.format_player(dict(name='N' * 100), {}, [], '未知')), 60)

    def test_favorite_uses_profile_page_mode_and_finished_filter(self):
        def game(civ, mode='RM 1v1', **extra):
            return dict(dict(leaderboard=mode, finished=1, live=False,
                             players=[dict(id='1', civilization=civ)]), **extra)
        history = [game('Bohemians'), game('Bohemians'), game('Aztecs'),
                   game('Aztecs', live=True), game('Aztecs', finished=0),
                   game('Aztecs', 'RM TG'), game('Aztecs', 'RM TG'),
                   game('Aztecs', 'RM TG'), game('Mongols', 'EW 1v1'),
                   game('Goths', '', finished=0, abandoned=True)]
        self.assertEqual(m.favorite_civilization(history, '1', game('unused')), ('波希米亚', 2))
        self.assertEqual(m.favorite_civilization(history, '1', game('unused', 'RM TG')), ('阿兹特克', 3))
        self.assertEqual(m.favorite_civilization(history, '1', game('unused', 'EW 1v1')), ('蒙古', 1))
        self.assertEqual(m.favorite_civilization(history, '1', game('unused', '')), ('哥特', 1))
        self.assertEqual(m.favorite_civilization(history, 'other', game('unused')), ('暂无', None))
        # Profile page uses Chinese locale order rather than most-recent order for ties.
        tied = [game('Mongols'), game('Aztecs')]
        self.assertEqual(m.favorite_civilization(tied, '1', game('unused')), ('阿兹特克', 1))

    def test_history_failure_preserves_ratings_and_reports_unknown(self):
        match = dict(id='match', live=True, finished=0,
                     players=[dict(id='1', name='Hoang', color=1, country='vn')])
        responses = [dict(matches=[match]), dict(player={}),
                     dict(leaderboards=[dict(id=3, rating=2466)]), RuntimeError('unavailable')]
        with patch.object(m, 'api_json', side_effect=responses):
            player_id, message = m.player_reply('1', 1, 'unused')
        self.assertEqual(player_id, '1')
        self.assertEqual(message, 'Hoang, 来自越南, 1v1 2466, 组排 暂无, 近期最爱未知')

    def team_game(self):
        # Player numbers, IDs, colors and list order deliberately differ.
        return dict(id='team', live=True, finished=0, leaderboard='RM TG',
                    rms='Arabia', server='centralindia',
                    players=[dict(id='1', number=3, color=5, team=2, rating=900),
                             dict(id='2', number=0, color=1, team=1, rating=900),
                             dict(id='3', number=2, color=2, team=2, rating=900),
                             dict(id='4', number=1, color=4, team=1, rating=900)],
                    teams=[dict(members=[0, 1]), dict(members=[2, 3])])

    def test_team_scores_follow_colors_and_streamer_side(self):
        game = self.team_game()
        lines = m.format_match(game, '1', {'1': 2000, '2': 1800, '3': 1601, '4': 2200})
        self.assertEqual(lines[0], '主播(1601/2000) vs 对手(1800/2200)')
        self.assertEqual(lines[1], '阿拉伯半岛, 组排, 印度中部')
        self.assertEqual(m.format_match(game, '2', {'1': 2000, '2': 1800, '3': 1600, '4': 2200})[0],
                         '主播(1800/2200) vs 对手(1600/2000)')

    def test_four_vs_four_fits_one_message_and_sorts_each_team_colors(self):
        players = [dict(id=str(color), number=color - 1, color=color, team=1 if color % 2 else 2)
                   for color in reversed(range(1, 9))]
        game = dict(players=players)
        ratings = {str(color): 2000 + color for color in range(1, 9)}
        title = m.team_match_title(game, '7', ratings)
        self.assertEqual(title, '主播(2001/2003/2005/2007) vs 对手(2002/2004/2006/2008)')
        self.assertEqual(len(title), 50)
        ratings['3'] = None
        self.assertIn('2001/-/2005/2007', m.team_match_title(game, '7', ratings))

    def test_missing_solo_rating_is_dash_and_inactive_rating_is_kept(self):
        game = self.team_game()
        self.assertEqual(m.format_match(game, '1', {'1': 2000, '2': 1800, '3': None, '4': None})[0],
                         '主播(-/2000) vs 对手(1800/-)')
        self.assertEqual(m.format_match(game, '1', dict.fromkeys(['1', '2', '3', '4'], None))[0], '主播(-/-) vs 对手(-/-)')
        def api(root, path):
            if 'id=1' in path:
                return dict(leaderboards=[dict(id=3, rating=2000), dict(id=4, rating=900)])
            if 'id=2' in path:
                return dict(leaderboards=[dict(id=3, hasData=False), dict(id=4, rating=1000)])
            if 'id=3' in path:
                return dict(leaderboards=[dict(id=3, hasData=True, rating=1300, rank=None, active=False, wins=2, losses=1)])
            return dict(leaderboards=[dict(id=3, hasData=True, rating=1000, wins=0, losses=0)])
        with patch.object(m, 'api_json', side_effect=api):
            self.assertEqual(m.solo_ratings(game['players'], 'unused'),
                             {'1': 2000, '2': None, '3': 1300, '4': None})

    def test_rating_lookup_error_is_not_counted_as_unplayed(self):
        for response in (dict(leaderboards=[]), dict(leaderboards=[dict(id=3, hasData=True, rating=None)])):
            with patch.object(m, 'api_json', return_value=response):
                with self.assertRaises(ValueError):
                    m.solo_ratings([dict(id='1')], 'unused')
        with patch.object(m, 'api_json', side_effect=RuntimeError('unavailable')):
            with self.assertRaises(RuntimeError):
                m.solo_ratings([dict(id='1')], 'unused')

    def test_latest_match_accepts_team_live_but_not_ended(self):
        game = self.team_game()
        with patch.object(m, 'api_json', return_value=dict(matches=[game])), \
             patch.object(m, 'solo_ratings', return_value={'1': 2000, '2': None, '3': None, '4': None}) as ratings:
            match_id, lines = m.latest_reply('1', 'unused')
            self.assertEqual(match_id, 'team')
            self.assertEqual(lines[0], '主播(-/2000) vs 对手(-/-)')
            ratings.assert_called_once()
        game['finished'] = 123
        with patch.object(m, 'api_json', return_value=dict(matches=[game])), \
             patch.object(m, 'solo_ratings') as ratings:
            self.assertEqual(m.latest_reply('1', 'unused'), (None, []))
            ratings.assert_not_called()

    def test_one_vs_one_format_unchanged_and_invalid_team_data_rejected(self):
        game = dict(players=[dict(id='1', name='Host', team=1, rating=2000, civilization='Mongols'),
                             dict(id='2', name='Rival', team=2, rating=1900, civilization='Aztecs')],
                    leaderboard='RM 1v1', rms='Arabia', server='centralindia')
        self.assertEqual(m.format_match(game, '1'),
                         ['Host(2000,蒙古) vs Rival(1900,阿兹特克)',
                          '阿拉伯半岛, 1v1, 印度中部'])
        game = self.team_game()
        game['teams'][0]['members'] = [0, 2]
        with self.assertRaises(ValueError):
            m.match_sides(game, '1')
        game = self.team_game()
        game.pop('teams')
        self.assertEqual(m.match_sides(game, '1'), (['1', '3'], ['2', '4']))

    def last_game(self):
        return dict(id='last', started=100, finished=200, live=False,
                    leaderboard='RM 1v1', rms='Arabia',
                    players=[dict(id='1', name='Host', number=0, winner=True, ratingDelta=12),
                             dict(id='2', name='Rival', number=1, winner=False, ratingDelta=-12)],
                    teams=[dict(members=[0], winner=True), dict(members=[1], winner=False)])

    def test_lastmatch_age_uses_finished_time(self):
        self.assertEqual(m.lastmatch_age(dict(finished=200, started=1), now=500), '5分钟前')
        self.assertEqual(m.lastmatch_age(dict(finished=500), now=500), '刚刚')
        self.assertEqual(m.lastmatch_age(dict(finished=440), now=500), '1分钟前')
        self.assertEqual(m.lastmatch_age(dict(finished=1400), now=5000), '1小时前')
        self.assertEqual(m.lastmatch_age(dict(finished=3600), now=90000), '1天前')
        self.assertEqual(m.lastmatch_age(dict(finished=0, started=100), now=500), '结束时间未知')

    def test_lastmatch_solo_and_lobby_fields(self):
        game = self.last_game()
        self.assertEqual(m.format_lastmatch(game, '1'),
                         '胜利, vs Rival, 阿拉伯半岛, 1v1, +12, 5分钟前')
        self.assertEqual(m.format_lastmatch(game, '2'),
                         '失败, vs Host, 阿拉伯半岛, 1v1, -12, 5分钟前')
        game['leaderboard'] = ''
        self.assertEqual(m.format_lastmatch(game, '1'), '胜利, vs Rival, 阿拉伯半岛, 大厅局, 5分钟前')
        for player in game['players']:
            player['name'] = 'VeryLongName' * 20
        self.assertLessEqual(len(m.format_lastmatch(game, '1')), 60)

    def test_lastmatch_team_and_unknown_results(self):
        game = self.team_game()
        game.update(finished=200, live=False)
        game['teams'][0]['winner'] = True
        game['players'][0]['ratingDelta'] = -8
        self.assertEqual(m.format_lastmatch(game, '1'), '失败, 阿拉伯半岛, 组排, -8, 5分钟前')
        game['teams'][0]['winner'] = False
        self.assertTrue(m.format_lastmatch(game, '1').startswith('结果未知,'))
        game['abandoned'] = True
        self.assertTrue(m.format_lastmatch(game, '1').startswith('已中止,'))

    def test_lastmatch_selects_latest_completed_and_skips_current(self):
        old, latest, current = self.last_game(), self.last_game(), self.last_game()
        old.update(id='old', started=50)
        latest.update(id='latest', started=150)
        current.update(id='current', started=300, live=True, finished=0)
        with patch.object(m, 'api_json', return_value=dict(matches=[old, current, latest])):
            self.assertEqual(m.lastmatch_reply('1', 'unused')[0], 'latest')
        with patch.object(m, 'api_json', return_value=dict(matches=[current])):
            self.assertEqual(m.lastmatch_reply('1', 'unused'), (None, None))

    def test_lastmatch_cooldown_starts_only_after_success(self):
        guard = m.MatchCooldown(seconds=30)
        with patch.object(m, 'lastmatch_reply', return_value=('last', 'previous result')), \
             patch.object(m, 'send_many', side_effect=RuntimeError('reject')):
            with self.assertRaises(RuntimeError):
                m.handle_lastmatch_command(1, '1', 'unused', None, guard)
        self.assertFalse(guard.blocked('lastmatch', time.monotonic()))
        with patch.object(m, 'lastmatch_reply', return_value=('last', 'previous result')), \
             patch.object(m, 'send_many') as send:
            self.assertTrue(m.handle_lastmatch_command(1, '1', 'unused', None, guard, True))
            send.assert_not_called()
            self.assertFalse(guard.blocked('lastmatch', time.monotonic()))
            self.assertTrue(m.handle_lastmatch_command(1, '1', 'unused', None, guard))
            self.assertFalse(m.handle_lastmatch_command(1, '1', 'unused', None, guard))
            send.assert_called_once()

    def test_lastmatch_number_commands_and_alias(self):
        commands = m.Commands('self')
        for number in range(1, 11):
            text = f'#lastmatch{number}'
            expected = '#lastmatch' if number == 1 else text
            self.assertEqual(commands.reply(chat(str(number), text)), expected)
        for text in ('#lastmatch0', '#lastmatch11', '#lastmatch01', '#lastmatch 2',
                     '#lastmatch-1', '#lastmatch2 extra', '#lastmatch1.5'):
            self.assertIsNone(commands.reply(chat(text, text)))

    def test_lastmatch_tenth_counts_only_unique_completed_matches(self):
        games = []
        for number in range(1, 13):
            game = self.last_game()
            game.update(id=f'm{number}', started=1000 - number)
            games.append(game)
        current = self.last_game()
        current.update(id='live', started=2000, finished=0, live=True)
        with patch.object(m, 'api_json', return_value=dict(matches=[current, games[0]] + list(reversed(games)))):
            self.assertEqual(m.lastmatch_reply('1', 'unused', 10)[0], 'm10')
            self.assertEqual(m.lastmatch_reply('1', 'unused', 2)[0], 'm2')
        with patch.object(m, 'api_json', return_value=dict(matches=games[:9])):
            self.assertEqual(m.lastmatch_reply('1', 'unused', 10), (None, None))
        for number in (0, 11):
            with self.assertRaises(ValueError):
                m.lastmatch_reply('1', 'unused', number)

    def test_lastmatch_variants_share_thirty_second_success_cooldown(self):
        guard = m.MatchCooldown(seconds=30)
        with patch.object(m, 'lastmatch_reply', return_value=('last', 'result')) as query, \
             patch.object(m, 'send_many') as send:
            with patch.object(m.time, 'monotonic', return_value=100):
                self.assertTrue(m.handle_lastmatch_command(1, '1', 'unused', None, guard, position=1))
            with patch.object(m.time, 'monotonic', return_value=129.99):
                self.assertFalse(m.handle_lastmatch_command(1, '1', 'unused', None, guard, position=10))
                self.assertEqual(query.call_count, 1)
            with patch.object(m.time, 'monotonic', return_value=130):
                self.assertTrue(m.handle_lastmatch_command(1, '1', 'unused', None, guard, position=10))
            self.assertEqual(send.call_count, 2)


if __name__ == '__main__':
    unittest.main()
