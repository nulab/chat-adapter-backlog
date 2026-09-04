import { BaseFormatConverter, paragraph, root, text } from 'chat';
import type { AdapterPostableMessage, Logger, Root } from 'chat';
import type { Types } from 'backlog-js';

import { BacklogMarkdownConverter } from './markdown';
import { BacklogNotationConverter } from './notation';

/** Identifies the space and project a fallback warning was logged for. */
export interface FormatConversionContext {
  host: string;
  projectId: number;
}

/**
 * Wraps a converter so a hostile or unsupported inbound payload degrades a
 * message instead of failing it. Per docs/specs/adapter.md §9.2 the two
 * directions are asymmetric on purpose:
 *
 * - `toAst` (inbound, webhook-driven) throwing would drop an otherwise
 *   deliverable notification, so it degrades to one paragraph carrying the
 *   raw text and logs a single `warn`.
 * - `fromAst` (outbound, a user-initiated post) throwing propagates: a post
 *   that cannot be rendered must fail loudly rather than silently publish
 *   something other than what was asked for.
 */
export class FallbackFormatConverter extends BaseFormatConverter {
  constructor(
    private readonly inner: BaseFormatConverter,
    private readonly logger: Logger,
    private readonly context: FormatConversionContext
  ) {
    super();
  }

  toAst(platformText: string): Root {
    try {
      return this.inner.toAst(platformText);
    } catch {
      this.logger.warn(
        'format conversion failed; falling back to plain text',
        this.context
      );
      return root([paragraph([text(platformText)])]);
    }
  }

  fromAst(ast: Root): string {
    return this.inner.fromAst(ast);
  }

  override renderPostable(message: AdapterPostableMessage): string {
    return this.inner.renderPostable(message);
  }
}

/**
 * Selects the converter for a project's `textFormattingRule`
 * (https://developer.nulab.com/docs/backlog/api/2/get-project/), wrapped in
 * the §9.2 fallback so a malformed inbound payload never fails delivery.
 */
export function converterFor(
  rule: Types.TextFormattingRule,
  logger: Logger,
  context: FormatConversionContext
): FallbackFormatConverter {
  const inner =
    rule === 'markdown'
      ? new BacklogMarkdownConverter()
      : new BacklogNotationConverter();
  return new FallbackFormatConverter(inner, logger, context);
}
