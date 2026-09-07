import { waitUntil } from '@vercel/functions';

import { chat } from '../../src/bot';

export const runtime = 'nodejs';
export const maxDuration = 60;

export function POST(request: Request): Promise<Response> {
  return chat.webhooks.backlog(request, { waitUntil });
}
