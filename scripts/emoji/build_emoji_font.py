"""
Builds the emoji font of the conversation mode from the Twemoji SVGs with Google's nanoemoji, as one COLRv0 woff2.

This file runs inside the throwaway venv that `build-emoji-font.js` makes from `requirements.txt` (hashes pinned), after
that script has checked the Twemoji files against `sources.json`. Run `node scripts/emoji/build-emoji-font.js`, not this file.

What it does that a plain nanoemoji build does not:

- Drops every `-fe0f` from the SVG file names. nanoemoji names a glyph and its ligature after the file, and Chromium and
  WebKit do not match a ligature that contains U+FE0F, so about 970 sequences would draw as two glyphs.
- Squares the one SVG that is not 36 by 36 (the watermelon), which is otherwise 1.67 em wide against 1.25 em for the rest.
- Removes U+0020 from the cmap. nanoemoji maps the space to a glyph 1.25 em wide, and a face that owns the space changes
  every line of text that it appears in.
- Fixes the dates in the head table, so that a second run writes the same bytes.
- Shapes every emoji of the emojibase data with HarfBuzz and writes the ones that make exactly one glyph. That list is what
  the emoji tables are cut to.
"""

import argparse
import calendar
import importlib.metadata
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.misc.timeTools import epoch_diff
from fontTools.ttLib import TTFont

FAMILY = "SB Emoji"
SQUARE = 36
FIXED_TIME = calendar.timegm((2026, 1, 1, 0, 0, 0)) - epoch_diff
# What a sequence needs inside the face although the font has no glyph of its own for it: the joiner, the emoji selector,
# the keycap mark and the tag characters of the subdivision flags. Chromium and Firefox split a sequence when one of its
# code points is outside the unicode-range of the face.
SEQUENCE_PARTS = {0x200D, 0xFE0F, 0x20E3, *range(0xE0020, 0xE0080)}
# The characters that ordinary text uses and that the face must leave to the text font.
TEXT_CHARACTERS = {0x20, 0x23, 0x2A, *range(0x30, 0x3A), 0xA9, 0xAE, 0x2122}
VIEWBOX = re.compile(r'viewBox="0 0 ([0-9.]+) ([0-9.]+)"')


def prepare_svgs(source: Path, target: Path):
    target.mkdir(parents=True)
    squared = []
    renamed = 0
    for file in sorted(source.glob("*.svg")):
        name = file.name.replace("-fe0f", "")
        if name != file.name:
            renamed += 1
        if (target / name).exists():
            raise SystemExit(f"Two SVG files are called {name} once -fe0f is dropped.")
        text = file.read_text(encoding="utf-8")
        box = VIEWBOX.search(text)
        if box is None:
            raise SystemExit(f"{file.name} has no viewBox.")
        width, height = float(box.group(1)), float(box.group(2))
        if (width, height) != (SQUARE, SQUARE):
            if width != SQUARE or height > SQUARE:
                raise SystemExit(f"{file.name} is {width} by {height}; only a drawing 36 wide and not taller can be centred.")
            shift = (SQUARE - height) / 2
            text = VIEWBOX.sub(f'viewBox="0 0 {SQUARE} {SQUARE}"', text, count=1)
            text = re.sub(r"(<svg[^>]*>)(.*)(</svg>)", rf'\1<g transform="translate(0 {shift:g})">\2</g>\3', text, count=1, flags=re.S)
            squared.append(file.name)
        (target / name).write_text(text, encoding="utf-8")
    return renamed, squared


def run_nanoemoji(svgs: Path, build: Path):
    environment = dict(os.environ)
    # nanoemoji runs `ninja` by name, and it is installed beside this interpreter.
    environment["PATH"] = os.path.dirname(sys.executable) + os.pathsep + environment.get("PATH", "")
    command = [
        shutil.which("nanoemoji", path=environment["PATH"]),
        "--color_format", "glyf_colr_0",
        "--family", FAMILY,
        "--output_file", "SBEmoji.ttf",
        "--build_dir", str(build),
        *[str(file) for file in sorted(svgs.glob("*.svg"))],
    ]
    subprocess.run(command, check=True, env=environment)
    return build / "SBEmoji.ttf"


