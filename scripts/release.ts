// Prepares the files for a release, after `npm version --no-git-tag-version`
// has bumped package.json: turns the changelog's "Unreleased" section into
// the new version's section, and updates the pinned version in the README.
//
//   node scripts/release.ts <notes-file>
//
// Writes the release notes (the new section's body) to <notes-file> for the
// GitHub release. Fails when "Unreleased" is empty: every release says what
// changed.
//
//   node scripts/release.ts --notes-only <notes-file>
//
// Changes nothing and writes the notes of the version already in
// package.json, to retry a release whose publishing failed.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UNRELEASED = "## Unreleased";

/** Renames "Unreleased" to the version and opens a new, empty "Unreleased" above it. */
export function releaseChangelog(changelog: string, version: string, date: string): { changelog: string; notes: string } {
  const start = changelog.indexOf(`${UNRELEASED}\n`);
  if (start === -1) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" section`);
  const bodyStart = start + UNRELEASED.length + 1;
  const next = changelog.indexOf("\n## ", bodyStart);
  const bodyEnd = next === -1 ? changelog.length : next + 1;
  const notes = changelog.slice(bodyStart, bodyEnd).trim();
  if (!notes) throw new Error(`"${UNRELEASED}" in CHANGELOG.md is empty: say what changed before releasing`);
  if (changelog.includes(`\n## ${version} `)) throw new Error(`CHANGELOG.md already has a ${version} section`);
  const rest = changelog.slice(bodyEnd);
  const released = `${changelog.slice(0, start)}${UNRELEASED}\n\n## ${version} — ${date}\n\n${notes}\n${rest && "\n"}${rest}`;
  return { changelog: released, notes };
}

/** The body of an existing version's section. */
export function changelogSection(changelog: string, version: string): string {
  const heading = `\n## ${version} `;
  const start = changelog.indexOf(heading);
  if (start === -1) throw new Error(`CHANGELOG.md has no ${version} section`);
  const bodyStart = changelog.indexOf("\n", start + heading.length) + 1;
  const next = changelog.indexOf("\n## ", bodyStart);
  return changelog.slice(bodyStart, next === -1 ? changelog.length : next).trim();
}

/** Points `npm:pi-pignon@<version>` examples at the new version. */
export function releaseReadme(readme: string, version: string): string {
  return readme.replace(/npm:pi-pignon@\d+\.\d+\.\d+/g, `npm:pi-pignon@${version}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const notesOnly = process.argv[2] === "--notes-only";
  const notesFile = process.argv[notesOnly ? 3 : 2];
  if (!notesFile) throw new Error("usage: node scripts/release.ts [--notes-only] <notes-file>");
  const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  if (notesOnly) {
    writeFileSync(notesFile, `${changelogSection(readFileSync("CHANGELOG.md", "utf8"), version)}\n`);
    process.exit(0);
  }
  const date = new Date().toISOString().slice(0, 10);
  const { changelog, notes } = releaseChangelog(readFileSync("CHANGELOG.md", "utf8"), version, date);
  writeFileSync("CHANGELOG.md", changelog);
  writeFileSync("README.md", releaseReadme(readFileSync("README.md", "utf8"), version));
  writeFileSync(notesFile, `${notes}\n`);
  console.log(`Prepared ${version} (${date})`);
}
