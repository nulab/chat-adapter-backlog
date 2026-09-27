import { waitUntil } from '@vercel/functions';

import { chat } from '../../src/bot.js';

export const runtime = 'nodejs';
// Above the adapter's 60-second wait on a 429. A shorter ceiling stops the
// function mid-wait — after the webhook has already answered 200 — and the
// reply is lost without an error.
export const maxDuration = 90;

export function POST(request: Request): Promise<Response> {
  return chat.webhooks.backlog(request, { waitUntil });
}
