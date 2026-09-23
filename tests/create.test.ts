import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { UnavailableDecider, createDecider } from "../src/deciders/create.js";
import { JevDecider } from "../src/deciders/jev.js";
import { LayaWorker, layaRuntimeStatus } from "../src/deciders/laya-local.js";
import { StrategyDecider } from "../src/deciders/strategy.js";

const layaOk = () => ({ ok: true as const });
const layaMissing = () => ({ ok: false as const, reason: "the Laya worker is not installed" });

describe("createDecider without a deciders section", () => {
  it("uses the local Laya worker when it can run", () => {
    const { decider, notes } = createDecider(DEFAULT_CONFIG, { env: { TYPESAFE_API_KEY: "k" }, layaStatus: layaOk });
    expect(decider).toBeInstanceOf(LayaWorker);
    expect(notes).toEqual([]);
  });

  it("falls back to Jev when Laya cannot run and a key is set", () => {
    const { decider } = createDecider(DEFAULT_CONFIG, { env: { TYPESAFE_API_KEY: "k" }, layaStatus: layaMissing });
    expect(decider).toBeInstanceOf(JevDecider);
  });

  it("says what to install when neither can run", async () => {
    const { decider } = createDecider(DEFAULT_CONFIG, { env: {}, layaStatus: layaMissing });

    expect(decider).toBeInstanceOf(UnavailableDecider);
    expect(decider.isReady).toBe(false);
    await expect(decider.warmup()).rejects.toThrow(
      "no decider available: the Laya worker is not installed, and TYPESAFE_API_KEY is not set for Jev",
    );
  });
});

describe("createDecider with a deciders section", () => {
  it("builds the listed decider with its settings", () => {
    const config = { ...DEFAULT_CONFIG, deciders: [{ type: "jev" as const, model: "jev-1.13.0" }] };

    const { decider } = createDecider(config, { env: {}, layaStatus: layaOk });

    expect(decider).toBeInstanceOf(JevDecider);
    expect(decider.model).toBe("jev-1.13.0");
  });

  it("combines several deciders with the configured strategy", () => {
    const config = {
      ...DEFAULT_CONFIG,
      deciders: [{ type: "laya-local" as const }, { type: "jev" as const }],
      strategy: { ...DEFAULT_CONFIG.strategy, mode: "parallel" as const },
    };

    const { decider, notes } = createDecider(config, { env: {}, layaStatus: layaOk });

    expect(decider).toBeInstanceOf(StrategyDecider);
    expect(decider.id).toBe("parallel(laya-local,jev)");
    expect(notes).toEqual([]);
  });
});

describe("layaRuntimeStatus", () => {
  it("needs an Apple Silicon Mac", () => {
    expect(layaRuntimeStatus({ LAYA_PYTHON: "/usr/bin/python3" }, "linux", "x64")).toEqual({
      ok: false,
      reason: "the local Laya model needs an Apple Silicon Mac",
    });
  });

  it("reports how the worker will be started", () => {
    const status = layaRuntimeStatus({ LAYA_PYTHON: "/usr/bin/python3" }, "darwin", "arm64");
    expect(status).toMatchObject({ ok: true, launch: { command: "/usr/bin/python3", source: "env" } });
  });

  it("says how to install the worker when nothing can start it", () => {
    const dir = mkdtempSync(join(tmpdir(), "pignon-worker-"));
    try {
      const status = layaRuntimeStatus({ LAYA_WORKER_DIR: dir, PATH: dir }, "darwin", "arm64");
      expect(status).toEqual({
        ok: false,
        reason: "the Laya worker is not installed (install uv from https://docs.astral.sh/uv/, or run `uv tool install pignon-laya`)",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
