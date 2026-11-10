#!/usr/bin/env python3
"""
Regenerate the poster frames for the README's video players.

GitHub renders a `<video>` tag with a poster image, so the README shows
a still frame rather than a black box. The poster is picked to be a
frame that says what the video is about, not just the first one.

Usage:  python3 scripts/make-posters.py
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# video, poster, and the second at which to take the frame.
POSTERS = [
    ("docs/agent-demo.mp4", "docs/agent-demo-poster.jpg", 6),
    ("docs/demo.mp4", "docs/demo-poster.jpg", 30),
]


def main() -> int:
    ffmpeg = "ffmpeg"
    if not Path(ffmpeg).exists():
        print(
            "ffmpeg is not on the PATH. Install it, or run the same command by hand:\n"
            "  ffmpeg -y -ss <second> -i <video> -frames:v 1 -q:v 3 <poster>",
            file=sys.stderr,
        )
        return 1

    for video, poster, second in POSTERS:
        video_path = ROOT / video
        poster_path = ROOT / poster

        if not video_path.exists():
            print(f"skipping {poster}: {video} does not exist")
            continue

        command = [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-ss",
            str(second),
            "-i",
            str(video_path),
            "-frames:v",
            "1",
            "-q:v",
            "3",
            str(poster_path),
        ]

        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            print(result.stderr[-800:], file=sys.stderr)
            return 1

        print(f"{poster}: {poster_path.stat().st_size // 1024} KiB")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
