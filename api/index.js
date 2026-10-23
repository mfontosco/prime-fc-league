// Vercel entry point: every request is rewritten here (see vercel.json) and handed to the league server.
// Vercel's filesystem is read-only apart from /tmp, and /tmp is wiped between cold starts,
// so results saved here are TEMPORARY until persistent storage is added.

import { randomBytes } from 'node:crypto';
import { createLeagueServer } from '../server.js';

let adminPin = process.env.ADMIN_PIN;
if (!adminPin) {
  // Never fall back to the well-known default PIN on a public deployment: admin stays locked instead.
  adminPin = randomBytes(32).toString('hex');
  console.error('[vercel] ADMIN_PIN is not set — admin login is disabled. Add ADMIN_PIN in the Vercel project settings.');
}

const server = createLeagueServer({ dataFile: process.env.DATA_FILE || '/tmp/prime-fc/league.json', adminPin });

export default function handler(req, res) {
  server.emit('request', req, res);
}
