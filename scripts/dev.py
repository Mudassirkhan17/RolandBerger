"""Run the Helios frontend and backend together for local development."""

import signal
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VENV_PYTHON = ROOT / "backend" / ".venv" / "bin" / "python"


def main() -> int:
    if not VENV_PYTHON.exists():
        print("Backend environment is missing. Run: npm run setup", file=sys.stderr)
        return 1

    processes = [
        subprocess.Popen(
            [
                str(VENV_PYTHON),
                "-m",
                "uvicorn",
                "backend.app.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                "8000",
                "--reload",
            ],
            cwd=ROOT,
        ),
        subprocess.Popen(
            ["npm", "run", "dev", "--prefix", "frontend"],
            cwd=ROOT,
        ),
    ]

    def stop(*_: object) -> None:
        for process in processes:
            if process.poll() is None:
                process.terminate()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    try:
        while all(process.poll() is None for process in processes):
            time.sleep(0.25)
    finally:
        stop()
        for process in processes:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()

    failed = next((process.returncode for process in processes if process.returncode), 0)
    return int(failed or 0)


if __name__ == "__main__":
    raise SystemExit(main())
