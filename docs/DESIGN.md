# Design notes

## Privacy

With `laya-serve` on this machine (`127.0.0.1` or `localhost`) or `laya-local`, prompts never leave it. With `jev`, or a laya-serve on another host, the first 4 000 characters of each routed prompt are sent over the network, and decision cards are marked ☁. The SDK's own logging is capped at `warn` and kept in `/pignon log`, so prompts are never logged, even with `TYPESAFE_LOG_LEVEL=debug`.

## Fail-open

If a decider cannot be reached or a decision fails, the decision is `null` and the extension keeps the current model. A laya-serve that is down refuses the connection at once, so the prompt waits a few milliseconds, not a timeout. The experimental worker loads its model in the background from `session_start`; prompts sent before it is ready are not routed (status shows `model loading — prompt not routed`) rather than held. It stays warm for the session, is reloaded in the background if it crashes, and is stopped on `session_shutdown`. A worker that is not ready within 5 minutes is killed.

## Switch cost

Switching models throws away the prompt cache: the first request on the new model reads the whole context at the uncached (or cache-write) price. Upgrades are quality-driven and only gated by confidence. A downgrade, or a move in from a model outside the table, must pay that premium back within `maxPaybackRequests` LLM requests out of what it saves per request (cheaper cache reads on the context plus cheaper output). Prices come from Pi's model registry; when either model has no price, the flat `cacheGuardTokens` limit applies instead. Lateral switches (direct ↔ exploration) are about fit rather than price and use the flat limit.

## Hysteresis

After the router switches, it waits `minPromptsBetweenSwitches` prompts before the next downgrade or lateral switch, so it does not flap between models. Upgrades are never delayed.

## Manual pin

If the user explicitly selects a model via `/model` or `Ctrl+P`, the extension steps back (`manualPin`) until `/pignon unpin`. The router's own switches also emit `model_select` (`source: "set"`) and are ignored.

## Unrouted models

If the current model is not in the routing table (matched on provider and model id), the router switches into the table only when tier confidence meets the downgrade threshold and the switch-cost check passes.

## Shared models

Cells mapped to the same provider, model and thinking level count as one; the router never re-selects the model already in use.

## Worker isolation

The worker gets an allowlisted environment (`PATH`, `HOME`, locale, proxies, CA bundles, `LAYA_*`, `HF_*`, `HUGGINGFACE_*`, `MLX_*`), not Pi's full environment with provider API keys. Its stderr is kept in memory (last 200 lines, see `/pignon log`) instead of being written over the TUI.

## Pinned model

The default checkpoint is pinned to the Hugging Face commit the router was calibrated on, so changes pushed to the Hub repo do not silently change routing. Bump `PINNED_REVISION` in `worker/laya_worker.py` deliberately, after re-checking decisions in shadow mode.

## Prompt privacy

Session log entries (`pignon-decision`) record a 16-hex-digit SHA-256 prefix and the length of each prompt, never its text.

## Bounded worker load

Only the first 4 000 characters of a prompt are sent (Laya reads about 320 tokens from the start anyway). Each request carries a deadline; the worker skips requests that expired while queued, so slow requests cannot pile up behind each other.

## Shadow mode default

New installs run in shadow mode so you can calibrate confidence thresholds on your own prompts before going live.
