#!/usr/bin/env python3
"""Deterministic ICU4C data filter generator for Android small-icu Node builds.

Inspects SillyBunny's `public/locales/lang.json` and `public/locales/*.json` files and emits an ICU4C
`icutools.databuilder` filter JSON (`ICU_DATA_FILTER_FILE`) covering:
  - `root` and default English (`en`, `en_US`)
  - every shipped SillyBunny UI locale (normalized to ICU locale IDs with base language + region)
  - CJK (`ja`, `ko`, `zh*`, `zh_Hans*`, `zh_Hant*`) and Turkish (`tr`, `tr_TR`) collation,
    break-iterator (`Intl.Segmenter`), calendar (`locales_tree`), currency (`curr_tree`),
    and timezone (`zone_tree`) rules.

Standard library only; deterministic sorted JSON output.
"""
import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent
DEFAULT_LOCALES_DIR = ROOT.parent.parent / 'public' / 'locales'

LOCALE_TAG_RE = re.compile(r'^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*\Z')

# Mandatory locales guaranteed even if `public/locales` is trimmed in fixtures:
# root, English defaults, CJK (`ja`, `ko`, `zh*` including Hans/Hant scripts), and Turkish (`tr`).
MANDATORY_ICU_LOCALES = (
    'root',
    'en',
    'en_US',
    'ja',
    'ja_JP',
    'ko',
    'ko_KR',
    'tr',
    'tr_TR',
    'zh',
    'zh_CN',
    'zh_HK',
    'zh_Hans',
    'zh_Hans_CN',
    'zh_Hans_SG',
    'zh_Hant',
    'zh_Hant_HK',
    'zh_Hant_TW',
    'zh_SG',
    'zh_TW',
)

# Chinese region-to-script expansions so both ICU script and region lookups resolve.
CHINESE_SCRIPT_ALIASES = {
    'zh_CN': ('zh', 'zh_CN', 'zh_Hans', 'zh_Hans_CN'),
    'zh_SG': ('zh', 'zh_SG', 'zh_Hans', 'zh_Hans_SG'),
    'zh_TW': ('zh', 'zh_TW', 'zh_Hant', 'zh_Hant_TW'),
    'zh_HK': ('zh', 'zh_HK', 'zh_Hant', 'zh_Hant_HK'),
    'zh_MO': ('zh', 'zh_MO', 'zh_Hant', 'zh_Hant_MO'),
}

# Portuguese in SillyBunny (`pt-pt` labeled Portuguese/Brazil) covers both PT and BR conventions.
EXTRA_LOCALE_ALIASES = {
    'pt_PT': ('pt', 'pt_PT', 'pt_BR'),
}

LOCALE_TREE_FEATURES = (
    'brkitr_tree',
    'coll_tree',
    'curr_tree',
    'lang_tree',
    'locales_tree',
    'region_tree',
    'unit_tree',
    'zone_tree',
)

REQUIRED_INCLUDE_FEATURES = (
    'brkitr_dictionaries',
    'brkitr_lstm',
    'brkitr_rules',
)

EXCLUDED_LEGACY_FEATURES = (
    'conversion_mappings',
    'translit',
    'unames',
)


class IcuFilterError(ValueError):
    def __init__(self, code, **details):
        super().__init__(code)
        self.code = code
        self.details = details


def fail(code, **details):
    raise IcuFilterError(code, **details)


def json_bytes(value):
    return (json.dumps(value, indent=4, sort_keys=True, ensure_ascii=True) + '\n').encode('utf-8')


def normalize_icu_locale(tag):
    """Normalizes a BCP-47 or ICU locale tag (e.g. 'zh-cn', 'zh-Hans-CN', 'en') to canonical ICU form."""
    if not isinstance(tag, str) or not tag:
        fail('invalid-locale-tag', tag=tag)
    if tag == 'root':
        return 'root'
    if not LOCALE_TAG_RE.fullmatch(tag):
        fail('invalid-locale-tag', tag=tag)
    parts = re.split(r'[-_]', tag)
    normalized = [parts[0].lower()]
    for index, subtag in enumerate(parts[1:], start=1):
        if len(subtag) == 4 and subtag.isalpha():
            normalized.append(subtag[0].upper() + subtag[1:].lower())
        elif (len(subtag) == 2 and subtag.isalpha()) or (len(subtag) == 3 and subtag.isdigit()):
            normalized.append(subtag.upper())
        elif index == 1 and len(subtag) == 2:
            normalized.append(subtag.upper())
        else:
            normalized.append(subtag.lower())
    return '_'.join(normalized)


