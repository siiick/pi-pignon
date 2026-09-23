"""Tests for laya_worker.py (stdlib only): `.venv/bin/python -m unittest -v`."""

from __future__ import annotations

import json
import subprocess
import sys
import time
import unittest
from pathlib import Path

import laya_worker as w

WORKER_DIR = Path(__file__).resolve().parent


class FakeAgent:
    def __init__(self) -> None:
        self.calls = 0

    def predict(self, payload, questions):
        self.calls += 1
        return {"answers": {"q": {"type": "choice", "choice": "a", "confidence": 1.0}}}


def loaded_engine() -> w.Engine:
    engine = w.Engine(model_repo="test/model", revision="abc")
    engine._agent = FakeAgent()
    return engine


class ExpiredTest(unittest.TestCase):
    def test_no_deadline_never_expires(self):
        self.assertFalse(w.expired({"id": 1}))

    def test_past_and_future_deadlines(self):
        self.assertTrue(w.expired({"deadline_ms": 1_000}, now_ms=2_000))
        self.assertFalse(w.expired({"deadline_ms": 3_000}, now_ms=2_000))

    def test_ignores_non_numeric_deadlines(self):
        self.assertFalse(w.expired({"deadline_ms": "soon"}, now_ms=2_000))
        self.assertFalse(w.expired({"deadline_ms": True}, now_ms=2_000))


class HandleTest(unittest.TestCase):
    def test_decide_runs_before_the_deadline(self):
        engine = loaded_engine()
        deadline = time.time() * 1000 + 60_000
        response = w.handle(
            engine, {"id": 7, "method": "decide", "text": "x", "questions": {"q": {}}, "deadline_ms": deadline}
        )
        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["model"], "test/model")

    def test_expired_decide_is_not_run(self):
        engine = loaded_engine()
        response = w.handle(engine, {"id": 7, "method": "decide", "text": "x", "questions": {"q": {}}, "deadline_ms": 1})
        self.assertEqual(response, {"id": 7, "ok": False, "error": "deadline passed before processing"})
        self.assertEqual(engine._agent.calls, 0)

    def test_model_field_does_not_reload(self):
        engine = loaded_engine()
        agent = engine._agent
        w.handle(engine, {"id": 1, "method": "decide", "text": "x", "questions": {"q": {}}, "model": "other/model"})
        self.assertIs(engine._agent, agent)
        self.assertEqual(engine.model_repo, "test/model")

    def test_unknown_method(self):
        response = w.handle(loaded_engine(), {"id": 2, "method": "explode"})
        self.assertEqual(response, {"id": 2, "ok": False, "error": "Unknown method: explode"})


RUN_WITH_FAKE_MODEL = """
import sys, laya_worker as w
class FakeEngine(w.Engine):
    def load(self):
        print("library noise on stdout")
        self._agent = object()
w.Engine = FakeEngine
sys.exit(w.main())
"""


class MainLoopTest(unittest.TestCase):
    def run_worker(self, lines):
        proc = subprocess.run(
            [sys.executable, "-c", RUN_WITH_FAKE_MODEL],
            input="\n".join(lines) + "\n",
            capture_output=True,
            text=True,
            cwd=WORKER_DIR,
            timeout=30,
        )
        return proc, [json.loads(line) for line in proc.stdout.splitlines()]

    def test_protocol_stream_survives_bad_input(self):
        proc, messages = self.run_worker(
            ["42", "not json", '{"id": 1, "method": "health"}', '{"id": 2, "method": "shutdown"}']
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(messages[0]["type"], "ready")
        self.assertEqual(messages[0]["protocol"], w.PROTOCOL_VERSION)
        self.assertEqual(messages[1], {"id": None, "ok": False, "error": "Request must be a JSON object"})
        self.assertEqual(messages[2]["id"], None)
        self.assertTrue(messages[2]["error"].startswith("Invalid JSON"))
        self.assertTrue(messages[3]["ok"])
        self.assertEqual(messages[4], {"id": 2, "ok": True, "result": {"bye": True}})
        self.assertIn("library noise on stdout", proc.stderr)


if __name__ == "__main__":
    unittest.main()
