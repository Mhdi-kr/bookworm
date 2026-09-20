#!/usr/bin/env python3
"""Build public/samples/little-test-book.epub — a short in-app tour of Bookworm."""

from __future__ import annotations

import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "samples" / "little-test-book.epub"
COVER_SVG = ROOT / "public" / "samples" / "cover.svg"
COVER_PNG = ROOT / "public" / "samples" / "cover.png"

TITLE = "The Open Page"
AUTHOR = "Ada Lovelace"
ISBN = "9781990000121"
DESCRIPTION = (
    "A short tour of Bookworm settings: type, theme, layout, voice, speed, and auto-play."
)

COVER_SVG_TEXT = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200" viewBox="0 0 800 1200">
  <rect width="800" height="1200" fill="#14201b"/>
  <rect x="36" y="36" width="728" height="1128" fill="#1f6b62"/>
  <rect x="56" y="56" width="688" height="1088" fill="none" stroke="#e8f0ed" stroke-width="1.25" opacity="0.4"/>
  <text x="400" y="220" text-anchor="middle" fill="#e8f0ed" font-family="Georgia, serif"
        font-size="18" letter-spacing="7">BOOKWORM</text>
  <text x="400" y="430" text-anchor="middle" fill="#e8f0ed" font-family="Georgia, serif"
        font-size="64">The Open Page</text>
  <line x1="250" y1="470" x2="550" y2="470" stroke="#7aa396" stroke-width="2"/>
  <path d="M210 820 C 300 680, 500 680, 590 820" fill="none" stroke="#e8f0ed" stroke-width="7"
        stroke-linecap="round" opacity="0.9"/>
  <path d="M210 820 C 300 900, 500 900, 590 820" fill="none" stroke="#7aa396" stroke-width="5"
        stroke-linecap="round"/>
  <circle cx="400" cy="820" r="7" fill="#e8f0ed"/>
  <text x="400" y="1020" text-anchor="middle" fill="#e8f0ed" font-family="Georgia, serif"
        font-size="24" letter-spacing="2">Ada Lovelace</text>
</svg>
"""

CSS = """
@namespace epub "http://www.idpf.org/2007/ops";
html, body {
  margin: 0;
  padding: 0;
}
body {
  padding: 1.25em 1.4em 2em;
  line-height: 1.65;
}
h1 {
  margin: 0 0 0.85em;
  font-size: 1.7em;
  font-weight: normal;
  line-height: 1.25;
}
p {
  margin: 0 0 0.95em;
  text-indent: 0;
}
p.lead {
  font-style: italic;
}
"""

CHAPTERS: list[tuple[str, str, str]] = [
    (
        "welcome",
        "Welcome",
        """
<p class="lead">This little volume is here so you can try Bookworm without hunting for a file. Open the gear in the bar: the panel is split into Reading and Speech, and the next two chapters walk through every control in that order.</p>
<p>Hover a paragraph until a small play mark appears, then click. Bookworm reads that passage aloud on this device. Nothing is sent away to be spoken.</p>
<p>If you would rather hear a whole stretch at once, click a chapter title instead of a paragraph. Pause and resume as often as you like. Stop ends the reading.</p>
""",
    ),
    (
        "reading",
        "Reading",
        """
<p class="lead">The first block in the gear is Reading. Each control below is in that block, in the same order.</p>
<p>Font lists Literata, Georgia, Baskerville, and OpenDyslexic. Tap a name to put that face on this page. Literata, Georgia, and Baskerville are book faces. OpenDyslexic is heavier if a stronger letter shape is easier to follow.</p>
<p>Font size sits under the fonts. Use A minus, the slider, or A plus. The number is a percent of the usual size, from smaller than default to larger.</p>
<p>Theme offers Paper, Fog, and Dark. Paper is daylight. Fog is cooler and softer. Dark is for a dim room. Switch among them as often as you like; the page should follow at once.</p>
<p>Orientation is Horizontal or Vertical. Horizontal keeps paginated pages: swipe, or use the side arrows. Vertical is one continuous scroll.</p>
""",
    ),
    (
        "speech",
        "Speech",
        """
