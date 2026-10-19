#!/usr/bin/env node
// Thin CLI so the bash daemon can use whichever tracker is configured without
// knowing any tracker specifics. Prints to stdout; errors to stderr + exit != 0.
import { getTracker } from './trackers/index.mjs';

const [cmd, id] = process.argv.slice(2);

try {
  const t = getTracker();
  switch (cmd) {
    case 'list-ready':
      for (const item of await t.listReady()) console.log(item.id);
      break;
    case 'start':
      await t.markStarted(id);
      break;
    case 'blockers':
      for (const b of (t.getBlockers ? await t.getBlockers(id) : [])) console.log(b);
      break;
    case 'url':
      { const u = t.itemUrl(id); if (u) console.log(u); }
      break;
    case 'title':
      { const s = t.title ? await t.title(id) : ''; if (s) console.log(s); }
      break;
    case 'ref':
      console.log(t.prRef(id));
      break;
    case 'name':
      console.log(t.name);
      break;
    default:
      console.error('usage: tracker-cli {list-ready|start <id>|blockers <id>|url <id>|title <id>|ref <id>|name}');
      process.exit(2);
  }
} catch (e) {
  console.error(`tracker error: ${e.message}`);
  process.exit(1);
}
