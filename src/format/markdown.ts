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
   * `toAst` + `fromAst`. On a Markdown project that only rewrites the
   * author's Markdown into `stringifyMarkdown`'s style, escaping included,
   * so it passes through verbatim like `string` and `{ raw }` do.
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
   * `BaseFormatConverter.cardChildToFallbackText` — the card walk
   * `renderPostable` reaches — has no `link` or `divider` case and returns
   * `null` for both, so leaving them to `super` would drop a `CardLink`'s URL
   * from the message.
   *
   * Not `stringifyMarkdown`, which emits a thematic break as `***`: `---` is
   * what `@chat-adapter/shared`'s `cardToFallbackText` produced, although
   * under prose it is a setext underline, and a Markdown project's cards keep
   * that text.
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
