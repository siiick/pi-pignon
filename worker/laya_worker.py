"""Long-lived stdio worker for the Laya System-1 decision model.

Loads the laya-mlx model once and speaks newline-delimited JSON over
stdin/stdout. The Pi extension owns its lifecycle.

Protocol
--------
Extension -> worker (one JSON object per line):

    {"id": 1, "method": "health", "deadline_ms": 1767225600000}
    {"id": 2, "method": "decide", "text": "...", "questions": {...}, "deadline_ms": ...}
    {"id": 3, "method": "shutdown"}

`deadline_ms` (optional, Unix epoch milliseconds) is when the caller stops
waiting; a request still queued after it is answered with an error instead of
being run.

Worker -> extension:

    {"type": "ready", "model": "aac6fef/laya-mlx", "backend": "laya-mlx"}
    {"type": "fatal", "error": "..."}
    {"id": 1, "ok": true, "result": {...}}
    {"id": 1, "ok": false, "error": "..."}

Requests are handled one at a time on the main thread. Human-readable
diagnostics go to stderr so stdout stays a clean protocol stream.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from typing import Any, Dict, Optional, TextIO

PROTOCOL_VERSION = "0.3.0"

PINNED_MODEL = "aac6fef/laya-mlx"
# Commit of PINNED_MODEL this router was calibrated on. Pinning keeps a change
# pushed to the Hub repo from silently changing routing decisions.
PINNED_REVISION = "20aed815fc6acde75733882e7ec0e3f28aeb9717"

DEFAULT_MODEL = os.getenv("LAYA_MODEL", PINNED_MODEL)
# LAYA_MODEL_REVISION overrides the pin; a custom LAYA_MODEL has no pin by
# default. An empty value means "latest".
DEFAULT_REVISION = os.getenv(
    "LAYA_MODEL_REVISION", PINNED_REVISION if DEFAULT_MODEL == PINNED_MODEL else ""
)
DEFAULT_DTYPE = os.getenv("LAYA_DTYPE", "float16")
DEFAULT_DEVICE = os.getenv("LAYA_DEVICE", "")  # "" -> library default
DEFAULT_BATCH_SIZE = int(os.getenv("LAYA_BATCH_SIZE", "16"))

# Protocol stream. `claim_stdout()` swaps it for a private duplicate of fd 1 so
# that anything else writing to stdout (prints, progress bars, native code)
# lands on stderr instead of corrupting the JSON-lines protocol.
_protocol: TextIO = sys.stdout


def log(message: str) -> None:
    """Write a diagnostic line to stderr (never pollutes the protocol)."""
    print(f"[laya-worker] {message}", file=sys.stderr, flush=True)


def claim_stdout() -> None:
    """Reserve the real stdout for protocol messages; redirect fd 1 to stderr."""
    global _protocol
    sys.stdout.flush()
    _protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr


def emit(payload: Dict[str, Any]) -> None:
    """Write one protocol message to the protocol stream."""
    _protocol.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _protocol.flush()


class Engine:
    """Thin wrapper around laya-mlx that keeps one Agent resident.

    The model is fixed for the life of the process (LAYA_MODEL); switching
    models means restarting the worker, never reloading on the request path.
    """

    def __init__(
        self,
        model_repo: str = DEFAULT_MODEL,
        revision: str = DEFAULT_REVISION,
        dtype: str = DEFAULT_DTYPE,
        device: str = DEFAULT_DEVICE,
        batch_size: int = DEFAULT_BATCH_SIZE,
    ) -> None:
        self.model_repo = model_repo
        self.revision = revision
        self.dtype = dtype
        self.device = device
        self.batch_size = batch_size
        self._agent: Any = None

    def load(self) -> None:
        import laya_mlx as laya

        kwargs: Dict[str, Any] = {"dtype": self.dtype}
        if self.device:
            kwargs["device"] = self.device
        if self.batch_size:
            kwargs["batch_size"] = self.batch_size
        if self.revision:
            kwargs["revision"] = self.revision
        else:
            log(f"warning: {self.model_repo} is not pinned to a revision; loading latest")

        log(
            f"loading {self.model_repo}@{self.revision or 'latest'} "
            f"(dtype={self.dtype}, device={self.device or 'auto'})"
        )
        self._agent = laya.load(self.model_repo, **kwargs)
        log(f"loaded {self.model_repo}")

    @property
    def ready(self) -> bool:
        return self._agent is not None

    def health(self) -> Dict[str, Any]:
        return {
            "status": "ok",
            "version": PROTOCOL_VERSION,
            "backend": "laya-mlx",
            "loaded_model": self.model_repo if self.ready else None,
            "ready": self.ready,
        }

    def decide(
        self,
        text: Optional[str] = None,
        state: Any = None,
        questions: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if self._agent is None:
            raise RuntimeError("Agent not loaded")

        payload = state if state is not None else (text or "")
        if not questions:
            raise ValueError("No questions supplied")

        result = self._agent.predict(payload, questions)
        return {"answers": result.get("answers", {}), "model": self.model_repo}


def expired(request: Dict[str, Any], now_ms: Optional[float] = None) -> bool:
    """Whether the caller has already given up on this request."""
    deadline = request.get("deadline_ms")
    if not isinstance(deadline, (int, float)) or isinstance(deadline, bool):
        return False
    now = time.time() * 1000 if now_ms is None else now_ms
    return now > deadline


def handle(engine: Engine, request: Dict[str, Any]) -> Dict[str, Any]:
    """Dispatch one request and build a response envelope."""
    request_id = request.get("id")
    method = request.get("method")

    if expired(request):
        return {"id": request_id, "ok": False, "error": "deadline passed before processing"}

    try:
        if method == "health":
            return {"id": request_id, "ok": True, "result": engine.health()}

        if method == "decide":
            result = engine.decide(
                text=request.get("text"),
                state=request.get("state"),
                questions=request.get("questions"),
            )
            return {"id": request_id, "ok": True, "result": result}

        return {"id": request_id, "ok": False, "error": f"Unknown method: {method}"}
    except Exception as exc:  # noqa: BLE001 - report any failure to the caller
        log(traceback.format_exc())
        return {"id": request_id, "ok": False, "error": str(exc)}


def main() -> int:
    claim_stdout()
    engine = Engine()
    try:
        engine.load()
    except Exception as exc:  # noqa: BLE001
        log(traceback.format_exc())
        emit({"type": "fatal", "error": str(exc)})
        return 1

    emit({"type": "ready", "model": engine.model_repo, "backend": "laya-mlx"})

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({"id": None, "ok": False, "error": f"Invalid JSON: {exc}"})
            continue
        if not isinstance(request, dict):
            emit({"id": None, "ok": False, "error": "Request must be a JSON object"})
            continue

        if request.get("method") == "shutdown":
            emit({"id": request.get("id"), "ok": True, "result": {"bye": True}})
            return 0

        emit(handle(engine, request))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
