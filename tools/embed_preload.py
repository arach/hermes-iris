#!/usr/bin/env python3
"""Replace the <script id="logviz-preload"> window.LOGVIZ_PRELOAD = ...; </script> block.

Usage:
  python3 tools/embed_preload.py --html dashboard/index.rich.html --json sample/rich/events.json
  python3 tools/embed_preload.py --html IN.html --json events.json --out OUT.html
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


PRELOAD_RE = re.compile(
    r"<script\s+id=[\"']logviz-preload[\"']\s*>.*?window\.LOGVIZ_PRELOAD\s*=\s*.*?</script>",
    re.DOTALL | re.IGNORECASE,
)
SCRIPT_RE = re.compile(
    r"<script\s+id=[\"']logviz-preload[\"']\s*>.*?</script>",
    re.DOTALL | re.IGNORECASE,
)


def payload_from_json(path: Path) -> str:
    obj = json.loads(path.read_text(encoding="utf-8"))
    dumped = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return dumped.replace("</", "<\\/")


def make_block(payload: str) -> str:
    return '<script id="logviz-preload">window.LOGVIZ_PRELOAD = ' + payload + ";</script>"


def embed(html: str, payload: str) -> str:
    block = make_block(payload)
    if PRELOAD_RE.search(html):
        return PRELOAD_RE.sub(lambda _m: block, html, count=1)
    if SCRIPT_RE.search(html):
        return SCRIPT_RE.sub(lambda _m: block, html, count=1)
    # Insert after the three.js script if present, else before </body>.
    three = re.search(r'<script[^>]+three[^>]*></script>', html, re.IGNORECASE)
    if three:
        i = three.end()
        return html[:i] + "\n  " + block + html[i:]
    idx = html.lower().rfind("</body>")
    if idx >= 0:
        return html[:idx] + "  " + block + "\n" + html[idx:]
    return html + "\n" + block + "\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Embed events JSON as window.LOGVIZ_PRELOAD")
    p.add_argument("--html", required=True, help="Source HTML path")
    p.add_argument("--json", required=True, help="events.json to embed")
    p.add_argument("--out", help="Output HTML (default: overwrite --html)")
    args = p.parse_args(argv)
    html_path = Path(args.html)
    json_path = Path(args.json)
    out_path = Path(args.out) if args.out else html_path
    if not html_path.exists():
        print(f"missing html: {html_path}", file=sys.stderr)
        return 1
    if not json_path.exists():
        print(f"missing json: {json_path}", file=sys.stderr)
        return 1
    html = html_path.read_text(encoding="utf-8")
    payload = payload_from_json(json_path)
    new = embed(html, payload)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(new, encoding="utf-8")
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes), preload {len(payload)} chars")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
