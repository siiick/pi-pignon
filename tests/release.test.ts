import { describe, expect, it } from "vitest";
import { releaseChangelog, releaseReadme } from "../scripts/release.js";

const CHANGELOG = `# Changelog

## Unreleased

- New thing.
- Other thing.

## 0.1.0 — 2026-09-23

- First release.
`;

describe("releaseChangelog", () => {
  it("turns Unreleased into the version's section and opens a new one", () => {
    const { changelog, notes } = releaseChangelog(CHANGELOG, "0.2.0", "2026-10-01");
    expect(notes).toBe("- New thing.\n- Other thing.");
    expect(changelog).toBe(`# Changelog

## Unreleased

## 0.2.0 — 2026-10-01

- New thing.
- Other thing.

## 0.1.0 — 2026-09-23

- First release.
`);
  });

  it("works when Unreleased is the only section", () => {
    const { changelog } = releaseChangelog("# Changelog\n\n## Unreleased\n\n- Thing.\n", "0.1.0", "2026-10-01");
    expect(changelog).toBe("# Changelog\n\n## Unreleased\n\n## 0.1.0 — 2026-10-01\n\n- Thing.\n");
  });

  it("refuses an empty Unreleased section", () => {
    expect(() => releaseChangelog("# Changelog\n\n## Unreleased\n\n## 0.1.0 — 2026-09-23\n\n- x\n", "0.2.0", "2026-10-01")).toThrow(
      /empty/,
    );
  });

  it("refuses a changelog without Unreleased", () => {
    expect(() => releaseChangelog("# Changelog\n\n## 0.1.0 — 2026-09-23\n", "0.2.0", "2026-10-01")).toThrow(/no "## Unreleased"/);
  });

  it("refuses a version that is already in the changelog", () => {
    expect(() => releaseChangelog(CHANGELOG, "0.1.0", "2026-10-01")).toThrow(/already has a 0.1.0/);
  });
});

describe("releaseReadme", () => {
  it("updates pinned npm versions", () => {
    expect(releaseReadme("To pin: `pi install npm:pi-pignon@0.1.1`. Or `npm:pi-pignon`.", "0.2.0")).toBe(
      "To pin: `pi install npm:pi-pignon@0.2.0`. Or `npm:pi-pignon`.",
    );
  });
});
