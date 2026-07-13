#!/usr/bin/env python3
"""Validate and resolve the exact release SHA without interpolating shell code."""

import os
from pathlib import Path
import re
import subprocess
import sys


SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")


def required_sha(name: str) -> str:
    value = os.environ.get(name, "")
    if not SHA_PATTERN.fullmatch(value):
        raise SystemExit(f"{name} must be an exact lowercase 40-character SHA")
    return value


def git_output(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


def run_git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def resolve_release() -> None:
    requested_sha = required_sha("REQUESTED_SHA")
    fetch = run_git("fetch", "--no-tags", "origin", "main")
    if fetch.returncode != 0:
        raise SystemExit("Unable to refresh origin/main for release verification")

    available = run_git("cat-file", "-e", f"{requested_sha}^{{commit}}")
    if available.returncode != 0:
        raise SystemExit(
            "Requested SHA is unavailable after refreshing origin/main; "
            "only commits already published on main are eligible"
        )
    if git_output("rev-parse", f"{requested_sha}^{{commit}}") != requested_sha:
        raise SystemExit("Requested SHA did not resolve to itself")

    ancestry = run_git(
        "merge-base", "--is-ancestor", requested_sha, "origin/main"
    )
    if ancestry.returncode == 1:
        raise SystemExit(
            "Requested SHA is not reachable from origin/main; branch-only and "
            "pre-merge commits are not eligible for the release security gate"
        )
    if ancestry.returncode != 0:
        raise SystemExit("Unable to verify requested SHA ancestry against origin/main")

    output_path = Path(os.environ["GITHUB_OUTPUT"])
    with output_path.open("a", encoding="utf-8") as output:
        output.write(f"release_sha={requested_sha}\n")


def verify_checkout() -> None:
    expected_sha = required_sha("EXPECTED_SHA")
    if git_output("rev-parse", "HEAD") != expected_sha:
        raise SystemExit("Checked-out commit does not match the requested release SHA")


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in {"resolve", "verify"}:
        raise SystemExit("usage: verify-release-sha.py resolve|verify")
    if sys.argv[1] == "resolve":
        resolve_release()
    else:
        verify_checkout()


if __name__ == "__main__":
    main()
