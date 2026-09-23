import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { ReportOverlay, reportWidth, showReport } from "../src/report.js";
import { fakeCustom, plainTheme } from "./helpers/fake-report.js";

const KEYS = { up: "\x1b[A", down: "\x1b[B", pageDown: "\x1b[6~", home: "\x1b[H", end: "\x1b[F", escape: "\x1b" };

function overlay(lines: string[], rows = 20) {
  const close = vi.fn();
  const requestRender = vi.fn();
  const report = new ReportOverlay("pignon doctor", lines, plainTheme, () => rows, requestRender, close);
  return { report, close, requestRender };
}

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);
/** Body rows of a render, without borders and padding. */
const body = (rendered: string[]) => rendered.slice(1, -1).map((l) => l.slice(2, -2).trimEnd());

describe("ReportOverlay", () => {
  it("shows every line of a short report, framed, with the title", () => {
    const { report } = overlay(numbered(12));
    const rendered = report.render(60);

    expect(rendered[0]).toContain("pignon doctor");
    expect(body(rendered)).toEqual(numbered(12)); // more than the 10 a widget keeps
    expect(rendered.at(-1)).toContain("Esc close");
    expect(rendered.at(-1)).not.toContain("scroll");
  });

  it("fits 70% of the terminal and scrolls through the rest", () => {
    const { report, requestRender } = overlay(numbered(50), 20); // 14 rows: 12 body + 2 borders
    let rendered = report.render(60);

    expect(rendered).toHaveLength(14);
    expect(body(rendered)[0]).toBe("line 0");
    expect(rendered.at(-1)).toContain("1–12/50");

    report.handleInput(KEYS.down);
    expect(requestRender).toHaveBeenCalled();
    expect(body(report.render(60))[0]).toBe("line 1");

    report.handleInput(KEYS.pageDown);
    expect(body(report.render(60))[0]).toBe("line 12");

    report.handleInput(KEYS.end);
    rendered = report.render(60);
    expect(body(rendered).at(-1)).toBe("line 49");
    expect(rendered.at(-1)).toContain("39–50/50");

    report.handleInput(KEYS.down); // already at the end
    expect(body(report.render(60)).at(-1)).toBe("line 49");

    report.handleInput(KEYS.home);
    expect(body(report.render(60))[0]).toBe("line 0");
    report.handleInput(KEYS.up); // already at the top
    expect(body(report.render(60))[0]).toBe("line 0");
  });

  it("never renders a line wider than it was given", () => {
    const { report } = overlay(["x".repeat(500), "short"]);
    for (const width of [20, 60, 120]) {
      for (const line of report.render(width)) expect(visibleWidth(line)).toBe(width);
    }
  });

  it("closes on Esc, q and Enter", () => {
    for (const key of [KEYS.escape, "q", "\r"]) {
      const { report, close } = overlay(numbered(3));
      report.handleInput(key);
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it("starts from the top when its lines are replaced", () => {
    const { report } = overlay(numbered(50));
    report.render(60);
    report.handleInput(KEYS.end);
    report.setLines(["done"]);
    expect(body(report.render(60))).toEqual(["done"]);
  });
});

describe("showReport", () => {
  afterEach(() => vi.restoreAllMocks());

  const context = (mode: string, hasUI: boolean) => {
    const { custom, reports } = fakeCustom();
    const ctx = { mode, hasUI, ui: { custom, notify: vi.fn() } };
    return { ctx, reports, run: (lines: string[] | Promise<string[]>) => showReport(ctx as unknown as ExtensionContext, "pignon config", lines) };
  };

  it("opens an overlay in the TUI", async () => {
    const { ctx, reports, run } = context("tui", true);
    await run(["a", "b"]);
    expect(ctx.ui.custom).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ overlay: true }));
    expect(reports[0]!.lines).toEqual(["a", "b"]);
  });

  it("notifies RPC clients, which do not get custom components", async () => {
    const { ctx, run } = context("rpc", true);
    await run(Promise.resolve(["a", "b"]));
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("pignon config\na\nb", "info");
  });

  it("writes to stderr without a UI, keeping stdout clean", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write");
    const { ctx, run } = context("json", false);
    await run(["a"]);
    expect(stderr).toHaveBeenCalledWith("pignon config\na\n");
    expect(stdout).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("reports a failed computation instead of hanging on it", async () => {
    const { reports, run } = context("tui", true);
    await run(Promise.reject(new Error("probe crashed")));
    await vi.waitFor(() => expect(reports[0]!.lines).toEqual(["  ✗ probe crashed"]));
  });
});

describe("reportWidth", () => {
  it("fits the widest line, or the title, plus the frame", () => {
    expect(reportWidth("t", ["abc", "abcdefghij"])).toBe(14);
    expect(reportWidth("a long report title", ["x"])).toBe(19 + 6 + 4);
  });
});