<p class="lead">The second block in the gear is Speech. Each control below is in that block, in the same order.</p>
<p>Voice is a menu of named speakers. Heart is one of them. Pick a name, then tap this paragraph to hear it. The voice stays on this device.</p>
<p>Speed is a slider under Voice. Drag it slower or faster, even while a passage is playing. The pitch should stay put; only the pace changes.</p>
<p>Auto-play is the checkbox under Speed. Turn it on, tap a chapter title, and the next passage will start when this one ends. Follow the highlight, or sit back.</p>
<p>Inference device is a status line, not a switch. It shows GPU and WebGPU when the voice can run on the graphics chip, or CPU and WASM when it runs on the processor instead. The first listen may take a moment while the model settles; after that it is cached for offline use.</p>
""",
    ),
    (
        "shelf",
        "This copy stays with you",
        """
<p class="lead">The picture on this book came from the file, not from a catalog on the web. If a book has no picture, Bookworm draws a letter cover instead.</p>
<p>Import your own EPUB from the library. Titles, authors, and covers are read from the file. Search the shelf if it grows. Your place in the story is saved when you turn away.</p>
<p>Reading and Speech choices are saved on this device too: font, size, theme, orientation, voice, speed, and auto-play. Close the book and open it tomorrow; they will still be waiting.</p>
""",
    ),
]


def xhtml(title: str, body: str) -> bytes:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head>
  <meta charset="utf-8"/>
  <title>{title}</title>
  <link rel="stylesheet" type="text/css" href="stylesheet.css"/>
</head>
<body>
  <h1>{title}</h1>
  {body.strip()}
</body>
</html>
""".encode("utf-8")


def nav_points() -> str:
    parts = []
    for index, (stem, title, _body) in enumerate(CHAPTERS, start=1):
        parts.append(
            f"""    <navPoint id="nav{index}" playOrder="{index}">
      <navLabel><text>{title}</text></navLabel>
      <content src="{stem}.xhtml"/>
    </navPoint>"""
        )
    return "\n".join(parts)


def ncx() -> bytes:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="{ISBN}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>{TITLE}</text></docTitle>
  <navMap>
{nav_points()}
  </navMap>
</ncx>
""".encode("utf-8")


def nav_xhtml() -> bytes:
    items = "\n".join(
        f'      <li><a href="{stem}.xhtml">{title}</a></li>' for stem, title, _b in CHAPTERS
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Contents</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
{items}
    </ol>
  </nav>
</body>
</html>
""".encode("utf-8")


def opf() -> bytes:
    manifest_chapters = "\n".join(
        f'    <item id="{stem}" href="{stem}.xhtml" media-type="application/xhtml+xml"/>'
        for stem, _t, _b in CHAPTERS
    )
    spine = "\n".join(f'    <itemref idref="{stem}"/>' for stem, _t, _b in CHAPTERS)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>{TITLE}</dc:title>
    <dc:creator opf:role="aut">{AUTHOR}</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="BookId" opf:scheme="ISBN">{ISBN}</dc:identifier>
    <dc:publisher>Bookworm Press</dc:publisher>
    <dc:date>2026</dc:date>
    <dc:description>{DESCRIPTION}</dc:description>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="stylesheet.css" media-type="text/css"/>
    <item id="cover-image" href="cover.png" media-type="image/png"/>
{manifest_chapters}
  </manifest>
  <spine toc="ncx">
{spine}
  </spine>
</package>
""".encode("utf-8")


def container() -> bytes:
    return b"""<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""


def render_cover() -> bytes:
    COVER_SVG.write_text(COVER_SVG_TEXT, encoding="utf-8")
    subprocess.run(
        ["rsvg-convert", "-w", "800", "-h", "1200", str(COVER_SVG), "-o", str(COVER_PNG)],
        check=True,
    )
    png = COVER_PNG.read_bytes()
    COVER_SVG.unlink()
    COVER_PNG.unlink()
    return png


def build() -> None:
    cover = render_cover()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", container(), compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/content.opf", opf(), compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/toc.ncx", ncx(), compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/nav.xhtml", nav_xhtml(), compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/stylesheet.css", CSS.strip() + "\n", compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/cover.png", cover, compress_type=zipfile.ZIP_DEFLATED)
        for stem, title, body in CHAPTERS:
            zf.writestr(
                f"OEBPS/{stem}.xhtml",
                xhtml(title, body),
                compress_type=zipfile.ZIP_DEFLATED,
            )
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    build()
