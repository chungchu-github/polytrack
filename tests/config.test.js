import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "..", "data", "config.json");

// Reload config module fresh for each describe (it caches internally)
async function freshConfig() {
  // Bust module cache via query-string import
  const mod = await import(`../src/config.js?t=${Date.now()}`);
  return mod;
}

describe("config — load/save", () => {
  before(() => {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  });
  after(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  });

  it("returns defaults when file missing", async () => {
    const { loadConfig } = await freshConfig();
    const cfg = loadConfig();
    assert.equal(cfg.maxTradeUsdc, 100);
    assert.equal(cfg.slippagePct, 2);
    assert.equal(cfg.webhookUrl, "");
  });

  it("persists a valid patch and reloads it", async () => {
    const { saveConfig, loadConfig } = await freshConfig();
    saveConfig({ maxTradeUsdc: 250, webhookUrl: "https://example.com/hook" });
    const cfg = loadConfig();
    assert.equal(cfg.maxTradeUsdc, 250);
    assert.equal(cfg.webhookUrl, "https://example.com/hook");
  });

  it("rejects unknown keys (allowlist)", async () => {
    const { saveConfig } = await freshConfig();
    const result = saveConfig({ evilKey: "pwn", __proto__: { bad: true } });
    assert.equal(result.evilKey, undefined);
  });

  it("rejects negative / non-finite numbers", async () => {
    const { saveConfig } = await freshConfig();
    const before = saveConfig({ maxTradeUsdc: 100 });
    const after  = saveConfig({ maxTradeUsdc: -50 });
    assert.equal(after.maxTradeUsdc, before.maxTradeUsdc);
    const after2 = saveConfig({ maxTradeUsdc: "not-a-number" });
    assert.equal(after2.maxTradeUsdc, before.maxTradeUsdc);
  });

  it("merges existing file with defaults on load", async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ slippagePct: 5 }));
    const { loadConfig } = await freshConfig();
    const cfg = loadConfig();
    assert.equal(cfg.slippagePct, 5);
    assert.equal(cfg.maxTradeUsdc, 100); // default kept
  });
});
