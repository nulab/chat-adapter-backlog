import { ValidationError } from '@chat-adapter/shared';
import { z } from 'zod';

import { HOST_PATTERN } from './ids';
import type { Credential } from './client/backlog';
import type {
  BacklogAdapterConfig,
  BacklogWebhookVerifier,
  Resolvable,
} from './types';
import type { Logger } from 'chat';

/**
 * Backlog signs nothing, so without a `webhookVerifier` this secret is the
 * whole of webhook authenticity (D2). Below sixteen bytes guessing it is the
 * cheap attack, and a library must not decide for a deployment that a weak
 * secret is acceptable.
 */
const MIN_WEBHOOK_SECRET_BYTES = 16;

const resolvable = (field: string) => {
  const error = `${field} must be a non-empty string or a function`;
  return z.union(
    [
      z.string().min(1, { error }),
      z.custom<() => string | Promise<string>>(
        (value) => typeof value === 'function',
        { error }
      ),
    ],
    { error }
  );
};

const botUserIdMessage =
  'botUserId (BACKLOG_BOT_USER_ID) must be a positive integer, at most 2^53-1';

// `z.int()` stops at 2^53-1: a larger id would not survive a user id string.
const botUserIdRequired =
  'botUserId is required: set config.botUserId or BACKLOG_BOT_USER_ID';

const botUserId = z.union(
  [
    z.int({ error: botUserIdMessage }).positive({ error: botUserIdMessage }),
    z
      .string({ error: botUserIdMessage })
      .regex(/^[1-9]\d*$/, { error: botUserIdMessage })
      .transform(Number)
      .pipe(z.int({ error: botUserIdMessage })),
  ],
  {
    error: (issue) =>
      issue.input === undefined ? botUserIdRequired : botUserIdMessage,
  }
);

const configSchema = z
  .strictObject({
    host: z
      .string({ error: 'host is required: set config.host or BACKLOG_HOST' })
      .transform((host) => host.toLowerCase())
      .pipe(
        z.string().regex(HOST_PATTERN, {
          error:
            'host must be a bare hostname such as example.backlog.com, without scheme, port or path',
        })
      ),
    apiKey: resolvable('apiKey').optional(),
    accessToken: resolvable('accessToken').optional(),
    botUserId: botUserId,
    webhookSecret: z
      .string()
      .refine(
        (secret) =>
          Buffer.byteLength(secret, 'utf8') >= MIN_WEBHOOK_SECRET_BYTES,
        {
          error: `webhookSecret (BACKLOG_WEBHOOK_SECRET) must be at least ${MIN_WEBHOOK_SECRET_BYTES} bytes; generate one with \`openssl rand -hex 32\``,
        }
      )
      .optional(),
    webhookVerifier: z
      .custom<BacklogWebhookVerifier>((value) => typeof value === 'function', {
        error: 'webhookVerifier must be a function',
      })
      .optional(),
    logger: z.custom<Logger>().optional(),
  })
  .refine(
    (config) =>
      config.webhookSecret !== undefined ||
      config.webhookVerifier !== undefined,
    {
      error:
        'webhookSecret is required: set config.webhookSecret, BACKLOG_WEBHOOK_SECRET or config.webhookVerifier',
    }
  )
  .transform(({ apiKey, accessToken, ...rest }, ctx) => {
    if (apiKey !== undefined && accessToken === undefined) {
      const credential: Credential = {
        header: 'Backlog-API-Key',
        resolve: async () => resolve(apiKey),
      };
      return { ...rest, credential };
    }
    if (accessToken !== undefined && apiKey === undefined) {
      const credential: Credential = {
        header: 'Authorization',
        resolve: async () => `Bearer ${await resolve(accessToken)}`,
      };
      return { ...rest, credential };
    }
    ctx.issues.push({
      code: 'custom',
      input: { apiKey, accessToken },
      message:
        'exactly one of apiKey or accessToken is required: set config.apiKey, config.accessToken, BACKLOG_API_KEY or BACKLOG_ACCESS_TOKEN',
    });
    return z.NEVER;
  });

export type SpaceConfig = z.output<typeof configSchema>;

/**
 * Called by the client on every request rather than once here: resolving at
 * construction would pin an hourly OAuth token for the process's lifetime.
 */
function resolve(value: Resolvable): string | Promise<string> {
  return typeof value === 'function' ? value() : value;
}

/**
 * The credential falls back to the environment as a pair, not field by field:
 * an explicit one beside the other's leftover variable is a deployment that
 * moved from OAuth to an API key without unsetting the old variable, and
 * reading both would refuse the config the caller had just written.
 *
 * `BACKLOG_WEBHOOK_SECRET` is not read beside a `webhookVerifier`: a verifier
 * replaces the secret, so a short one left in the environment would otherwise
 * fail a deployment that never uses it.
 *
 * A blank `BACKLOG_BOT_*` is missing, and missing is an error: a copied
 * `.env.example` leaves those lines blank.
 */
function withEnvironment(config: BacklogAdapterConfig): unknown {
  const env = process.env;
  const explicitCredential =
    config.apiKey !== undefined || config.accessToken !== undefined;
  return {
    ...config,
    host: config.host ?? env.BACKLOG_HOST,
    apiKey: explicitCredential ? config.apiKey : env.BACKLOG_API_KEY,
    accessToken: explicitCredential
      ? config.accessToken
      : env.BACKLOG_ACCESS_TOKEN,
    botUserId: config.botUserId ?? (env.BACKLOG_BOT_USER_ID || undefined),
    webhookSecret:
      config.webhookSecret ??
      (config.webhookVerifier === undefined
        ? env.BACKLOG_WEBHOOK_SECRET
        : undefined),
  };
}

export function parseConfig(config: BacklogAdapterConfig): SpaceConfig {
  const result = configSchema.safeParse(withEnvironment(config));
  if (!result.success) {
    throw new ValidationError(
      'backlog',
      result.error.issues.map((issue) => issue.message).join('; ')
    );
  }
  return result.data;
}
