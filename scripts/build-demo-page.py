#!/usr/bin/env python3
"""
Write the demo page into docs/, so GitHub Pages publishes it.

The page holds the videos with real <video> elements. A README cannot
do this -- GitHub strips a <video> tag -- but a web page can, and
GitHub Pages serves an mp4 as video/mp4 with range support, so the
browser plays it rather than downloading it.

Usage:  python3 scripts/build-demo-page.py
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
OUT = DOCS / "index.html"


def main() -> int:
    # The page is rendered by the TypeScript module, so the markup has
    # one source of truth. tsx runs it.
    result = subprocess.run(
        [
            "npx",
            "tsx",
            str(ROOT / "scripts" / "render-demo-page.ts"),
        ],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
    )
    if result.returncode != 0:
        print(result.stderr[-1500:], file=sys.stderr)
        return 1

    if not OUT.exists():
        print(f"{OUT} was not written", file=sys.stderr)
        return 1

    print(f"{OUT.relative_to(ROOT)}: {OUT.stat().st_size // 1024} KiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