def expand_locale_variants(tag):
    """Returns canonical ICU locale IDs for one tag, including base language and script/region aliases."""
    canonical = normalize_icu_locale(tag)
    if canonical == 'root':
        return ['root']
    parts = canonical.split('_')
    expanded = {parts[0], canonical}
    if len(parts) >= 3:
        expanded.add('_'.join(parts[:2]))
    expanded.update(CHINESE_SCRIPT_ALIASES.get(canonical, ()))
    expanded.update(EXTRA_LOCALE_ALIASES.get(canonical, ()))
    return sorted(expanded)


def discover_sillybunny_locales(locales_dir=DEFAULT_LOCALES_DIR):
    """Inspects `public/locales/lang.json` and `public/locales/*.json` and returns `(raw_tags, icu_locales)`."""
    locales_dir = Path(locales_dir)
    if locales_dir.is_symlink() or not locales_dir.is_dir():
        fail('locales-dir-missing', path=str(locales_dir))
    lang_json_path = locales_dir / 'lang.json'
    if lang_json_path.is_symlink() or not lang_json_path.is_file():
        fail('lang-json-missing', path=str(lang_json_path))
    try:
        lang_entries = json.loads(lang_json_path.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail('lang-json-invalid', path=str(lang_json_path))
    if not isinstance(lang_entries, list) or not lang_entries:
        fail('lang-json-empty', path=str(lang_json_path))

    file_tags = set()
    for entry in sorted(locales_dir.iterdir(), key=lambda item: item.name):
        if entry.name == 'lang.json' or not entry.name.endswith('.json'):
            continue
        if entry.is_symlink() or not entry.is_file():
            fail('locale-entry-invalid', path=str(entry))
        stem = entry.name[:-5]
        normalize_icu_locale(stem)
        file_tags.add(stem.lower())

    if not file_tags:
        fail('locales-empty', path=str(locales_dir))

    declared_tags = set()
    for item in lang_entries:
        if not isinstance(item, dict) or not isinstance(item.get('lang'), str) or not item['lang'].strip():
            fail('lang-entry-invalid', entry=item)
        tag = item['lang'].strip().lower()
        normalize_icu_locale(tag)
        if tag not in file_tags:
            fail('missing-locale-file', lang=tag, expected=str(locales_dir / f'{tag}.json'))
        declared_tags.add(tag)

    raw_tags = sorted(file_tags | declared_tags)
    icu_locales = set(MANDATORY_ICU_LOCALES)
    for tag in raw_tags:
        icu_locales.update(expand_locale_variants(tag))

    ordered_locales = ['root', *sorted(locale for locale in icu_locales if locale != 'root')]
    return raw_tags, ordered_locales


def _locale_tree_filter(includelist):
    return {
        'filterType': 'locale',
        'includeChildren': True,
        'includeScripts': True,
        'includelist': list(includelist),
    }


def build_icu_filter(locales_dir=DEFAULT_LOCALES_DIR):
    """Builds a deterministic ICU4C `icutools.databuilder` filter dictionary for SillyBunny."""
    _, includelist = discover_sillybunny_locales(locales_dir)
    feature_filters = {name: 'include' for name in REQUIRED_INCLUDE_FEATURES}
    for name in EXCLUDED_LEGACY_FEATURES:
        feature_filters[name] = 'exclude'
    for tree in LOCALE_TREE_FEATURES:
        feature_filters[tree] = _locale_tree_filter(includelist)
    return {
        'strategy': 'subtractive',
        'localeFilter': _locale_tree_filter(includelist),
        'featureFilters': feature_filters,
    }


def validate_icu_filter(filter_doc, locales_dir=None):
    """Validates an ICU4C filter dict for SillyBunny locale, CJK, Turkish, segmenter, and calendar/tz/currency rules."""
    if not isinstance(filter_doc, dict):
        fail('filter-not-object')
    if filter_doc.get('strategy') not in ('subtractive', 'additive'):
        fail('filter-strategy', strategy=filter_doc.get('strategy'))

    locale_filter = filter_doc.get('localeFilter')
    if not isinstance(locale_filter, dict) or locale_filter.get('filterType') != 'locale':
        fail('filter-locale-section')
    if locale_filter.get('includeChildren') is not True or locale_filter.get('includeScripts') is not True:
        fail('filter-locale-flags')

    includelist = locale_filter.get('includelist')
    if not isinstance(includelist, list) or not includelist or any(not isinstance(item, str) for item in includelist):
        fail('filter-includelist-invalid')
    if len(set(includelist)) != len(includelist):
        fail('filter-includelist-duplicates')

    included = set(includelist)
    missing_mandatory = sorted(set(MANDATORY_ICU_LOCALES) - included)
    if missing_mandatory:
        fail('filter-missing-mandatory-locales', missing=missing_mandatory)

    if locales_dir is not None:
        _, required_locales = discover_sillybunny_locales(locales_dir)
        missing_discovered = sorted(set(required_locales) - included)
        if missing_discovered:
            fail('filter-missing-sillybunny-locales', missing=missing_discovered)

    features = filter_doc.get('featureFilters')
    if not isinstance(features, dict):
        fail('filter-features-missing')

    for feature in REQUIRED_INCLUDE_FEATURES:
        if features.get(feature) != 'include':
            fail('filter-missing-break-iterator-feature', feature=feature, actual=features.get(feature))

    for tree in LOCALE_TREE_FEATURES:
        tree_cfg = features.get(tree)
        if not isinstance(tree_cfg, dict) or tree_cfg.get('filterType') != 'locale':
            fail('filter-tree-invalid', tree=tree)
        tree_locales = tree_cfg.get('includelist')
        if not isinstance(tree_locales, list) or not (set(MANDATORY_ICU_LOCALES) <= set(tree_locales)):
            fail('filter-tree-missing-locales', tree=tree)
        if locales_dir is not None and not (included <= set(tree_locales)):
            fail('filter-tree-mismatch', tree=tree)

    return {
        'localeCount': len(includelist),
        'hasRoot': 'root' in included,
        'hasCjk': all(code in included for code in ('ja', 'ko', 'zh', 'zh_CN', 'zh_TW', 'zh_Hans', 'zh_Hant')),
        'hasTurkish': all(code in included for code in ('tr', 'tr_TR')),
        'trees': sorted(LOCALE_TREE_FEATURES),
    }


def write_filter_atomic(output_path, filter_doc):
    output_path = Path(output_path)
    if output_path.is_symlink() or (output_path.exists() and not output_path.is_file()):
        fail('unsafe-output', path=str(output_path))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json_bytes(filter_doc)
    fd, temp_name = tempfile.mkstemp(prefix=f'.{output_path.name}.', dir=output_path.parent)
    temp_path = Path(temp_name)
    try:
        with open(fd, 'wb') as stream:
            stream.write(payload)
        temp_path.chmod(0o644)
        temp_path.replace(output_path)
    finally:
        if temp_path.exists():
            temp_path.unlink()
    return payload


def main(arguments=None):
    parser = argparse.ArgumentParser(
        description='Generate or validate the deterministic ICU4C filter JSON for SillyBunny Android small-icu builds.',
    )
    parser.add_argument(
        '--locales-dir',
        type=Path,
        default=DEFAULT_LOCALES_DIR,
        help='Directory holding SillyBunny public/locales/*.json and lang.json.',
    )
    parser.add_argument(
        '--output',
        type=Path,
        help='Write deterministic ICU filter JSON to this file (prints JSON to stdout when omitted).',
    )
    parser.add_argument(
        '--verify',
        type=Path,
        help='Validate an existing ICU filter JSON file against --locales-dir and print summary JSON.',
    )
    args = parser.parse_args(arguments)

    if args.verify is not None:
        verify_path = Path(args.verify)
        if verify_path.is_symlink() or not verify_path.is_file():
            fail('filter-file-missing', path=str(verify_path))
        try:
            doc = json.loads(verify_path.read_text(encoding='utf-8'))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            fail('filter-file-invalid-json', path=str(verify_path))
        summary = validate_icu_filter(doc, args.locales_dir)
        print(json.dumps({'verified': str(verify_path), **summary}, sort_keys=True))
        return

    filter_doc = build_icu_filter(args.locales_dir)
    validate_icu_filter(filter_doc, args.locales_dir)
    if args.output is not None:
        write_filter_atomic(args.output, filter_doc)
        summary = validate_icu_filter(filter_doc, args.locales_dir)
        print(json.dumps({'output': str(args.output), **summary}, sort_keys=True))
    else:
        sys.stdout.write(json_bytes(filter_doc).decode('utf-8'))


if __name__ == '__main__':
    try:
        main()
    except IcuFilterError as error:
        print('build-icu-filter.py failed:', file=sys.stderr)
        print(json.dumps({'code': error.code, **error.details}, sort_keys=True, default=str), file=sys.stderr)
        sys.exit(1)