def hexcode(text: str) -> str:
    return "-".join(f"{ord(character):X}" for character in text)


def shape_coverage(ttf: Path, emojibase_en: Path, max_version: int):
    """The emoji that the font draws as one glyph, in the order of the data, and the ones that it does not."""
    font = hb.Font(hb.Face(hb.Blob.from_file_path(str(ttf))))
    entries = []
    for row in json.loads(emojibase_en.read_text(encoding="utf-8")):
        if row.get("group") is None or row.get("group") == 2:
            continue
        entries.append((row["emoji"], row["version"]))
        entries.extend((skin["emoji"], skin["version"]) for skin in row.get("skins", []))
    drawn, missing = [], []
    for emoji, version in entries:
        buffer = hb.Buffer()
        buffer.add_str(emoji)
        buffer.guess_segment_properties()
        buffer.flags = hb.BufferFlags.REMOVE_DEFAULT_IGNORABLES
        hb.shape(font, buffer, {})
        glyphs = [info.codepoint for info in buffer.glyph_infos]
        if len(glyphs) == 1 and glyphs[0] != 0:
            drawn.append(emoji)
        else:
            missing.append((emoji, version))
    too_old = [emoji for emoji, version in missing if version <= max_version]
    if too_old:
        raise SystemExit(f"The font does not draw {len(too_old)} emoji of Emoji {max_version} or older, such as {too_old[:5]}.")
    return drawn, missing


def unicode_range(code_points) -> str:
    points = sorted(code_points)
    pieces, start, previous = [], points[0], points[0]
    for point in points[1:]:
        if point == previous + 1:
            previous = point
            continue
        pieces.append((start, previous))
        start = previous = point
    pieces.append((start, previous))
    return ", ".join(f"U+{a:X}" if a == b else f"U+{a:X}-{b:X}" for a, b in pieces)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--svg", required=True, type=Path)
    parser.add_argument("--emojibase-en", required=True, type=Path)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--woff2", required=True, type=Path)
    parser.add_argument("--coverage", required=True, type=Path)
    parser.add_argument("--range", required=True, type=Path)
    parser.add_argument("--summary", required=True, type=Path)
    parser.add_argument("--max-version", required=True, type=int)
    arguments = parser.parse_args()

    renamed, squared = prepare_svgs(arguments.svg, arguments.work / "svg")
    ttf = run_nanoemoji(arguments.work / "svg", arguments.work / "build")

    font = TTFont(str(ttf))
    for table in font["cmap"].tables:
        table.cmap.pop(0x20, None)
    font["head"].created = font["head"].modified = FIXED_TIME
    plain = arguments.work / "final.ttf"
    font.save(str(plain))
    font.flavor = "woff2"
    arguments.woff2.parent.mkdir(parents=True, exist_ok=True)
    font.save(str(arguments.woff2))

    drawn, missing = shape_coverage(plain, arguments.emojibase_en, arguments.max_version)
    arguments.coverage.write_text("".join(f"{hexcode(emoji)}\n" for emoji in drawn), encoding="utf-8")

    cmap = set(font.getBestCmap().keys())
    arguments.range.write_text(unicode_range((cmap | SEQUENCE_PARTS) - TEXT_CHARACTERS) + "\n", encoding="utf-8")

    arguments.summary.write_text(json.dumps({
        "renamedSvgs": renamed,
        "squaredSvgs": squared,
        "glyphs": len(font.getGlyphOrder()),
        "cmapEntries": len(cmap),
        "drawn": len(drawn),
        "notDrawn": len(missing),
        "notDrawnVersions": sorted({version for _emoji, version in missing}),
        "tools": {name: importlib.metadata.version(name) for name in ("nanoemoji", "fonttools", "picosvg", "ufo2ft", "skia-pathops", "uharfbuzz", "brotli")},
    }, indent=4) + "\n", encoding="utf-8")


main()
