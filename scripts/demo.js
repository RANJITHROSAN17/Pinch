#!/usr/bin/env node
/**
 * scripts/demo.js — boot Pinch with the mock brain.
 *
 * No model, no keys, no network: proves the panel, the tool loop and the
 * permission flow all work on any machine in ~2 seconds.
 *   npm run demo   →  http://localhost:7777
 */
process.env.LLM_PROVIDER = "mock";
process.env.PINCH_PORT = process.env.PINCH_PORT || "7777";
process.env.PINCH_KEY = ""; // demo only — never leave the panel open on a real LAN
process.env.PINCH_WORKSPACE = process.env.PINCH_WORKSPACE || process.cwd();

await import("../src/index.js");
