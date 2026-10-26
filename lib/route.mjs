#!/usr/bin/env node
// Self-selection router: given one shared board feeding several repos' Deputies, decide whether
// THIS repo's Deputy should work a ticket. Grounded in the repo itself — the model may read files
// here to confirm the paths/stack the ticket needs actually exist — so it is not guessing from
// ticket prose (which routinely links other repos for context). Conservative by design: "unsure"
// and "not mine" both skip, so a Deputy never grabs another repo's work.
//
//   node lib/route.mjs <repoFullName> <ticketId> <repoPath>
//   exit 0  = mine (sole owner)    → claim normally (removes the label)
//   exit 10 = mine (also needs other repos) → work my slice, leave the label for the others
//   exit 2  = not mine             → skip
//   exit 3  = unsure / error       → skip and surface as unrouted
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { getTracker } from './trackers/index.mjs';

const VERDICT_RE = /\{[^{}]*"mine"[\s\S]*\}/;

export function parseVerdict(text) {
  const m = (text || '').match(VERDICT_RE);
  if (!m) return { mine: false, multi: false, confidence: 'low', reason: 'unparseable' };
  try { return JSON.parse(m[0]); } catch { return { mine: false, multi: false, confidence: 'low', reason: 'unparseable' }; }
}

export function exitCodeFor(v) {
  if (!v || !v.mine) return 2;
  if (v.confidence !== 'high') return 3;   // claims mine but not confident → leave for its real owner
  return v.multi ? 10 : 0;
}

function resolveSdk() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.DEPUTY_SDK_DIR && join(process.env.DEPUTY_SDK_DIR, '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
    join(here, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

export async function routeTicket(repoFullName, ticketId, repoPath) {
  const tracker = getTracker();
  if (!tracker.getItem) return { mine: true, multi: false, confidence: 'high', reason: 'tracker has no body to route on' };
  const body = (await tracker.getItem(ticketId)).slice(0, 8000);

  const sdkPath = resolveSdk();
  if (!sdkPath) throw new Error('claude-agent-sdk not found');
  const { query } = await import(pathToFileURL(sdkPath).href);

  const prompt = `You decide whether a work ticket's implementation belongs in the repository you are inside.

This repository: ${repoFullName} (checked out at ${repoPath}).

Judge by the DELIVERABLE, not by what the ticket merely mentions — tickets often link other repos' files for context. Verify with the read-only tools: check whether the files, directories, and stack the ticket's work would touch actually exist HERE. A ticket can require more than one repo; say so.

Reply with ONLY one compact JSON object, nothing else:
{"mine": <true if work must be done in THIS repo>, "multi": <true if the ticket also needs other repos>, "confidence": "high"|"low", "reason": "<=15 words"}

TICKET ${ticketId}:
${body}`;

  let text = '';
  for await (const msg of query({
    prompt,
    options: {
      cwd: repoPath,
      permissionMode: 'bypassPermissions',
      allowedTools: ['Glob', 'Grep', 'Read'],
      maxTurns: Number(process.env.DEPUTY_ROUTE_MAX_TURNS || 12),
      ...(process.env.DEPUTY_ROUTE_MODEL ? { model: process.env.DEPUTY_ROUTE_MODEL } : {}),
    },
  })) {
    if (msg.type === 'assistant') for (const b of msg.message.content) if (b.type === 'text') text += b.text;
  }
  return parseVerdict(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [repoFullName, ticketId, repoPath] = process.argv.slice(2);
  routeTicket(repoFullName, ticketId, repoPath || process.cwd())
    .then((v) => {
      console.error(`[route] ${ticketId} @ ${repoFullName}: ${JSON.stringify(v)}`);
      process.exit(exitCodeFor(v));
    })
    .catch((e) => { console.error(`[route] ${ticketId}: ${e.message}`); process.exit(3); });
}
