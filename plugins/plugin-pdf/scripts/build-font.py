#!/usr/bin/env python3
"""Regenerates the bundled report font asset.

The renderer ships one open-source CJK font so PDF export never depends on a
machine having a Chinese font installed. The source is Noto Sans SC (SIL OFL
1.1, no Reserved Font Name on the "Noto" family — the declared reserved name is
'Source' and is not used here), instanced to Regular and subset to the printable
ASCII range plus the full GB2312 repertoire. That budget keeps the asset around
2.2 MB while covering everyday Simplified Chinese; characters outside it are
reported by the renderer and can be served by a system font or a font pointed at
by DSH_PDF_FONT.

Requires fonttools and a Noto Sans SC variable font (Windows: the
"NotoSansSC-VF.ttf" that ships with the Windows font pack). Run from this
directory; the output overwrites assets/fonts/NotoSansSC-Regular.ttf.
"""
import io
import os
import subprocess
import sys
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_ROOT = os.path.dirname(HERE)
SOURCE = os.environ.get(
    'NOTO_SANS_SC_VF',
    'C:/Windows/Fonts/NotoSansSC-VF.ttf',
)
OUTPUT = os.path.join(PLUGIN_ROOT, 'assets', 'fonts', 'NotoSansSC-Regular.ttf')
FAMILY = 'Noto Sans SC'
STYLE = 'Regular'
POSTSCRIPT = 'NotoSansSC-Regular'

RANGES = [
    (0x0020, 0x007E),  # printable ASCII
    (0x00A0, 0x00FF),  # Latin-1 supplement (degree, times, middle dot, ...)
    (0x2010, 0x201F),  # dashes and curly quotes
    (0x2022, 0x2022), (0x2026, 0x2026), (0x2030, 0x2030), (0x2039, 0x203A),
    (0x2212, 0x2212), (0x2264, 0x2265),
    (0x2460, 0x2473),  # circled numbers
    (0x25A0, 0x25A1), (0x25CF, 0x25CF), (0x2605, 0x2606),
    (0x3000, 0x303F),  # CJK symbols and punctuation
    (0xFF00, 0xFFEF),  # fullwidth forms
]


def charset() -> list[int]:
    codepoints = set()
    for start, end in RANGES:
        codepoints.update(range(start, end + 1))
    # The GB2312 repertoire (symbol rows A1-A9 and hanzi rows B0-F7).
    for high in range(0xA1, 0xF8):
        for low in range(0xA1, 0xFF):
            try:
                char = bytes([high, low]).decode('gb2312')
            except UnicodeDecodeError:
                continue
            codepoints.add(ord(char))
    return sorted(codepoints)


def rename(font: TTFont) -> None:
    """Pin the name records to the instanced Regular style."""
    names = {
        1: FAMILY,
        2: STYLE,
        3: f'{FAMILY};{STYLE};subset',
        4: f'{FAMILY} {STYLE}',
        6: POSTSCRIPT,
        16: FAMILY,
        17: STYLE,
    }
    for record in font['name'].names:
        if record.nameID in names:
            record.string = names[record.nameID].encode(record.getEncoding())
    if 'fvar' in font:
        del font['fvar']
    if 'STAT' in font:
        del font['STAT']


def main() -> int:
    if not os.path.exists(SOURCE):
        print(f'source font not found: {SOURCE}', file=sys.stderr)
        return 1
    codepoints = charset()
    print(f'subsetting {len(codepoints)} codepoints from {SOURCE}')

    instance = os.path.join(PLUGIN_ROOT, '.font-instance.ttf')
    unicodes_file = os.path.join(PLUGIN_ROOT, '.font-unicodes.txt')
    try:
        # A single --unicodes argument overflows the Windows command line, so
        # the repertoire travels in a file instead.
        with io.open(unicodes_file, 'w', encoding='ascii', newline='\n') as handle:
            handle.write(','.join(f'U+{code:04X}' for code in codepoints))
        subprocess.run(
            [sys.executable, '-m', 'fontTools.varLib.instancer', '-o', instance,
             SOURCE, 'wght=400', '--no-recalc-timestamp'],
            check=True, capture_output=True, text=True,
        )
        os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
        subprocess.run(
            [sys.executable, '-m', 'fontTools.subset', instance,
             f'--unicodes-file={unicodes_file}', '--layout-features=*', '--no-hinting',
             '--drop-tables+=DSIG', '--name-IDs=*', '--recalc-bounds',
             f'--output-file={OUTPUT}'],
            check=True, capture_output=True, text=True,
        )
    finally:
        for path in (instance, unicodes_file):
            if os.path.exists(path):
                os.remove(path)

    subset = TTFont(OUTPUT)
    rename(subset)
    subset.save(OUTPUT)
    subset.close()
    glyphs = len(TTFont(OUTPUT, lazy=True).getGlyphOrder())
    print(f'wrote {OUTPUT} ({os.path.getsize(OUTPUT)} bytes, {glyphs} glyphs)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
