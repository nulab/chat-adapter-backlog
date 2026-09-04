import { BaseFormatConverter, parseMarkdown, stringifyMarkdown } from 'chat';
import type { AdapterPostableMessage, Root } from 'chat';

/**
 * Converts between mdast and the text `textFormattingRule: "markdown"`
 * Backlog projects use — GitHub Flavored Markdown
 * (https://developer.nulab.com/docs/backlog/api/2/get-project/).
 */
export class BacklogMarkdownConverter extends BaseFormatConverter {
  toAst(platformText: string): Root {
    return parseMarkdown(platformText);
  }

  fromAst(ast: Root): string {
    return stringifyMarkdown(ast).trim();
  }

  /**
   * `BaseFormatConverter.renderPostable` round-trips `{ markdown }` through
   * `toAst` + `fromAst` for every platform. On a Markdown project the
   * platform format already *is* GFM, so that round trip only rewrites the
   * author's Markdown into `stringifyMarkdown`'s own style — extra escaping
   * churn with no formatting gained (docs/specs/adapter.md §9.3). Passing it
   * through verbatim, like `string` and `{ raw }` already are, avoids that.
   */
  override renderPostable(message: AdapterPostableMessage): string {
    if (
      typeof message === 'object' &&
      message !== null &&
      'markdown' in message
    ) {
      return message.markdown;
    }
    return super.renderPostable(message);
  }
}
