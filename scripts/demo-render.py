#!/usr/bin/env python3
"""
Renders docs/demo.gif from a real `asw use` run.

This is generated, not a screen recording: demo-setup.sh builds a throwaway
sandbox, the CLI is executed against it with FORCE_COLOR=1, and its actual ANSI
output is drawn with Menlo. So the GIF cannot drift from what the tool prints --
re-running this script is the whole update story, and nothing here reads or
writes a real config.

Needs Pillow (`pip3 install --user Pillow`). No ffmpeg, no VHS, no tty.
"""

import os
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SANDBOX = "/tmp/asw-demo"
OUT = ROOT / "docs" / "demo.gif"

# Catppuccin Mocha, matching what the CLI's own colors look like on a dark terminal.
BG, FG, BOLD_FG = (30, 30, 46), (205, 214, 244), (245, 224, 220)
DIM, GREEN, YELLOW, RED, CYAN = (127, 132, 156), (166, 227, 161), (249, 226, 175), (243, 139, 168), (137, 220, 235)

FONT_REGULAR = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 15, index=0)
FONT_BOLD = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 15, index=1)
PAD, LINE_H = 22, 24

COMMAND = "asw use myproxy"
PROMPT = "$ "
SANDBOX_DISPLAY = "~"

SGR = re.compile(r"\x1b\[([0-9;]*)m")
FG_NAMES = {31: "red", 32: "green", 33: "yellow", 35: "magenta", 36: "cyan"}

# Typing and reveal pacing, in milliseconds. Deterministic on purpose: a
# regenerated asset should be byte-identical.
TYPE_MS, LINE_MS, HOLD_MS = 40, 90, 2600


def prepare(text):
    """
    The only transform applied to the CLI's real output: the throwaway sandbox
    root becomes `~`, so the animation shows the paths a reader would actually
    have rather than /tmp/asw-demo/... Everything else is drawn exactly as
    printed.
    """
    return text.replace(SANDBOX, SANDBOX_DISPLAY)


def apply_sgr(state, params):
    for code in [int(p) for p in params.split(";") if p] or [0]:
        if code == 0:
            state.update(fg=None, bold=False, dim=False)
        elif code == 1:
            state["bold"] = True
        elif code == 2:
            state["dim"] = True
        elif code == 22:
            state["bold"] = state["dim"] = False
        elif code in FG_NAMES:
            state["fg"] = FG_NAMES[code]
        elif code in (37, 39):
            state["fg"] = None


def tokenize(text):
    """Split ANSI text into lines of (text, style) spans."""
    lines, state, pos = [[]], {"fg": None, "bold": False, "dim": False}, 0

    def emit(chunk):
        if not chunk:
            return
        *complete, tail = chunk.split("\n")
        for part in complete:
            if part:
                lines[-1].append((part, dict(state)))
            lines.append([])
        if tail:
            lines[-1].append((tail, dict(state)))

    for match in SGR.finditer(text):
        emit(text[pos:match.start()])
        apply_sgr(state, match.group(1))
        pos = match.end()
    emit(text[pos:])
    while lines and not lines[-1]:
        lines.pop()
    return lines


def color_of(style):
    if style["dim"]:
        return DIM
    if style["fg"] == "green":
        return GREEN
    if style["fg"] == "yellow":
        return YELLOW
    if style["fg"] == "red":
        return RED
    if style["fg"] == "cyan":
        return CYAN
    return BOLD_FG if style["bold"] else FG


def run_demo():
    subprocess.run([str(ROOT / "scripts" / "demo-setup.sh"), SANDBOX], check=True,
                   stdout=subprocess.DEVNULL)
    env = {
        **os.environ,
        "AGENTSW_HOME": SANDBOX,
        "AGENTSW_LANG": "en",
        "FORCE_COLOR": "1",  # the CLI is piped here, so colors must be forced
        "PATH": f"{SANDBOX}/bin:{os.environ['PATH']}",
    }
    result = subprocess.run(["asw", "use", "myproxy"], capture_output=True, text=True, env=env)
    if result.returncode != 0:
        sys.exit(f"`asw use myproxy` failed ({result.returncode}):\n{result.stderr}")
    return result.stdout


def width_of(spans):
    return sum((FONT_BOLD if s["bold"] else FONT_REGULAR).getlength(t) for t, s in spans)


def draw(lines, draw_to, size):
    image = Image.new("RGB", size, BG)
    pen = ImageDraw.Draw(image)
    for index, spans in enumerate(lines):
        if index > draw_to:
            break
        x = PAD
        y = PAD + index * LINE_H
        for text, style in spans:
            # The command line is drawn by the caller as prompt + partial command.
            font = FONT_BOLD if style["bold"] else FONT_REGULAR
            pen.text((x, y), text, font=font, fill=color_of(style))
            x += font.getlength(text)
    return image


def main():
    output = tokenize(prepare(run_demo()))
    if not output:
        sys.exit("the CLI printed nothing; refusing to render an empty demo")

    command_line = [(PROMPT, {"fg": "cyan", "bold": False, "dim": False}),
                    (COMMAND, {"fg": None, "bold": False, "dim": False})]
    content = [command_line] + output

    width = int(max(width_of(line) for line in content)) + PAD * 2
    size = (width, PAD * 2 + LINE_H * len(content))

    def command_frames(upto):
        """The command line, typed up to `upto` characters."""
        spans = [(PROMPT, {"fg": "cyan", "bold": False, "dim": False}),
                 (COMMAND[:upto], {"fg": None, "bold": False, "dim": False})]
        return [spans]

    frames, durations = [], []
    for typed in range(1, len(COMMAND) + 1):
        frames.append(draw(command_frames(typed), 0, size))
        durations.append(TYPE_MS)
    for revealed in range(1, len(output) + 1):
        frames.append(draw(content, revealed, size))
        durations.append(LINE_MS)
    # The finished output simply stays on screen; fold the hold into the last
    # frame rather than appending a duplicate that only survives because the
    # encoder happens to merge identical frames.
    durations[-1] += HOLD_MS

    # One palette for every frame: quantizing each independently makes the
    # background shimmer between them.
    palette = frames[-1].quantize(colors=64, method=Image.MEDIANCUT)
    indexed = [frame.quantize(palette=palette, dither=Image.NONE) for frame in frames]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    indexed[0].save(OUT, save_all=True, append_images=indexed[1:], duration=durations,
                    loop=0, optimize=True)
    print(f"{OUT.relative_to(ROOT)}: {len(frames)} frames, {size[0]}x{size[1]}, "
          f"{OUT.stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
