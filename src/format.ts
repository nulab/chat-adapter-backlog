import { BaseFormatConverter, parseMarkdown, stringifyMarkdown } from 'chat';
import type { AdapterPostableMessage, CardChild, Root } from 'chat';

class BacklogMarkdownConverter extends BaseFormatConverter {
  toAst(platformText: string): Root {
    return parseMarkdown(platformText);
  }

  fromAst(ast: Root): string {
    return stringifyMarkdown(ast).trim();
  }

  /**
   * The base class round-trips `{ markdown }` through `stringifyMarkdown`,
   * which escapes and restyles the author's Markdown although Backlog renders
   * it as written.
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

  /** The base class's card walk has no `link` case and drops the URL. */
  protected override cardChildToFallbackText(child: CardChild): string | null {
    if (child.type === 'link') {
      return child.label && child.label !== child.url
        ? `[${child.label}](${child.url})`
        : child.url;
    }
    return super.cardChildToFallbackText(child);
  }
}

export const converter = new BacklogMarkdownConverter();
