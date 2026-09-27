import { BaseFormatConverter, parseMarkdown, stringifyMarkdown } from 'chat';
import type { AdapterPostableMessage, CardChild, Root } from 'chat';

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

  /**
   * `BaseFormatConverter.cardChildToFallbackText` — the one of `chat`'s three
   * card walks that `renderPostable` reaches — has no `link` or `divider`
   * case and returns `null` for both, so a `CardLink`'s URL and a divider
   * vanish from a card's fallback text. `@chat-adapter/shared`'s
   * `cardToFallbackText`, which cards reached before they were routed through
   * the project's converter, rendered both — so leaving them to `super` here
   * would lose content, not markup
   * (docs/specs/adapter.md §6.1).
   *
   * `stringifyMarkdown` is not used for either: it emits a thematic break as
   * `***`, where the text a card fallback has always carried is `---`. `---`
   * is kept even though it is the worse of the two — under prose it is a
   * setext underline, so it collapses everything above it into one `h2` —
   * because it is byte-for-byte what the shared walk produced, and a bug fix
   * should not also change what a Markdown project's cards look like (§9.3).
   */
  protected override cardChildToFallbackText(child: CardChild): string | null {
    switch (child.type) {
      case 'link':
        return child.label && child.label !== child.url
          ? `[${child.label}](${child.url})`
          : child.url;
      case 'divider':
        return '---';
      default:
        return super.cardChildToFallbackText(child);
    }
  }
}
