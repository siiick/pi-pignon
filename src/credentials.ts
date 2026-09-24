/**
 * API keys stored by `/pignon login`, for users who would rather not export an
 * environment variable.
 *
 * They live in their own file, `<agent dir>/pignon/credentials.json`, never in
 * pignon.json (which people share) nor in Pi's auth.json (which Pi writes
 * under a lock pignon cannot take). The file is created 0600 in a 0700
 * directory, and refused, like ssh does, when group or others can read it.
 *
 * A stored key is either the key itself or, like in Pi's auth.json, a command
 * prefixed with `!` whose output is the key (`!security find-generic-password
 * -ws typesafe`): with a password manager, the key never touches the disk.
 *
 *   { "typesafe": { "key": "sk-..." } }
 */

import { exec } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { agentDir } from "./config/load.js";

/** Name of the TypeSafe (Jev) key in the credentials file. */
export const TYPESAFE_CREDENTIAL = "typesafe";

/** A key command gets this long, e.g. to wait for a Keychain or 1Password prompt. */
const COMMAND_TIMEOUT_MS = 30_000;

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "pignon", "credentials.json");
}

export type StoredKey =
  | { kind: "missing" }
  | { kind: "error"; error: string }
  /** `value` is the key, or a command (starting with `!`) that prints it. */
  | { kind: "ok"; value: string };

/** Read one stored key without resolving it. */
export function readStoredKey(name: string, path: string = credentialsPath()): StoredKey {
  let text: string;
  try {
    const mode = statSync(path).mode;
    if (process.platform !== "win32" && (mode & 0o077) !== 0) {
      return { kind: "error", error: `${path} can be read by other users; run chmod 600 on it` };
    }
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "error", error: `cannot read ${path}: ${(err as Error).message}` };
  }
  let entry: unknown;
  try {
    entry = (JSON.parse(text) as Record<string, unknown>)[name];
  } catch {
    return { kind: "error", error: `${path} is not valid JSON` };
  }
  if (entry === undefined) return { kind: "missing" };
  const value = (entry as { key?: unknown } | null)?.key;
  if (typeof value !== "string" || !value.trim()) return { kind: "error", error: `${path}: ${name}.key must be a non-empty string` };
  return { kind: "ok", value: value.trim() };
}

/** Store (or, with `undefined`, remove) one key, leaving the others. */
export function writeStoredKey(name: string, value: string | undefined, path: string = credentialsPath()): void {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (value === undefined) delete data[name];
  else data[name] = { key: value };

  if (Object.keys(data).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Written aside then renamed: a crash never leaves a half-written file.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** The key a stored value stands for: the value itself, or what its `!command` prints. */
export async function resolveStoredKey(value: string): Promise<string> {
  if (!value.startsWith("!")) return value;
  const command = value.slice(1).trim();
  const output = await new Promise<string>((resolve, reject) => {
    exec(command, { timeout: COMMAND_TIMEOUT_MS, encoding: "utf8" }, (err, stdout) => {
      // The command's stderr is not quoted: it could echo the key.
      if (err) reject(new Error(`key command failed (${err.killed ? "timed out" : `exit ${err.code ?? "?"}`})`));
      else resolve(stdout);
    });
  });
  const key = output.trim();
  if (!key) throw new Error("key command printed nothing");
  return key;
}
