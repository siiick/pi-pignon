/**
 * A fake `ctx.ui.custom` for report overlays: it builds the component the way
 * Pi would and keeps it, so tests read what the user would see.
 */

import { vi } from "vitest";

import type { ReportOverlay } from "../../src/report.js";

/** Plain theme: no ANSI codes, so assertions read the visible text. */
export const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

export function fakeCustom() {
  const reports: ReportOverlay[] = [];
  const custom = vi.fn(async (factory: (...args: unknown[]) => unknown) => {
    const tui = { terminal: { rows: 40 }, requestRender: vi.fn() };
    reports.push((await factory(tui, plainTheme, {}, () => {})) as ReportOverlay);
  });
  return { custom, reports };
}
