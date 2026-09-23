/**
 * One-shot reports (`/pignon doctor`, `config`, `log`, `/pignon-stats`).
 *
 * In the TUI a report opens in a dismissible overlay: no line cap (a
 * string-array widget keeps only 10 lines) and nothing left above the editor
 * once it is closed. RPC clients get a notification, print/JSON mode stderr.
 *
 * The overlay scrolls by itself: Pi composites overlays by calling
 * `render(width)` and slicing to `maxHeight`, so a pi-tui `ScrollView` inside
 * one never receives a viewport and would be cut off like the widget was.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** The subset of Pi's theme the overlay uses. */
export interface ReportTheme {
  fg(color: "accent" | "border" | "muted" | "dim", text: string): string;
  bold(text: string): string;
}

/** Share of the terminal height the overlay may use. */
const HEIGHT_SHARE = 0.7;
/** Top and bottom border rows. */
const CHROME_ROWS = 2;
/** Border and padding columns around each line. */
const CHROME_COLUMNS = 4;
/** Overlay width while the lines are still computing, when they cannot be measured yet. */
const PENDING_WIDTH = "90%";

export class ReportOverlay {
  private body: string[];
  private offset = 0;
  /** Body rows shown by the last render; paging moves by this much. */
  private visibleRows = 1;

  constructor(
    readonly title: string,
    lines: string[],
    private readonly theme: ReportTheme,
    /** Terminal height, read on every render so a resize is picked up. */
    private readonly terminalRows: () => number,
    private readonly requestRender: () => void,
    private readonly close: () => void,
  ) {
    this.body = lines;
  }

  get lines(): readonly string[] {
    return this.body;
  }

  setLines(lines: string[]): void {
    this.body = lines;
    this.offset = 0;
    this.requestRender();
  }

  handleInput(data: string): void {
    const page = Math.max(1, this.visibleRows - 1);
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, "q")) {
      this.close();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.scrollTo(this.offset - 1);
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.scrollTo(this.offset + 1);
    else if (matchesKey(data, Key.pageUp)) this.scrollTo(this.offset - page);
    else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) this.scrollTo(this.offset + page);
    else if (matchesKey(data, Key.home) || matchesKey(data, "g")) this.scrollTo(0);
    else if (matchesKey(data, Key.end) || matchesKey(data, "shift+g")) this.scrollTo(Number.MAX_SAFE_INTEGER);
  }

  render(width: number): string[] {
    const { theme } = this;
    const border = (s: string) => theme.fg("border", s);
    const inner = Math.max(1, width - CHROME_COLUMNS);

    const maxRows = Math.max(1, Math.floor(this.terminalRows() * HEIGHT_SHARE) - CHROME_ROWS);
    this.visibleRows = Math.min(this.body.length, maxRows);
    this.offset = this.clamp(this.offset);
    const shown = this.body.slice(this.offset, this.offset + this.visibleRows);

    const scrolls = this.body.length > this.visibleRows;
    const position = scrolls ? `${this.offset + 1}–${this.offset + shown.length}/${this.body.length}` : "";
    const hint = scrolls ? "↑↓ PgUp/PgDn scroll · Esc close" : "Esc close";

    return [
      this.rule("╭", "╮", this.title && theme.fg("accent", theme.bold(this.title)), "", width),
      ...shown.map((line) => `${border("│")} ${truncateToWidth(line, inner, "…", true)} ${border("│")}`),
      this.rule("╰", "╯", theme.fg("dim", hint), position && theme.fg("dim", position), width),
    ];
  }

  invalidate(): void {}

  /** `╭─ left ───── right ─╮`, with the labels dropped if they do not fit. */
  private rule(open: string, close: string, left: string, right: string, width: number): string {
    const border = (s: string) => this.theme.fg("border", s);
    const labelled = (s: string) => (s ? ` ${s} ` : "");
    let l = labelled(left);
    let r = labelled(right);
    if (visibleWidth(l) + visibleWidth(r) + CHROME_COLUMNS > width) r = "";
    if (visibleWidth(l) + CHROME_COLUMNS > width) l = "";
    const fill = Math.max(0, width - CHROME_COLUMNS - visibleWidth(l) - visibleWidth(r));
    return border(`${open}─`) + l + border("─".repeat(fill)) + r + border(`─${close}`);
  }

  private scrollTo(offset: number): void {
    const next = this.clamp(offset);
    if (next === this.offset) return;
    this.offset = next;
    this.requestRender();
  }

  private clamp(offset: number): number {
    return Math.max(0, Math.min(offset, this.body.length - this.visibleRows));
  }
}

/**
 * Columns that show the widest line (or the title) whole. Pi resolves overlay
 * options once, when the overlay opens, and clamps them to the terminal.
 */
export function reportWidth(title: string, lines: readonly string[]): number {
  return Math.max(visibleWidth(title) + 6, ...lines.map(visibleWidth)) + CHROME_COLUMNS;
}

/**
 * Show a report until the user closes it. `lines` may still be computing
 * (doctor probes the deciders): the overlay opens at once and fills in.
 */
export async function showReport(
  ctx: ExtensionContext,
  title: string,
  lines: string[] | Promise<string[]>,
): Promise<void> {
  const settled = Promise.resolve(lines).catch((err: unknown) => [
    `  ✗ ${err instanceof Error ? err.message : String(err)}`,
  ]);

  if (ctx.mode !== "tui") {
    const text = [title, ...(await settled)].join("\n");
    if (ctx.hasUI) ctx.ui.notify(text, "info"); // RPC: custom components are not forwarded
    else process.stderr.write(`${text}\n`); // keeps stdout parseable in JSON mode
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const overlay = new ReportOverlay(
        title,
        Array.isArray(lines) ? lines : ["  running checks…"],
        theme,
        () => tui.terminal.rows,
        () => tui.requestRender(),
        () => done(undefined),
      );
      if (!Array.isArray(lines)) void settled.then((result) => overlay.setLines(result));
      return overlay;
    },
    {
      overlay: true,
      overlayOptions: {
        width: Array.isArray(lines) ? reportWidth(title, lines) : PENDING_WIDTH,
        minWidth: 40,
        anchor: "center",
        margin: 1,
      },
    },
  );
}
