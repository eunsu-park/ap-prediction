"""Copy the latest realtime forecast JSON into the site data directory.

Runs after `vendor/realtime-regression-sw/scripts/run_realtime.py` inside the
GitHub Actions workflow. On success, the newest JSON under
`vendor/realtime-regression-sw/results/predictions/YYYYMMDD/` is copied to
`site/data/latest.json` and `site/data/status.json` is refreshed with
`status="ok"`. On failure (non-zero inference exit code), `latest.json` is
preserved as-is and `status.json` records the failure so the page can surface
a warning banner.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR = REPO_ROOT / "vendor" / "realtime-regression-sw" / "results" / "predictions"
SITE_DATA_DIR = REPO_ROOT / "site" / "data"


def _iso_now() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _load_status() -> dict:
    status_path = SITE_DATA_DIR / "status.json"
    if status_path.exists():
        with status_path.open("r", encoding="utf-8") as fp:
            return json.load(fp)
    return {
        "status": "unknown",
        "last_success_utc": None,
        "last_attempt_utc": None,
        "last_error": None,
    }


def _save_status(status: dict) -> None:
    SITE_DATA_DIR.mkdir(parents=True, exist_ok=True)
    with (SITE_DATA_DIR / "status.json").open("w", encoding="utf-8") as fp:
        json.dump(status, fp, indent=2, ensure_ascii=False)


def _find_latest_prediction() -> Path | None:
    if not RESULTS_DIR.exists():
        return None
    candidates = sorted(RESULTS_DIR.rglob("*.json"))
    return candidates[-1] if candidates else None


def _error_label(exit_code: int) -> tuple[str, str]:
    """Map realtime CLI exit code to a banner status + human message."""
    if exit_code == 0:
        return "ok", ""
    if exit_code == 2:
        return "warn", "InsufficientDataError — upstream data gap, waiting for next cycle."
    return "error", f"Inference exited with code {exit_code}."


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exit-code", type=int, required=True,
                        help="Exit code from run_realtime.py in the workflow.")
    args = parser.parse_args()

    now_iso = _iso_now()
    status = _load_status()
    status["last_attempt_utc"] = now_iso

    label, message = _error_label(args.exit_code)

    if args.exit_code == 0:
        latest = _find_latest_prediction()
        if latest is None:
            status["status"] = "error"
            status["last_error"] = {
                "code": 0,
                "message": "Inference reported success but no JSON output was found.",
            }
            _save_status(status)
            print("WARN: no prediction JSON located; status=error written.", file=sys.stderr)
            return 0

        SITE_DATA_DIR.mkdir(parents=True, exist_ok=True)
        dest = SITE_DATA_DIR / "latest.json"
        shutil.copy2(latest, dest)
        print(f"Copied {latest} -> {dest}")

        status["status"] = "ok"
        status["last_success_utc"] = now_iso
        status["last_error"] = None
    else:
        status["status"] = label
        status["last_error"] = {"code": args.exit_code, "message": message}
        print(f"Inference failed (exit={args.exit_code}); preserving previous latest.json.",
              file=sys.stderr)

    _save_status(status)
    return 0


if __name__ == "__main__":
    sys.exit(main())
