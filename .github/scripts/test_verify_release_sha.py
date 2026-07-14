#!/usr/bin/env python3
"""Contract tests for the main-only exact release SHA helper."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Optional
import unittest


SCRIPT = Path(__file__).with_name("verify-release-sha.py")
SECURITY_WORKFLOW = SCRIPT.parents[1] / "workflows" / "agi-security.yml"


def git(cwd: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", *args], cwd=cwd, text=True, stderr=subprocess.STDOUT
    ).strip()


class VerifyReleaseShaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.origin = self.root / "origin.git"
        self.checkout = self.root / "checkout"
        subprocess.run(["git", "init", "--bare", str(self.origin)], check=True)
        subprocess.run(
            ["git", "clone", str(self.origin), str(self.checkout)], check=True
        )
        git(self.checkout, "config", "user.name", "Andrea CI")
        git(self.checkout, "config", "user.email", "ci@example.invalid")
        git(self.checkout, "checkout", "-b", "main")
        git(self.checkout, "commit", "--allow-empty", "-m", "main release")
        self.main_sha = git(self.checkout, "rev-parse", "HEAD")
        git(self.checkout, "push", "-u", "origin", "main")
        git(self.checkout, "checkout", "-b", "feature")
        git(self.checkout, "commit", "--allow-empty", "-m", "unmerged feature")
        self.feature_sha = git(self.checkout, "rev-parse", "HEAD")
        self.output_path = self.root / "github-output.txt"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def run_helper(
        self,
        mode: str,
        *,
        requested: Optional[str] = None,
        expected: Optional[str] = None,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        if requested is not None:
            env["REQUESTED_SHA"] = requested
        if expected is not None:
            env["EXPECTED_SHA"] = expected
        env["GITHUB_OUTPUT"] = str(self.output_path)
        return subprocess.run(
            [sys.executable, str(SCRIPT), mode],
            cwd=self.checkout,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def test_resolve_accepts_exact_commit_already_on_main(self) -> None:
        result = self.run_helper("resolve", requested=self.main_sha)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.output_path.read_text(encoding="utf-8"),
            f"release_sha={self.main_sha}\n",
        )

    def test_resolve_rejects_unmerged_branch_commit(self) -> None:
        result = self.run_helper("resolve", requested=self.feature_sha)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("branch-only and pre-merge commits", result.stderr)

    def test_resolve_rejects_non_sha_input(self) -> None:
        result = self.run_helper("resolve", requested="main")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exact lowercase 40-character SHA", result.stderr)

    def test_resolve_rejects_unavailable_exact_sha(self) -> None:
        result = self.run_helper("resolve", requested="0" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("only commits already published on main", result.stderr)

    def test_verify_accepts_only_the_checked_out_commit(self) -> None:
        accepted = self.run_helper("verify", expected=self.feature_sha)
        rejected = self.run_helper("verify", expected=self.main_sha)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("does not match", rejected.stderr)

    def test_semgrep_container_trusts_only_the_checked_out_workspace(self) -> None:
        workflow = SECURITY_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn(
            'git config --global --add safe.directory "$GITHUB_WORKSPACE"',
            workflow,
        )
        self.assertNotIn("safe.directory '*'", workflow)
        self.assertNotIn('safe.directory "*"', workflow)


if __name__ == "__main__":
    unittest.main()
