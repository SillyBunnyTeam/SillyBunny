#!/usr/bin/env python3
import contextlib
import copy
import importlib.util
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
REAL_LOCALES_DIR = ROOT.parent.parent / 'public' / 'locales'

_SPEC = importlib.util.spec_from_file_location('runtime_build_icu_filter', ROOT / 'build-icu-filter.py')
icu_filter = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(icu_filter)


class IcuFilterTests(unittest.TestCase):
    def setUp(self):
        cache = ROOT / 'cache'
        cache.mkdir(exist_ok=True)
        scratch = tempfile.TemporaryDirectory(prefix='icu-filter-tests-', dir=cache)
        self.addCleanup(scratch.cleanup)
        self.directory = Path(scratch.name)

    def assert_code(self, code, callback, *arguments, **kwargs):
        with self.assertRaises(icu_filter.IcuFilterError) as caught:
            callback(*arguments, **kwargs)
        self.assertEqual(caught.exception.code, code, caught.exception.details)
        return caught.exception

    def test_normalizes_and_expands_bcp47_and_icu_locale_tags(self):
        self.assertEqual(icu_filter.normalize_icu_locale('root'), 'root')
        self.assertEqual(icu_filter.normalize_icu_locale('zh-cn'), 'zh_CN')
        self.assertEqual(icu_filter.normalize_icu_locale('zh-Hans-CN'), 'zh_Hans_CN')
        self.assertEqual(icu_filter.normalize_icu_locale('ja-JP'), 'ja_JP')
        self.assertEqual(icu_filter.normalize_icu_locale('tr-tr'), 'tr_TR')
        self.assertEqual(icu_filter.expand_locale_variants('zh-cn'), ['zh', 'zh_CN', 'zh_Hans', 'zh_Hans_CN'])
        self.assertEqual(icu_filter.expand_locale_variants('zh-tw'), ['zh', 'zh_Hant', 'zh_Hant_TW', 'zh_TW'])
        self.assertEqual(icu_filter.expand_locale_variants('pt-pt'), ['pt', 'pt_BR', 'pt_PT'])

    def test_rejects_malformed_locale_tags(self):
        for bad in ('', '../etc', 'en/us', '123-us', 'en--us', None):
            with self.subTest(bad=bad):
                self.assert_code('invalid-locale-tag', icu_filter.normalize_icu_locale, bad)

    def test_discovers_all_shipped_sillybunny_locales_and_emits_deterministic_filter(self):
        raw_tags, icu_locales = icu_filter.discover_sillybunny_locales(REAL_LOCALES_DIR)
        lang_entries = json.loads((REAL_LOCALES_DIR / 'lang.json').read_text(encoding='utf-8'))
        for item in lang_entries:
            tag = item['lang'].lower()
            self.assertIn(tag, raw_tags)
            for expanded in icu_filter.expand_locale_variants(tag):
                self.assertIn(expanded, icu_locales)

        for file_path in REAL_LOCALES_DIR.glob('*.json'):
            if file_path.name == 'lang.json':
                continue
            stem = file_path.stem.lower()
            self.assertIn(stem, raw_tags)
            for expanded in icu_filter.expand_locale_variants(stem):
                self.assertIn(expanded, icu_locales)

        self.assertEqual(icu_locales[0], 'root')
        first_doc = icu_filter.build_icu_filter(REAL_LOCALES_DIR)
        second_doc = icu_filter.build_icu_filter(REAL_LOCALES_DIR)
        self.assertEqual(icu_filter.json_bytes(first_doc), icu_filter.json_bytes(second_doc))

        summary = icu_filter.validate_icu_filter(first_doc, REAL_LOCALES_DIR)
        self.assertTrue(summary['hasRoot'])
        self.assertTrue(summary['hasCjk'])
        self.assertTrue(summary['hasTurkish'])
        self.assertGreaterEqual(summary['localeCount'], 35)

    def test_covers_cjk_turkish_segmenter_collation_calendar_currency_and_timezone_trees(self):
        doc = icu_filter.build_icu_filter(REAL_LOCALES_DIR)
        included = set(doc['localeFilter']['includelist'])
        for required in ('root', 'en', 'en_US', 'ja', 'ja_JP', 'ko', 'ko_KR',
                         'zh', 'zh_CN', 'zh_TW', 'zh_HK', 'zh_Hans', 'zh_Hant', 'tr', 'tr_TR'):
            self.assertIn(required, included)

        features = doc['featureFilters']
        for seg_feature in ('brkitr_dictionaries', 'brkitr_lstm', 'brkitr_rules'):
            self.assertEqual(features[seg_feature], 'include')
        for excluded in ('conversion_mappings', 'translit', 'unames'):
            self.assertEqual(features[excluded], 'exclude')
        for tree in ('coll_tree', 'brkitr_tree', 'locales_tree', 'curr_tree', 'zone_tree', 'lang_tree', 'region_tree', 'unit_tree'):
            self.assertEqual(features[tree]['filterType'], 'locale')
            self.assertTrue(features[tree]['includeChildren'])
            self.assertTrue(features[tree]['includeScripts'])
            self.assertEqual(features[tree]['includelist'], doc['localeFilter']['includelist'])

    def test_cli_output_and_verify_roundtrip(self):
        out_file = self.directory / 'icu-filter.json'
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            icu_filter.main(['--locales-dir', str(REAL_LOCALES_DIR), '--output', str(out_file)])
        written_summary = json.loads(stdout.getvalue())
        self.assertEqual(written_summary['output'], str(out_file))
        self.assertTrue(out_file.is_file())

        verify_stdout = io.StringIO()
        with contextlib.redirect_stdout(verify_stdout):
            icu_filter.main(['--locales-dir', str(REAL_LOCALES_DIR), '--verify', str(out_file)])
        verified_summary = json.loads(verify_stdout.getvalue())
        self.assertEqual(verified_summary['verified'], str(out_file))
        self.assertEqual(verified_summary['localeCount'], written_summary['localeCount'])

        stream_stdout = io.StringIO()
        with contextlib.redirect_stdout(stream_stdout):
            icu_filter.main(['--locales-dir', str(REAL_LOCALES_DIR)])
        self.assertEqual(stream_stdout.getvalue().encode('utf-8'), out_file.read_bytes())

    def test_validation_rejects_missing_locale_files_or_stripped_mandatory_coverage(self):
        fixture = self.directory / 'locales'
        shutil.copytree(REAL_LOCALES_DIR, fixture)
        (fixture / 'ja-jp.json').unlink()
        self.assert_code('missing-locale-file', icu_filter.discover_sillybunny_locales, fixture)

        doc = icu_filter.build_icu_filter(REAL_LOCALES_DIR)

        no_turkish = copy.deepcopy(doc)
        no_turkish['localeFilter']['includelist'] = [loc for loc in no_turkish['localeFilter']['includelist'] if not loc.startswith('tr')]
        self.assert_code('filter-missing-mandatory-locales', icu_filter.validate_icu_filter, no_turkish, REAL_LOCALES_DIR)

        no_segmenter = copy.deepcopy(doc)
        no_segmenter['featureFilters']['brkitr_dictionaries'] = 'exclude'
        self.assert_code('filter-missing-break-iterator-feature', icu_filter.validate_icu_filter, no_segmenter, REAL_LOCALES_DIR)

        broken_collation = copy.deepcopy(doc)
        broken_collation['featureFilters']['coll_tree']['includelist'] = ['root', 'en']
        self.assert_code('filter-tree-missing-locales', icu_filter.validate_icu_filter, broken_collation, REAL_LOCALES_DIR)


if __name__ == '__main__':
    unittest.main(verbosity=2)
