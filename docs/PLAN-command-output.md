# Plan (pignon): command output that is not truncated and does not persist

Status: implemented · 2026-09-23 (see *Changes from the proposal*)

## Problem

`/pignon doctor` (and `config`, `log`, `stats`) render through `ctx.ui.setWidget(key, string[])`.
Two consequences, both bad UX:

1. **Truncated.** Pi keeps only the first 10 lines of a string-array widget and appends
   `... (widget truncated)`. Doctor emits ~15–25 lines, so the model checks — the part the
   user ran the command for — are silently dropped.
2. **Persists.** A widget is a persistent slot: it stays above the editor through every
   following prompt until `setWidget(key, undefined)`, i.e. until `/pignon doctor clear`.

## Why it happens (verified in the Pi source)

`@earendil-works/pi-coding-agent` 0.87.1, `InteractiveMode` in
`dist/bundle/chunks/chunk-OJP47DM6.js`:

```js
if (Array.isArray(content)) {
  let container = new Container;
  for (let line of content.slice(0, _InteractiveMode.MAX_WIDGET_LINES))
    container.addChild(new Text(line, 1, 0));
  content.length > _InteractiveMode.MAX_WIDGET_LINES &&
    container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
  component = container;
} else component = content(this.ui, theme);   // factory overload: no cap
```

with `static MAX_WIDGET_LINES = 10`.

The cap applies **only** to the `string[]` overload. The component-factory overload is
uncapped — `src/ui.ts` already relies on that for the `pignon-deciding` spinner.

Corroborated by a third-party extension (`itayinbarr/little-coder`,
`.pi/extensions/extensions-info/manifest.ts`):

> pi slices a string-array widget to MAX_WIDGET_LINES (10) and appends
> "... (widget truncated)", so anything past that is silently lost.

Persistence is by design, not a bug: `docs/tui.md` lists `ctx.ui.setWidget()` under
*"Persistent content near the editor"*. The fix is therefore to stop using a widget for
one-shot reports, not to tune the widget.

## What each command emits today

| command | lines | vs the 10-line cap |
| --- | --- | --- |
| `doctor` | ~15–25: header, `config` + 1–2, `deciders` + 1–3, `models` + up to 8 | truncated |
| `log` | 30 (`LOG_WIDGET_LINES`) | truncated to 10 — worst case |
| `stats` | ~12+: header, bucket header, 3 tiers × 2 forms, summary | truncated |
| `config` | ~8: header, column header, N tiers, footer, hint | ok at 3 tiers, truncates at 4+ |

## Decision

Render one-shot reports in a **dismissible overlay** (`ctx.ui.custom({ overlay: true })`)
that scrolls itself: no line cap, scrollable, disposed on close so nothing persists.
Fallback to `notify` in RPC mode and to stderr in print/JSON mode.

Apply it to **all four** commands through one shared helper.

## Design

### `src/report.ts` (new)

```ts
export async function showReport(
  ctx: ExtensionContext,
  title: string,
  lines: string[] | Promise<string[]>,
): Promise<void>
```

