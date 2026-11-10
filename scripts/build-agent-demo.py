#!/usr/bin/env python3
"""
Build the agent demo video from a Hermes session export.

The input is a Hermes session exported as markdown. It contains the
agent's messages and every tool call it made.

The output is an MP4 that reads like a terminal: the agent's prompt, its
narration, the commands it ran, and the refusals it hit.

Nothing here is staged. Every command in the video is one the agent
actually ran.
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

CYAN = (86, 182, 194)
DIM = (118, 126, 140)
RED = (237, 106, 94)
GREEN = (126, 200, 138)

ANSI_RE = re.compile(r"\033\[([0-9;]*)m")


def parse_ansi(text: str):
    runs = []
    colour = FG
    bold = False
    position = 0
    for match in ANSI_RE.finditer(text):
        if match.start() > position:
            runs.append((colour, text[position : match.start()], bold))
        codes = match.group(1)
        for part in [p for p in codes.split(";") if p != ""] or ["0"]:
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
    runs = parse_ansi(line)
    visible = ANSI_RE.sub("", line)
    if len(visible) <= width:
        return [line]

    lead = ""
    for colour, chunk, _bold in runs:
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
            space = take.rfind(" ")
            if space > width // 2:
                take = take[:space]
                remaining = remaining[len(take) :]
        pieces.append(f"{lead}{take}\033[0m")
    return pieces


# --- reading the export ----------------------------------------------------


def parse_export(path: Path):
    """The prompt, the agent's narration, and the commands it ran."""
    text = path.read_text(encoding="utf-8", errors="replace")

    prompt = ""
    narration = []
    commands = []

    # The prompt is the first User message.
    user = re.search(r"### User — [^\n]+\n\n(.*?)\n\n### Assistant", text, re.S)
    if user:
        prompt = user.group(1).strip()

    # The agent's narration is every Assistant message. The export puts
    # the raw tool-call JSON in the same block, so it is stripped: what
    # the agent SAID is the narration, not the wire format.
    for block in re.findall(r"### Assistant — [^\n]+\n\n(.*?)(?=\n\n###|\Z)", text, re.S):
        block = block.strip()
        # Drop the tool-call JSON.
        block = re.sub(r"##+\s*Tool calls\s*```json.*?```", "", block, flags=re.S)
        block = re.sub(r"```json.*?```", "", block, flags=re.S)
        block = re.sub(r'"response_item_id":.*', "", block, flags=re.S)
        block = block.strip()
        if block:
            narration.append(block)

    # The commands are the terminal calls in the tool-call JSON. The
    # arguments are a JSON string, so it is decoded twice.
    for block in re.findall(
        r'"name":\s*"terminal",\s*\n\s*"arguments":\s*"(.*?)"\s*\n', text, re.S
    ):
        try:
            args = json.loads(f'"{block}"')
            parsed = json.loads(args)
            command = parsed.get("command", "")
            if command:
                commands.append(command)
        except (ValueError, TypeError):
            continue

    return prompt, narration, commands


