"""Iris Hermes plugin. register(ctx) wires /iris and `hermes iris`."""

from .commands import iris_cli, iris_command, setup_cli


def register(ctx) -> None:
    ctx.register_command(
        "iris",
        iris_command,
        description="Show where the Iris 3D visualizer lives and how to open it.",
        args_hint="[path|help]",
    )

    ctx.register_cli_command(
        "iris",
        "Show the Iris visualizer path and how to open it.",
        setup_cli,
        iris_cli,
        description="Print the Iris one-pager path and how to open it.",
    )