Three tiers, following `docs/extensions.md` (*"Guard terminal-only behavior with
`ctx.mode === "tui"` and use `ctx.hasUI` for interactions supported by interactive and RPC
clients"*):

| mode | behaviour |
| --- | --- |
| `ctx.mode === "tui"` | `ctx.ui.custom(..., { overlay: true })` — `ReportOverlay` below |
| RPC (`ctx.hasUI`, not tui) | `ctx.ui.notify(lines.join("\n"), "info")` — RPC forwards `notify`, not custom components |
| print / JSON (`!ctx.hasUI`) | `process.stderr.write(lines.join("\n") + "\n")` — stdout stays parseable in JSON mode |

The `Promise<string[]>` overload matters for `doctor`, which can block ~15 s on the decider
probe: open the overlay immediately with `running checks…`, then `setLines()` →
`invalidate()` + `tui.requestRender()` when it resolves. The editor is never left looking
frozen.

### `ReportOverlay`

A `Component` (`render(width)` / `handleInput(data)` / `invalidate()` / `dispose()`):

- Keeps its own line offset and renders only the visible slice, framed by a
  rounded border: title in the top rule; hint and `a–b/n` position in the bottom rule
- Body height: 70% of `tui.terminal.rows` (read on each render) minus the 2 border rows
- Overlay options: `{ width: <widest line + frame>, minWidth: 40, anchor: "center", margin: 1 }`;
  `90%` while doctor's lines are still pending (Pi resolves overlay options once, at open)
- Keys: ↑↓ / `j` `k` (line), PgUp / PgDn / space (page), Home / End / `g` `G`,
  `Esc` / `q` / `Enter` → `done()`
- Every line passes through `truncateToWidth(…, pad)` — see Risks

## Files

| file | change |
| --- | --- |
| `src/report.ts` | **new** — `showReport()` + `ReportOverlay` |
| `src/extension.ts` | replace the 4 report `showWidget(...)` calls with `showReport(...)`; drop the `"(/pignon X clear to hide)"` trailers; raise `LOG_WIDGET_LINES` 30 → 200 (the overlay scrolls) |
| `src/config/describe.ts` | drop its internal `"(/pignon config clear to hide)"` line |
| `src/ui.ts` | unchanged — `showDeciding` is *meant* to persist, and already uses the uncapped factory overload |
| `src/onboarding.ts` | unchanged — already returns plain `string[]` |
| `tests/extension.test.ts`, `tests/extension-routing.test.ts` | add `custom` and `mode` to the mocks; update the `ctx.ui.setWidget` assertions |
| `tests/report.test.ts` | **new** — overlay line rendering and key handling (pure, no terminal) |
| `tests/helpers/fake-report.ts` | **new** — a `ctx.ui.custom` fake that keeps the overlay for assertions |
| `src/stats.ts`, `src/compare.ts` | drop their `"(/pignon-stats clear to hide)"` lines |
| `README.md`, `CHANGELOG.md` | the four commands no longer need `clear`; keep the subcommands as no-ops for back-compat |

## Steps

1. Write `src/report.ts`: `ReportOverlay` (Box + ScrollView + Text) and `showReport()`.
2. Rewire `doctor`, `config`, `log`, `stats` in `src/extension.ts`; remove the "clear to
   hide" trailers.
3. Extend the test mocks with `custom` and `mode`, then update and add tests.
4. Update README and CHANGELOG.

## Risks

- **Width overflow.** pi-tui throws on over-wide lines (reported upstream as issue #48 by
  `little-coder`). `truncateToWidth()` on every line is load-bearing, not cosmetic.
- **Modal.** `doctor` now needs `Esc` before the user can type again. Accepted: it is a
  diagnostic, and it is the cost of nothing persisting.
- **Key collision.** `matchesKey(data, "q")` is safe here only because the overlay has no
  text input. Any future search/filter field inside it must handle `q` as text first.
- **Back-compat.** `doctor clear` / `config clear` / `stats clear` / `log clear` stay
  accepted and keep clearing the (now unused) widget key so a stale widget from an older
  session cannot linger.

## Changes from the proposal

- **No `ScrollView`.** Pi composites overlays in `TUI.compositeOverlays()`
  (`pi-tui/dist/tui.js`): it calls `component.render(width)` and slices the result to
  `maxHeight`. The `[LAYOUT_NODE]` / `updateLayout` path runs only in
  `renderLayoutFrame()` for the alt-screen root, never for overlays, and
  `ScrollView.render()` returns all of its child's lines. A `ScrollView` in an overlay
  would therefore never scroll, and `maxHeight: "70%"` would truncate it silently: the
  same bug with a border around it. `ReportOverlay` scrolls itself instead.
- **Overlay options go under `overlayOptions`**, not at the top level of the `custom()`
  options.
- **Width fits the content** instead of a fixed 80%, which truncated the config table's
  last column at 100 columns.
- **Five call sites, not four**: `/pignon-stats compare` also used the widget. `stats.ts`
  and `compare.ts` had their own "clear to hide" lines too.
- **Titles move into the border.** Each report's first line (`pignon doctor`,
  `pignon config · <source>`, …) becomes the overlay title. The producers are unchanged,
  so RPC and stderr output still start with it.
- `clear` subcommands are no longer offered in completion, but are still accepted.
- A rejected `lines` promise shows `✗ <message>` in the overlay instead of leaving
  `running checks…` forever.
- Verified in Pi 0.87.1 through a pty: config and doctor render whole, doctor scrolls on a
  14-row terminal, and Esc leaves nothing above the editor.
