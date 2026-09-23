# Laya stdio worker

A single long-lived Python process that loads the laya-mlx model once and
answers newline-delimited JSON requests on stdin/stdout, one at a time. No
port, no HTTP server, no separate service to keep alive — the Pi extension
spawns and owns it.

## Setup

```bash
cd worker
uv sync
```

This creates `worker/.venv`, which the extension uses by default.

## Manual smoke test

```bash
printf '%s\n' \
  '{"id":1,"method":"health"}' \
  '{"id":2,"method":"decide","text":"debug a race condition","questions":{"reasoning_demand":{"type":"choice","instructions":"How hard?","criteria":{"trivial":"mechanical","standard":"localized","hard":"cross-cutting"}}}}' \
  | .venv/bin/python laya_worker.py
```

The first line printed is `{"type":"ready",...}`; subsequent lines answer the
requests by `id`. Diagnostics go to stderr. The full protocol is documented at
the top of `laya_worker.py`.

Requests may carry `deadline_ms` (Unix epoch milliseconds, the time the caller
stops waiting). A request still queued after its deadline is answered with
`"deadline passed before processing"` instead of being run, so a backlog of
requests the extension already gave up on drains immediately.

The model is chosen once at startup (`LAYA_MODEL`); requests cannot switch it.

On startup the worker keeps a private copy of stdout for protocol messages and
redirects file descriptor 1 to stderr, so output from libraries (`print`,
progress bars, native code) can never corrupt the protocol stream.

## Tests

```bash
.venv/bin/python -m unittest -v
```

Standard library only; the end-to-end test runs `main()` in a subprocess with
a fake model, so no checkpoint is needed.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `LAYA_MODEL` | `aac6fef/laya-mlx` | Hugging Face checkpoint to load |
| `LAYA_MODEL_REVISION` | pinned commit for the default model, latest for others | Revision to load; empty string means latest |
| `LAYA_DTYPE` | `float16` | `float16` or `float32` |
| `LAYA_DEVICE` | *(auto)* | `gpu`, `cpu`, or empty for library default |
| `LAYA_BATCH_SIZE` | `16` | Questions per forward pass |