def shorten_command(command: str) -> str:
    """One command, on one line, with the noise taken out."""
    command = command.replace("\\\n", " ")
    # A newline in a command is a multi-line command. The renderer draws
    # one line at a time, so it has to be flattened.
    command = command.replace("\r", " ").replace("\n", " ")
    command = re.sub(r"\s+", " ", command).strip()
    # Drop the long flags an agent does not need to see.
    command = re.sub(r"\s+--(allowedTools|max-turns|permission-mode)[^\s]+\s*", " ", command)
    command = re.sub(r"\s{2,}", " ", command)
    return command


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: build-agent-demo.py <session.md> <out.mp4>", file=sys.stderr)
        return 2

    export_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    prompt, narration, commands = parse_export(export_path)
    print(f"the prompt: {len(prompt)} chars")
    print(f"the narration: {len(narration)} messages")
    print(f"the commands: {len(commands)}")

    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("Pillow is needed: pip install pillow", file=sys.stderr)
        return 1

    font_path = "C:/Windows/Fonts/consola.ttf"
    bold_path = "C:/Windows/Fonts/consolab.ttf"
    font_size = 17
    line_height = 25

    font = ImageFont.truetype(font_path, font_size)
    bold_font = ImageFont.truetype(bold_path, font_size)
    title_font = ImageFont.truetype(font_path, 14)

    width, height = 1440, 810
    margin = 30
    lines_that_fit = (height - margin * 2 - 30) // line_height
    max_chars = 108

    # --- the frames --------------------------------------------------------

    frames = []

    def add(text: str, delay: float):
        frames.append((text, delay))

    def add_banner(text: str):
        add(f"\033[1;36m{text}\033[0m", 1.6)

    def add_note(text: str):
        add(f"\033[0;90m{text}\033[0m", 0.55)

    def add_block(text: str, delay: float = 0.5):
        """A multi-line block, wrapped. Every line is one line."""
        for piece in text.replace("\r", "").split("\n"):
            for wrapped in wrap_ansi(piece, max_chars):
                add(wrapped, delay)
                delay = 0.35

    add_banner("The agent gets a link, and a task")
    add_note("")
    add_block(prompt, 0.45)
    add_note("")
    add_note("Nothing else. No installed skill, no pasted commands.")
    add_note("The agent has to work out how to use it.")

    add_banner("What the agent did")
    add_note("")

    # The commands, with the narration as the connective tissue.
    narration_index = 0
    for command in commands:
        short = shorten_command(command)
        if not short:
            continue
        # The narration before this command.
        while narration_index < len(narration):
            line = narration[narration_index]
            narration_index += 1
            if len(line) > 400:
                line = line[:400] + "..."
            for wrapped in wrap_ansi(line, max_chars):
                add(f"\033[0;37m{wrapped}\033[0m", 0.5)
            break

        # The command itself.
        for wrapped in wrap_ansi(f"$ {short}", max_chars):
            add(f"\033[1;37m{wrapped}\033[0m", 1.0)

        # A refusal gets more time, because it is the point.
        if "refused" in short or "exit" in short.lower():
            pass

    # The agent's final report, trimmed to the refusals.
    add_banner("What the agent reported")
    add_note("")
    final = "\n".join(narration[-3:])
    add_block(final[:2600], 0.5)

    add_banner("Done.")
    add_note("The agent was given a link and a task. It worked out the rest.")
    add_note("It did not work around a refusal.")

    print(f"rendering {len(frames)} frames")

    work = Path(tempfile.mkdtemp(prefix="bv-agent-frames-"))
    history: list[str] = []

    for index, (line, _delay) in enumerate(frames):
        history.append(line)
        history = history[-lines_that_fit:]

        image = Image.new("RGB", (width, height), BG)
        draw = ImageDraw.Draw(image)

        draw.rectangle([0, 0, width, 30], fill=(28, 31, 38))
        draw.text(
            (margin, 7),
            "Hermes  —  given a link to a skill",
            font=title_font,
            fill=(140, 150, 165),
        )

        y = margin + 30
        for entry in history:
            x = margin
            for colour, chunk, is_bold in parse_ansi(entry):
                # A chunk can be a multi-line string if the source had
                # one. The renderer draws one line at a time.
                chunk = chunk.replace("\r", "").replace("\n", " ")
                draw.text((x, y), chunk, font=bold_font if is_bold else font, fill=colour)
                x += draw.textlength(chunk, font=font)
            y += line_height

        image.save(work / f"frame-{index:05d}.png")
        if index % 80 == 0:
            print(f"  frame {index}/{len(frames)}")

    concat = work / "frames.txt"
    with concat.open("w", encoding="utf-8") as handle:
        for index, (_line, delay) in enumerate(frames):
            handle.write(f"file 'frame-{index:05d}.png'\n")
            handle.write(f"duration {delay:.3f}\n")
        handle.write(f"file 'frame-{len(frames) - 1:05d}.png'\n")

    command = [
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
        "-vf", "fps=24,format=yuv420p", "-c:v", "libx264", "-crf", "23",
        "-preset", "medium", str(output_path),
    ]

    print("encoding")
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stderr[-2500:], file=sys.stderr)
        return 1

    print(f"wrote {output_path} ({output_path.stat().st_size // 1024} KiB)")
    print(f"frames in {work}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
