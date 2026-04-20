#!/usr/bin/env node
/**
 * Claude Code Stop hook — logs session token usage to the RAG Lab backend.
 * Registered in ~/.claude/settings.json under hooks.Stop.
 * Receives a JSON event on stdin with transcript_path and session_id.
 */

const fs = require('fs');
const http = require('http');

const BACKEND_PORT = 8002;

// Pricing per 1M tokens (USD) for Anthropic models
const PRICING = {
  'claude-opus-4-7':            { input: 15.0,  output: 75.0,  cache_read: 1.50 },
  'claude-sonnet-4-6':          { input: 3.0,   output: 15.0,  cache_read: 0.30 },
  'claude-haiku-4-5':           { input: 0.80,  output: 4.0,   cache_read: 0.08 },
  'claude-3-5-sonnet-20241022': { input: 3.0,   output: 15.0,  cache_read: 0.30 },
  'claude-3-5-haiku-20241022':  { input: 0.80,  output: 4.0,   cache_read: 0.08 },
  'claude-3-opus-20240229':     { input: 15.0,  output: 75.0,  cache_read: 1.50 },
};
const DEFAULT_PRICING = { input: 3.0, output: 15.0, cache_read: 0.30 };

function getPricing(model) {
  if (!model) return DEFAULT_PRICING;
  // Exact match
  if (PRICING[model]) return PRICING[model];
  // Partial match (e.g. "claude-sonnet-4-6-20250514" → "claude-sonnet-4-6")
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key];
  }
  return DEFAULT_PRICING;
}

function calcCost(inputTokens, outputTokens, cacheReadTokens, model) {
  const p = getPricing(model);
  return (
    (inputTokens    / 1_000_000) * p.input +
    (outputTokens   / 1_000_000) * p.output +
    (cacheReadTokens / 1_000_000) * p.cache_read
  );
}

function parseTokens(transcriptPath) {
  if (!fs.existsSync(transcriptPath)) return null;
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, model = '';
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      const u = d.usage || (d.message && d.message.usage) || {};
      inputTokens    += (u.input_tokens               || 0);
      outputTokens   += (u.output_tokens              || 0);
      cacheReadTokens += (u.cache_read_input_tokens   || 0);
      if (!model) model = d.model || (d.message && d.message.model) || '';
    } catch (_) {}
  }
  return { inputTokens, outputTokens, cacheReadTokens, model };
}

function postToBackend(payload) {
  const body = JSON.stringify(payload);
  const req = http.request(
    {
      hostname: 'localhost',
      port: BACKEND_PORT,
      path: '/api/analytics/system-costs',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (res) => {
      res.resume(); // drain
      process.exit(0);
    }
  );
  req.on('error', () => process.exit(0)); // backend not running — silent fail
  req.write(body);
  req.end();
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(stdin); } catch (_) {}

  const transcriptPath = event.transcript_path;
  if (!transcriptPath) { process.exit(0); return; }

  const tokens = parseTokens(transcriptPath);
  if (!tokens || (!tokens.inputTokens && !tokens.outputTokens)) { process.exit(0); return; }

  const { inputTokens, outputTokens, cacheReadTokens, model } = tokens;
  const costUsd = calcCost(inputTokens, outputTokens, cacheReadTokens, model);

  const sessionId = (event.session_id || transcriptPath.split(/[\\/]/).pop().replace('.jsonl', '')).slice(0, 8);
  const today = new Date().toISOString().slice(0, 10);

  postToBackend({
    date: today,
    description: `Claude Code session ${sessionId}`,
    model: model || 'claude-sonnet-4-6',
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
  });
});
