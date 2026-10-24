import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

spec = importlib.util.spec_from_file_location('backup_site', Path(__file__).with_name('backup-site.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BackupTests(unittest.TestCase):
    def test_source_and_private_state_restore_and_generated_cache_is_excluded(self):
        with TemporaryDirectory() as temp:
            root = Path(temp) / 'site'
            for directory in ('config', '.cache/danmaku', '.cache/replay-analysis'):
                (root / directory).mkdir(parents=True, exist_ok=True)
            (root / 'server.js').write_text('source')
            (root / 'config/players_pool.txt').write_text('players')
            (root / '.cache/danmaku/state.json').write_text(json.dumps({'test': 'session'}))
            (root / '.cache/replay-analysis/generated.json').write_text('{}')
            result = module.backup(root, Path(temp) / 'archives')
            restored = Path(temp) / 'restored'
            self.assertTrue(result['verified'])
            self.assertEqual(module.verify(result['archive'], restored), 3)
            self.assertEqual((restored / 'server.js').read_text(), 'source')
            self.assertEqual(json.loads((restored / '.cache/danmaku/state.json').read_text()), {'test': 'session'})
            self.assertFalse((restored / '.cache/replay-analysis').exists())

    def test_invalid_runtime_state_never_publishes_a_backup(self):
        with TemporaryDirectory() as temp:
            root = Path(temp) / 'site'; (root / '.cache').mkdir(parents=True)
            (root / '.cache/state.json').write_text('invalid-json')
            with self.assertRaises(json.JSONDecodeError):
                module.backup(root, Path(temp) / 'archives')
            self.assertEqual(list((Path(temp) / 'archives').glob('*.tar.gz')), [])


if __name__ == '__main__':
    unittest.main()
