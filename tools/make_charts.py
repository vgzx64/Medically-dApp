#!/usr/bin/env python3
"""Generate the performance charts of the load test report.

Reads the JSON report produced by ``tools/loadtest.js`` and renders two
figures into the output directory:

* ``loadtest-latency.png``    - p50/p95/p99 latency per profile,
* ``loadtest-throughput.png`` - throughput and failed transactions per profile.

The charts are produced as SVG with the Python standard library only (no
third-party plotting dependency) and rasterised with ImageMagick, which keeps
the toolchain reproducible in a minimal environment.

Usage::

    python3 tools/make_charts.py artifacts/logs/loadtest.json artifacts/logs
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

WIDTH, HEIGHT = 880, 480
MARGIN_LEFT, MARGIN_TOP, MARGIN_RIGHT, MARGIN_BOTTOM = 90, 60, 40, 90

PALETTE = {
    "p50": "#2f6fb2",
    "p95": "#d1495b",
    "p99": "#8a4f9e",
    "tps": "#2a9d8f",
    "fail": "#e07a1f",
    "axis": "#5b6470",
    "grid": "#dfe3e8",
    "text": "#1f2933",
}

LABELS = {
    "sequential": "Sequential\n30 tx / 1 client",
    "parallel": "Parallel\n30 tx / 5 clients",
}


def esc(value: object) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def nice_ticks(top: float, count: int = 5) -> list[float]:
    """Round axis ticks up to a human friendly step."""
    if top <= 0:
        return [0, 1]
    raw = top / count
    magnitude = 10 ** (len(str(int(raw))) - 1)
    step = next(
        (m * magnitude for m in (1, 2, 2.5, 5, 10) if raw <= m * magnitude),
        magnitude * 10,
    )
    ticks = []
    value = 0.0
    while value < top - 1e-9:
        ticks.append(value)
        value += step
    # Always emit one tick above the data so that bars never touch the frame.
    ticks.append(value)
    return ticks


def svg_document(parts: list[str]) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="{}" height="{}" '
        'viewBox="0 0 {} {}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif">\n'
        '<rect width="{}" height="{}" fill="white"/>\n{}\n</svg>\n'
    ).format(WIDTH, HEIGHT, WIDTH, HEIGHT, WIDTH, HEIGHT, "\n".join(parts))


def frame(top: float, title: str, y_label: str) -> tuple[list[str], float, float, list[float]]:
    """Return the SVG skeleton, the plot geometry and the y ticks."""
    plot_w = WIDTH - MARGIN_LEFT - MARGIN_RIGHT
    plot_h = HEIGHT - MARGIN_TOP - MARGIN_BOTTOM
    ticks = nice_ticks(top)
    scale_max = ticks[-1] if ticks[-1] > 0 else 1

    def y_of(value: float) -> float:
        return MARGIN_TOP + plot_h * (1 - value / scale_max)

    parts: list[str] = [
        f'<text x="{WIDTH / 2}" y="28" text-anchor="middle" font-size="17" '
        f'font-weight="bold" fill="{PALETTE["text"]}">{esc(title)}</text>',
        f'<text x="18" y="{MARGIN_TOP + plot_h / 2}" text-anchor="middle" '
        f'font-size="12" fill="{PALETTE["axis"]}" '
        f'transform="rotate(-90 18 {MARGIN_TOP + plot_h / 2})">{esc(y_label)}</text>',
    ]
    for tick in ticks:
        y = y_of(tick)
        parts.append(
            f'<line x1="{MARGIN_LEFT}" y1="{y:.1f}" x2="{MARGIN_LEFT + plot_w}" '
            f'y2="{y:.1f}" stroke="{PALETTE["grid"]}" stroke-width="1"/>'
        )
        parts.append(
            f'<text x="{MARGIN_LEFT - 8}" y="{y + 4:.1f}" text-anchor="end" '
            f'font-size="11" fill="{PALETTE["axis"]}">{tick:g}</text>'
        )
    parts.append(
        f'<line x1="{MARGIN_LEFT}" y1="{MARGIN_TOP}" x2="{MARGIN_LEFT}" '
        f'y2="{MARGIN_TOP + plot_h}" stroke="{PALETTE["axis"]}" stroke-width="1.2"/>'
    )
    parts.append(
        f'<line x1="{MARGIN_LEFT}" y1="{MARGIN_TOP + plot_h}" '
        f'x2="{MARGIN_LEFT + plot_w}" y2="{MARGIN_TOP + plot_h}" '
        f'stroke="{PALETTE["axis"]}" stroke-width="1.2"/>'
    )
    return parts, plot_w, plot_h, ticks


def label(parts: list[str], x: float, y: float, text: str, size: int = 12,
          anchor: str = "middle", color: str | None = None) -> None:
    """Draw a (possibly multi line) SVG text label."""
    lines = text.split("\n")
    fill = color or PALETTE["text"]
    for i, line in enumerate(lines):
        parts.append(
            f'<text x="{x:.1f}" y="{y + i * 14}" text-anchor="{anchor}" '
            f'font-size="{size}" fill="{fill}">{esc(line)}</text>'
        )


def legend(parts: list[str], entries: list[tuple[str, str]]) -> None:
    y = HEIGHT - 16
    total = sum(34 + 7 * len(text) for _, text in entries)
    x = (WIDTH - total) / 2
    for color, text in entries:
        parts.append(f'<rect x="{x:.1f}" y="{y - 11}" width="12" height="12" fill="{color}"/>')
        label(parts, x + 18, y, text, anchor="start")
        x += 34 + 7 * len(text)


def write_svg(svg: str, svg_path: Path) -> Path:
    svg_path.write_text(svg, encoding="utf-8")
    png_path = svg_path.with_suffix(".png")
    convert = shutil.which("convert") or shutil.which("magick")
    if convert:
        subprocess.run(
            [convert, "-density", "130", "-background", "white", str(svg_path), str(png_path)],
            check=True,
            capture_output=True,
        )
        return png_path
    print(f"ImageMagick not found, kept {svg_path}", file=sys.stderr)
    return svg_path


def chart_latency(profiles: list[dict], out_dir: Path) -> Path:
    series = ["p50", "p95", "p99"]
    top = max((p["latencyMs"].get(key, 0) for p in profiles for key in series), default=1)
    parts, plot_w, plot_h, ticks = frame(top * 1.1, "Latency percentiles by profile", "Latency, ms")

    groups = [LABELS.get(p["profile"], p["profile"]) for p in profiles]
    band = plot_w / max(len(groups), 1)
    n = len(series)
    bar_w = min(56.0, (band - 24) / n)
    scale = ticks[-1] or 1

    for gi, profile in enumerate(profiles):
        base_x = MARGIN_LEFT + band * gi + (band - bar_w * n) / 2
        for si, key in enumerate(series):
            value = profile["latencyMs"].get(key, 0)
            x = base_x + si * bar_w
            h = plot_h * (value / scale)
            y = MARGIN_TOP + plot_h - h
            parts.append(
                f'<rect x="{x + 1:.1f}" y="{y:.1f}" width="{bar_w - 2:.1f}" '
                f'height="{max(h, 0):.1f}" fill="{PALETTE[key]}"/>'
            )
            label(parts, x + bar_w / 2, y - 6, str(value), size=10)
        for i, line in enumerate(groups[gi].split("\n")):
            label(parts, MARGIN_LEFT + band * (gi + 0.5), MARGIN_TOP + plot_h + 24 + i * 14, line)

    legend(parts, [(PALETTE[key], key) for key in series])
    return write_svg(svg_document(parts), out_dir / "loadtest-latency.svg")


def chart_throughput(profiles: list[dict], out_dir: Path) -> Path:
    tps = [p.get("tps", 0) for p in profiles]
    fails = [p.get("failed", 0) for p in profiles]
    top = max(max(tps, default=1), 1)
    parts, plot_w, plot_h, ticks = frame(
        top * 1.3, "Throughput and failed transactions", "Transactions per second"
    )

    groups = [LABELS.get(p["profile"], p["profile"]) for p in profiles]
    band = plot_w / max(len(groups), 1)
    bar_w = min(90.0, band * 0.4)
    scale = ticks[-1] or 1

    for gi, value in enumerate(tps):
        x = MARGIN_LEFT + band * (gi + 0.5) - bar_w / 2
        h = plot_h * (value / scale)
        y = MARGIN_TOP + plot_h - h
        parts.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w:.1f}" height="{max(h, 0):.1f}" '
            f'fill="{PALETTE["tps"]}"/>'
        )
        label(parts, x + bar_w / 2, y - 8, f"{value:.1f} tx/s", size=12)

    max_fail = max(fails + [1])
    for gi, value in enumerate(fails):
        cx = MARGIN_LEFT + band * (gi + 0.5)
        cy = MARGIN_TOP + plot_h * (1 - value / (max_fail * 1.6))
        parts.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="6" fill="{PALETTE["fail"]}"/>')
        label(parts, cx, cy - 12, f"{value} failed", size=11, color=PALETTE["fail"])

    for gi, group in enumerate(groups):
        for i, line in enumerate(group.split("\n")):
            label(parts, MARGIN_LEFT + band * (gi + 0.5), MARGIN_TOP + plot_h + 24 + i * 14, line)

    legend(parts, [(PALETTE["tps"], "throughput (tx/s)"), (PALETTE["fail"], "failed transactions")])
    return write_svg(svg_document(parts), out_dir / "loadtest-throughput.svg")


def main() -> int:
    report_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("artifacts/logs/loadtest.json")
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else report_path.parent

    report = json.loads(report_path.read_text(encoding="utf-8"))
    profiles = report.get("profiles", [])
    if not profiles:
        print("no profiles in the load test report", file=sys.stderr)
        return 1

    out_dir.mkdir(parents=True, exist_ok=True)
    written = [chart_latency(profiles, out_dir), chart_throughput(profiles, out_dir)]

    for p in profiles:
        latency = p["latencyMs"]
        gas = p.get("gasUsed", {})
        print(
            f"{p['profile']:<11} tps={p.get('tps')} p50={latency['p50']}ms "
            f"p95={latency['p95']}ms failed={p['failed']} gas(mean)={gas.get('mean')}"
        )
    for path in written:
        print(f"written {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
