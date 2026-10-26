"""Empty successful feeds must not be mistaken for a successful video check."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('dynamic_check', Path(__file__).with_name('check-bilibili-updates-browser.py'))
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class DynamicResponseTests(unittest.TestCase):
    def test_empty_success_is_incomplete(self):
        for data in [{}, {'items': []}]:
            self.assertEqual(checker.response_status({'http': 200, 'payload': {'code': 0, 'data': data}}, ''), 'empty_response')

    def test_risk_and_transport_failures_are_preserved(self):
        self.assertEqual(checker.response_status({'http': 200, 'payload': {'code': -352}}, ''), 'verification_required')
        self.assertEqual(checker.response_status({'http': 200, 'payload': {'code': 0}}, '请完成验证'), 'verification_required')
        self.assertEqual(checker.response_status({}, ''), 'response_error')

    def test_real_feed_with_no_eligible_videos_is_valid(self):
        item = {'type': 'DYNAMIC_TYPE_WORD'}
        self.assertEqual(checker.response_status({'http': 200, 'payload': {'code': 0, 'data': {'items': [item]}}}, ''), 'ok')
        self.assertEqual(checker.extract_own_videos([item], '34201013'), [])

    def test_video_extraction_keeps_original_publish_date(self):
        item = {'type': 'DYNAMIC_TYPE_AV', 'modules': {
            'module_author': {'mid': 34201013, 'pub_ts': 1792954121},
            'module_dynamic': {'major': {'archive': {'bvid': 'BV19KnQ6QEEX', 'title': '帝国时代猜火车Yo'}}}}}
        videos = checker.extract_own_videos([item], '34201013')
        self.assertEqual(videos[0]['publishedAt'], '2026-10-25T18:48:41Z')
        self.assertEqual(checker.extract_own_videos([item], '999'), [])


if __name__ == '__main__':
    unittest.main()
