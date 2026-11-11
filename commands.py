"""Slash command /iris and CLI `hermes iris`."""

from __future__ import annotations

from pathlib import Path


def _root() -> Path:
    return Path(__file__).resolve().parent


def _page_path() -> Path:
    dash = _root() / "dashboard"
    return dash / "iris.html"


def explain() -> str:
    page = _page_path()
    return "\n".join(
        [
            "Iris draws Hermes sessions and logs as a 3D scene.",
            f"One-pager: {page}",
            "Dashboard: /dashboard-plugins/iris/iris.html",

            "Desktop: enable Iris, then open the Iris page. The right pane shows status.",
            "The page can load dashboard/sample-events.json. Drop a JSON or JSONL file to replace it.",
            "Live sessions: GET /api/plugins/iris/live (redacted export and local log tails).",
        ]
    )


def iris_command(raw_args: str = "", **kwargs) -> str:
    del kwargs
    try:
        text = raw_args.strip().lower() if isinstance(raw_args, str) else ""
        if text in {"path", "--path"}:
            return str(_page_path())
        if text in {"help", "-h", "--help"}:
            return explain() + "\n\nUsage: /iris [path|help]"
        return explain()
    except Exception as exc:  # noqa: BLE001 — return text instead of raising into the session
        return f"iris: {exc}"




def setup_cli(parser) -> None:
    parser.add_argument(
        "--path",
        action="store_true",
        help="Print only the one-pager path.",
    )


def iris_cli(args) -> int:
    if getattr(args, "path", False):
        print(_page_path())
    else:
        print(explain())
    return 0



