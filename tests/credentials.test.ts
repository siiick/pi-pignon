import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { credentialsPath, readStoredKey, resolveStoredKey, writeStoredKey } from "../src/credentials.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pignon-credentials-"));
  path = join(dir, "pignon", "credentials.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("credentials file", () => {
  it("lives in pignon's folder of Pi's agent directory", () => {
    expect(credentialsPath({ PI_CODING_AGENT_DIR: "/agent" })).toBe("/agent/pignon/credentials.json");
  });

  it("stores a key readable by the user only", () => {
    writeStoredKey("typesafe", "sk-1", path);

    expect(readStoredKey("typesafe", path)).toEqual({ kind: "ok", value: "sk-1" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ typesafe: { key: "sk-1" } });
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "pignon")).mode & 0o777).toBe(0o700);
    }
  });

  it("keeps other keys, and deletes the file with the last one", () => {
    writeStoredKey("typesafe", "sk-1", path);
    writeStoredKey("other", "k", path);
    writeStoredKey("typesafe", undefined, path);
    expect(readStoredKey("typesafe", path)).toEqual({ kind: "missing" });
    expect(readStoredKey("other", path)).toEqual({ kind: "ok", value: "k" });

    writeStoredKey("other", undefined, path);
    expect(existsSync(path)).toBe(false);
  });

  it("is missing when there is no file", () => {
    expect(readStoredKey("typesafe", path)).toEqual({ kind: "missing" });
  });

  it.skipIf(process.platform === "win32")("is refused when other users can read it", () => {
    writeStoredKey("typesafe", "sk-1", path);
    chmodSync(path, 0o644);
    expect(readStoredKey("typesafe", path)).toEqual({ kind: "error", error: `${path} can be read by other users; run chmod 600 on it` });
  });
});

describe("resolveStoredKey", () => {
  it("returns a plain key as is", async () => {
    expect(await resolveStoredKey("sk-1")).toBe("sk-1");
  });

  it("runs a ! command and trims its output", async () => {
    expect(await resolveStoredKey("!printf ' sk-cmd\\n'")).toBe("sk-cmd");
  });

  it("fails without quoting the command's stderr", async () => {
    const error = await resolveStoredKey("!echo secret >&2; exit 2").catch((err: Error) => err);
    expect((error as Error).message).toBe("key command failed (exit 2)");
  });

  it("fails when the command prints nothing", async () => {
    await expect(resolveStoredKey("!true")).rejects.toThrow("key command printed nothing");
  });
});
