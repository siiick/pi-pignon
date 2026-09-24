# pignon-laya (experimental)

An experimental local decision worker for [pignon](https://github.com/siiick/pi-pignon),
the model router for the [Pi coding agent](https://pi.dev). It loads the
[Laya](https://github.com/mizorewww/laya-mlx) System-1 decision model once
(with MLX, on Apple Silicon) and answers pignon's questions about each prompt,
without sending the prompt anywhere.

**It is not published**, and its protocol may change. The supported way to run
Laya locally is the official `laya-serve` (`uv tool install "laya[serve]"`);
see pignon's README. This worker is a little faster on Apple Silicon (~61 ms
against ~75 ms per decision, same answers) and needs no server.

Install it from a clone; pignon then finds `pignon-laya` on `PATH` and starts
it with each session (config: `"deciders": [{ "type": "laya-local" }]`):

```bash
git clone https://github.com/siiick/pi-pignon
uv tool install ./pi-pignon/worker        # update: uv tool install --force ./pi-pignon/worker
```

Requirements: an Apple Silicon Mac, Python 3.11+. The first start downloads
the model from Hugging Face (about 850 MB).

## Protocol

One JSON object per line on stdin and stdout; diagnostics go to stderr. The
worker keeps a private copy of stdout for the protocol and redirects file
descriptor 1 to stderr, so output from libraries (`print`, progress bars,
native code) can never corrupt the stream.

```
-> {"id": 1, "method": "health", "deadline_ms": 1767225600000}
-> {"id": 2, "method": "decide", "text": "...", "questions": {...}, "deadline_ms": ...}
-> {"id": 3, "method": "shutdown"}

<- {"type": "ready", "model": "aac6fef/laya-mlx", "backend": "laya-mlx", "protocol": "0.3.0"}
<- {"type": "fatal", "error": "..."}
<- {"id": 1, "ok": true, "result": {...}}
<- {"id": 1, "ok": false, "error": "..."}
```

`deadline_ms` (optional, Unix epoch milliseconds) is when the caller stops
waiting: a request still queued after it is answered with
`"deadline passed before processing"` instead of being run. `protocol` in the
`ready` line lets pignon refuse a worker it cannot talk to.

Smoke test:

```bash
printf '%s\n' \
  '{"id":1,"method":"health"}' \
  '{"id":2,"method":"decide","text":"debug a race condition","questions":{"reasoning_demand":{"type":"choice","instructions":"How hard?","criteria":{"trivial":"mechanical","standard":"localized","hard":"cross-cutting"}}}}' \
  | pignon-laya
```

## Configuration

| Env var | Default | Description |
|---|---|---|
| `LAYA_MODEL` | `aac6fef/laya-mlx` | Hugging Face checkpoint to load (fixed for the life of the worker) |
| `LAYA_MODEL_REVISION` | pinned commit for the default model, latest for others | Revision to load; empty string means latest |
| `LAYA_DTYPE` | `float16` | `float16` or `float32` |
| `LAYA_DEVICE` | *(auto)* | `gpu`, `cpu`, or empty for the library default |
| `LAYA_BATCH_SIZE` | `16` | Questions per forward pass |

## Development

```bash
uv sync
.venv/bin/python -m unittest -v    # standard library only; no checkpoint needed
uv build                           # dist/pignon_laya-*.whl and .tar.gz
```

MIT licensed.
