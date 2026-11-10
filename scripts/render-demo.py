#!/usr/bin/env python3
"""
Render a recorded terminal session to an MP4.

The input is a text file: the raw output of the demo, with ANSI colour
codes intact. It is split into frames, one per line, and each frame is
drawn on a dark background in a monospace font with the colours honoured.
ffmpeg turns the PNG sequence into a video.

The point of this is that the recording shows the REAL output. There is
no animation, no mock-up, and nothing is retyped: the frames are the
lines the tool actually printed.
"""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

BG = (18, 20, 26)
FG = (208, 214, 224)

ANSI = {
    30: (60, 64, 72),    31: (237, 106, 94),   32: (126, 200, 138),
    33: (222, 178, 92),  34: (110, 154, 230),  35: (198, 137, 216),
    36: (100, 190, 200), 37: (208, 214, 224),
    90: (118, 126, 140), 91: (255, 140, 128),  92: (160, 224, 170),
    93: (244, 206, 128), 94: (148, 186, 245),  95: (220, 168, 236),
    96: (136, 212, 220), 97: (240, 244, 250),
}

ANSI_RE = re.compile(r"\033\[([0-9;]*)m")
BOLD_RE = re.compile(r"\033\[1m")


def parse_ansi(text: str):
    """Split a line into (colour, text, bold) runs."""
    runs = []
    colour = FG
    bold = False
    position = 0

    for match in ANSI_RE.finditer(text):
        if match.start() > position:
            runs.append((colour, text[position : match.start()], bold))
        codes = match.group(1)
        parts = [p for p in codes.split(";") if p != ""] or ["0"]
        for part in parts:
            number = int(part) if part.isdigit() else 0
            if number == 0:
                colour = FG
                bold = False
            elif number == 1:
                bold = True
            elif number in ANSI:
                colour = ANSI[number]
        position = match.end()

    if position < len(text):
        runs.append((colour, text[position:], bold))

    return runs


def wrap_ansi(line: str, width: int):
    """
    Wrap a line that has ANSI codes in it.

    The codes are re-applied at the start of each wrapped segment, so a
    coloured line stays coloured all the way down.
    """
    runs = parse_ansi(line)
    visible = ANSI_RE.sub("", line)

    if len(visible) <= width:
        return [line]

    # The colour of the first run is the line's colour.
    lead = ""
    for colour, chunk, bold in runs:
        code = next((k for k, v in ANSI.items() if v == colour), None)
        if code is not None:
            lead = f"\033[{code}m"
            break
        if chunk.strip():
            break

    pieces = []
    remaining = visible
    while remaining:
        take = remaining[:width]
        remaining = remaining[width:]
        if remaining:
            # Break on a space if there is one nearby.
            space = take.rfind(" ")
            if space > width // 2:
                take = take[:space]
                remaining = remaining[len(take) :]
        pieces.append(f"{lead}{take}\033[0m")

    return pieces


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: render-demo.py <transcript.txt> <out.mp4>", file=sys.stderr)
        return 2

    transcript_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    raw = transcript_path.read_text(encoding="utf-8", errors="replace")

    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("Pillow is needed: pip install pillow", file=sys.stderr)
        return 1

    font_path = "C:/Windows/Fonts/consola.ttf"
    bold_path = "C:/Windows/Fonts/consolab.ttf"
    font_size = 18
    line_height = 26

    font = ImageFont.truetype(font_path, font_size)
    bold_font = ImageFont.truetype(bold_path, font_size)
    title_font = ImageFont.truetype(font_path, 14)

    width, height = 1440, 810
    margin = 32
    lines_that_fit = (height - margin * 2 - 30) // line_height

    # --- the frames -------------------------------------------------------

    # Each line becomes one frame. The delay is how long that line is
    # shown for: a long line gets more time, and a banner gets more
    # still, because it is a heading.
    # How many characters fit on a line at this font size. The
    # refusals are long, and a refusal that runs off the edge is a
    # refusal the reader cannot read.
    max_chars = 104

    lines = raw.split("\n")
    frames = []
    for line in lines:
        stripped = ANSI_RE.sub("", line)
        delay = 0.45
        if stripped.startswith("$ ") or stripped.startswith("(exit"):
            delay = 1.1
        if stripped and len(stripped) < 70 and not stripped.startswith(" "):
            delay = 0.7

        # Wrap a long line, keeping the ANSI codes where they are. The
        # simplest correct approach is to wrap on the visible text and
        # re-apply the codes per segment.
        if len(stripped) > max_chars:
            for piece in wrap_ansi(line, max_chars):
                frames.append((piece, delay))
            continue

        frames.append((line, delay))

    work = Path(tempfile.mkdtemp(prefix="bv-demo-frames-"))
    print(f"rendering {len(frames)} frames")

    history: list[str] = []
    for index, (line, _delay) in enumerate(frames):
        history.append(line)
        history = history[-lines_that_fit:]

        image = Image.new("RGB", (width, height), BG)
        draw = ImageDraw.Draw(image)

        draw.rectangle([0, 0, width, 30], fill=(28, 31, 38))
        draw.text((margin, 7), "browser-verified-skill  —  bv", font=title_font, fill=(140, 150, 165))

        y = margin + 30
        for entry in history:
            x = margin
            for colour, chunk, is_bold in parse_ansi(entry):
                draw.text((x, y), chunk, font=bold_font if is_bold else font, fill=colour)
                x += draw.textlength(chunk, font=font)
            y += line_height

        image.save(work / f"frame-{index:05d}.png")

        if index % 60 == 0:
            print(f"  frame {index}/{len(frames)}")

    # --- the video --------------------------------------------------------

    # The concat file gives each frame its own duration.
    concat = work / "frames.txt"
    with concat.open("w", encoding="utf-8") as handle:
        for index, (_line, delay) in enumerate(frames):
            handle.write(f"file 'frame-{index:05d}.png'\n")
            handle.write(f"duration {delay:.3f}\n")
        # The concat demuxer needs the last frame repeated.
        handle.write(f"file 'frame-{len(frames) - 1:05d}.png'\n")

    command = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(concat),
        "-vf",
        "fps=24,format=yuv420p",
        "-c:v",
        "libx264",
        "-crf",
        "23",
        "-preset",
        "medium",
        str(output_path),
    ]

    print("encoding")
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stderr[-2500:], file=sys.stderr)
        return 1

    size = output_path.stat().st_size // 1024
    print(f"wrote {output_path} ({size} KiB)")
    print(f"frames kept in {work}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
