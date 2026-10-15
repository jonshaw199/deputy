// Tracker factory. Add a new backend by dropping a module here and registering it.
// Every tracker exposes: listReady, getItem, markStarted, markDone, itemUrl, prRef, name.
import jira from './jira.mjs';
import github from './github-issues.mjs';

const trackers = { jira, github };

export function getTracker() {
  const name = (process.env.AIDAEMON_TRACKER || 'jira').toLowerCase();
  const t = trackers[name];
  if (!t) throw new Error(`Unknown tracker "${name}". Available: ${Object.keys(trackers).join(', ')}`);
  return t;
}
