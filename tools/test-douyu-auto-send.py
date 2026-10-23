"""Validate automatic formatting and process serialization without sending chat."""
import os
from pathlib import Path
import select
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import douyu_auto_send as auto
import douyu_direct_danmaku as direct


class AutoSendTests(unittest.TestCase):
    def test_solo_hook_uses_the_command_template(self):
        raw = dict(id=1, map='Arabia', server='koreacentral', leaderboard='RM 1v1',
                   players=[dict(profileId='197964', name='Yo', rating=2800, civilization='Mongols', color=1),
                            dict(profileId='42', name='Other', rating=2700, civilization='Aztecs', color=2)])
        self.assertEqual(auto.opening_messages(raw, '197964', 'unused'),
                         ['Yo(2800,蒙古) vs Other(2700,阿兹特克)', '阿拉伯半岛, 1v1, 韩国中部'])

    def test_team_hook_keeps_membership_colors_and_missing_solo_scores(self):
        raw = dict(id=1, map='Arabia', server='eastasia', leaderboard='RM TG',
                   players=[dict(profileId='1', team=1, color=4), dict(profileId='2', team=2, color=1),
                            dict(profileId='197964', team=1, color=2), dict(profileId='4', team=2, color=5)],
                   teams=[dict(members=[0, 2]), dict(members=[1, 3])])
        with patch.object(auto, 'solo_ratings', return_value={'1': 2000, '2': 1500, '197964': 2800, '4': None}):
            self.assertEqual(auto.opening_messages(raw, '197964', 'unused'),
                             ['主播(2800/2000) vs 对手(1500/-)', '阿拉伯半岛, 组排, 东亚'])

    @unittest.skipUnless(os.name == 'posix', 'production process lock uses flock')
    def test_commands_and_automatic_sends_cannot_overlap_across_processes(self):
        with TemporaryDirectory() as directory:
            state = Path(directory) / 'state.json'
            child = None
            code = ('import importlib.util,sys;from pathlib import Path;'
                    's=importlib.util.spec_from_file_location("direct",sys.argv[1]);'
                    'm=importlib.util.module_from_spec(s);s.loader.exec_module(m);'
                    'print("ready",flush=True);'
                    '\nwith m.sending_lock(Path(sys.argv[2])): print("acquired",flush=True)')
            try:
                with direct.sending_lock(state):
                    child = subprocess.Popen([sys.executable, '-u', '-c', code, direct.__file__, str(state)],
                                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    self.assertEqual(child.stdout.readline().strip(), 'ready')
                    self.assertEqual(select.select([child.stdout], [], [], 0.1)[0], [])
                stdout, stderr = child.communicate(timeout=5)
                self.assertEqual(child.returncode, 0, stderr)
                self.assertEqual(stdout.strip(), 'acquired')
            finally:
                if child is not None and child.poll() is None:
                    child.kill(); child.communicate()


if __name__ == '__main__':
    unittest.main()
