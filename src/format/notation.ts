import {
  BaseFormatConverter,
  blockquote,
  codeBlock,
  emphasis,
  getNodeChildren,
  getNodeValue,
  link,
  paragraph,
  root,
  strikethrough,
  strong,
  text,
} from 'chat';
import type {
  CardChild,
  CardElement,
  Content,
  List,
  ListItem,
  MdastTable,
  Root,
} from 'chat';

/**
 * The subset of `Content` that inline notation parsing can ever produce.
 * `PhrasingContent` (mdast's own name for this subset) is not among `chat`'s
 * re-exports, and `mdast` is only a transitive dependency here — so this
 * union is declared locally instead of imported.
 */
type PhrasingNode = Extract<
  Content,
  { type: 'text' | 'strong' | 'emphasis' | 'delete' | 'link' | 'break' }
>;

/**
 * Converts between mdast and Backlog notation (Backlog記法) — the markup
 * syntax `textFormattingRule: "backlog"` projects use. Notation is a
 * different syntax from Markdown, not a superset: `''bold''` and `'''italic'''`
 * for example share Markdown's `'` only by coincidence (docs/specs/adapter.md
 * §9.1).
 *
 * Reference: https://support.nulab.com/hc/en-us/articles/360035641594 and
 * docs/specs/adapter.md §9.4 (outbound) / §9.5 (inbound).
 */
export class BacklogNotationConverter extends BaseFormatConverter {
  fromAst(ast: Root): string {
    return this.fromAstWithNodeConverter(ast, (node) =>
      this.nodeToNotation(node)
    );
  }

  toAst(platformText: string): Root {
    return root(parseNotationBlocks(platformText));
  }

  private nodeToNotation(node: Content): string {
    switch (node.type) {
      case 'heading':
        return `${'*'.repeat(node.depth)} ${this.inlineChildren(node)}`;
      case 'paragraph':
        return this.inlineChildren(node);
      case 'text':
        // Not escaped, although notation does have a `\` escape: which
        // characters it covers, what it does before an ordinary one, and
        // whether the guide's `¥` gloss means a literal yen sign escapes too
        // are all unmeasured, so escaping here would be a guess that eats a
        // caller's backslashes — or every `¥100` in a Japanese comment
        // (docs/specs/adapter.md §9.7). Measure against a real space first.
        return getNodeValue(node);
      case 'strong':
        return this.bold(this.inlineChildren(node));
      case 'emphasis':
        return `'''${this.inlineChildren(node)}'''`;
      case 'delete':
        return `%%${this.inlineChildren(node)}%%`;
      case 'inlineCode':
        // Backlog notation has no inline-code syntax; the value is emitted
        // unchanged (docs/specs/adapter.md §9.4, §9.6 — deliberately lossy).
        return getNodeValue(node);
      case 'code':
        return this.codeToNotation(node);
      case 'link':
        return this.linkToNotation(node);
      case 'image':
        return `#image(${node.url})`;
      case 'break':
        return '&br;';
      case 'thematicBreak':
        return '----';
      case 'blockquote':
        return this.blockquoteToNotation(node);
      case 'list':
        return this.listToNotation(node, 1);
      case 'table':
        return this.tableToNotation(node);
      default:
        return this.defaultNodeToText(node, (child) =>
          this.nodeToNotation(child)
        );
    }
  }

  private inlineChildren(node: Content): string {
    return getNodeChildren(node)
      .map((child) => this.nodeToNotation(child))
      .join('');
  }

  private codeToNotation(node: Extract<Content, { type: 'code' }>): string {
    const open = node.lang ? `{code:${node.lang}}` : '{code}';
    return `${open}\n${node.value}\n{/code}`;
  }

  private linkToNotation(node: Extract<Content, { type: 'link' }>): string {
    const label = this.inlineChildren(node);
    return label && label !== node.url
      ? `[[${label}>${node.url}]]`
      : `[[${node.url}]]`;
  }

  private blockquoteToNotation(node: Content): string {
    const inner = getNodeChildren(node)
      .map((child) => this.nodeToNotation(child))
      .join('\n\n');
    return inner
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
  }

  /**
   * Notation expresses list depth by repeating the marker character
   * (`-`/`--`/`---`, `+`/`++`/`+++`) rather than by indentation, and marks
   * ordered lists with `+` instead of numbering items — neither of which
   * `BaseFormatConverter.renderList` (Markdown-shaped: indentation depth,
   * `1.`/`2.` numbering) can produce, so lists are rendered directly here.
   */
  private listToNotation(node: List, depth: number): string {
    const marker = (node.ordered ? '+' : '-').repeat(depth);
    const lines: string[] = [];
    for (const item of getNodeChildren(node)) {
      const ownText: string[] = [];
      const nestedLines: string[] = [];
      for (const child of getNodeChildren(item)) {
        if (child.type === 'list') {
          nestedLines.push(this.listToNotation(child, depth + 1));
          continue;
        }
        const rendered = this.nodeToNotation(child);
        if (rendered.trim()) {
          ownText.push(rendered);
        }
      }
      if (ownText.length > 0) {
        lines.push(`${marker} ${ownText.join(' ')}`);
      }
      lines.push(...nestedLines);
    }
    return lines.join('\n');
  }

  private tableToNotation(node: MdastTable): string {
    const rows = getNodeChildren(node).map((row) =>
      getNodeChildren(row)
        .map((cell) => this.inlineChildren(cell))
        .join('|')
    );
    return rows
      .map((row, index) => (index === 0 ? `|${row}|h` : `|${row}|`))
      .join('\n');
  }

  private bold(value: string): string {
    return `''${value}''`;
  }

  /**
   * `BaseFormatConverter.cardToFallbackText` hard-codes Markdown's `**`
   * around the title, so a `backlog` project posted the asterisks literally
   * (docs/specs/adapter.md §6.1, §9.4). The bold marker cannot be passed in:
   * the base method takes no options, and `@chat-adapter/shared`'s
   * `cardToFallbackText` types `boldFormat` as `"*" | "**"` — neither can
   * express `''`. So the places a card carries markup are re-rendered here
   * and every other child (subtitle, text, tables, charts, sections) still
   * comes from `super`, which is why this override repeats the base method's
   * three-part assembly rather than replacing the walk. A title or label is
   * emitted as written; §9.7 covers what notation cannot escape.
   */
  protected override cardToFallbackText(card: CardElement): string {
    const parts: string[] = [];
    if (card.title) {
      parts.push(this.bold(card.title));
    }
    if (card.subtitle) {
      parts.push(card.subtitle);
    }
    for (const child of card.children) {
      const rendered = this.cardChildToFallbackText(child);
      if (rendered) {
        parts.push(rendered);
      }
    }
    return parts.join('\n');
  }

  /**
   * `link` and `divider` are here for a different reason than `fields`:
   * `BaseFormatConverter.cardChildToFallbackText` — the walk `renderPostable`
   * reaches — has a case for neither and returns `null`, which drops a
   * `CardLink`'s URL out of the message entirely. That is a loss of content,
   * not of markup, so each routes through the §9.4 row it already has rather
   * than through `super`. `chat@4.39.0`'s other two card walks are not
   * missing the same cases, so the gap belongs to that method, not to the
   * package.
   */
  protected override cardChildToFallbackText(child: CardChild): string | null {
    switch (child.type) {
      case 'fields':
        return child.children
          .map((field) => `${this.bold(field.label)}: ${field.value}`)
          .join('\n');
      case 'link':
        return this.nodeToNotation(link(child.url, [text(child.label)]));
      case 'divider':
        return this.nodeToNotation({ type: 'thematicBreak' });
      default:
        return super.cardChildToFallbackText(child);
    }
  }
}

/**
 * Backlog notation → mdast. Line-based per docs/specs/adapter.md §9.5: the
 * upstream support article is the only syntax reference and does not specify
 * a grammar precise enough for a real parser, so this walks lines rather than
 * building a tokenizer, and deliberately leaves constructs outside §9.5's
 * list (colour, `#rev`, `#contents`, `#attach`, `#thumbnail`, wiki links,
 * issue-key auto-links) as plain text.
 */
function parseNotationBlocks(input: string, quoteDepth = 0): Content[] {
  // `\r?\n`, not `\n`: a line-based matcher anchored at `$` (a list marker,
  // a heading) never matches a line a CRLF body left a trailing `\r` on.
  const lines = input.split(/\r?\n/);
  const blocks: Content[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) {
      return;
    }
    blocks.push(paragraph(inlineToNodes(paragraphLines.join('\n'))));
    paragraphLines = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    const codeOpen = matchCodeOpen(line);
    if (codeOpen) {
      flushParagraph();
      const { node, nextIndex } = parseCodeBlock(lines, i, codeOpen.lang);
      blocks.push(node);
      i = nextIndex;
      continue;
    }

    if (line.trim() === '{quote}') {
      flushParagraph();
      const { node, nextIndex } = parseQuoteMacro(lines, i, quoteDepth);
      blocks.push(node);
      i = nextIndex;
      continue;
    }

    if (line.startsWith('> ') || line === '>') {
      flushParagraph();
      const { node, nextIndex } = parseQuoteLines(lines, i, quoteDepth);
      blocks.push(node);
      i = nextIndex;
      continue;
    }

    const heading = matchHeading(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: 'heading',
        depth: heading.depth,
        children: inlineToNodes(heading.text),
      });
      i += 1;
      continue;
    }

    if (line.trim() === '----') {
      flushParagraph();
      blocks.push({ type: 'thematicBreak' });
      i += 1;
      continue;
    }

    const listMarker = matchListMarker(line);
    if (listMarker) {
      flushParagraph();
      const { list, nextIndex } = parseList(lines, i, listMarker);
      blocks.push(list);
      i = nextIndex;
      continue;
    }

    const tableRow = matchTableRow(line);
    if (tableRow) {
      flushParagraph();
      const { node, nextIndex } = parseTable(lines, i);
      blocks.push(node);
      i = nextIndex;
      continue;
    }

    const image = matchImage(line.trim());
    if (image) {
      flushParagraph();
      blocks.push(paragraph([{ type: 'image', url: image, alt: null }]));
      i += 1;
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      i += 1;
      continue;
    }

    paragraphLines.push(line);
    i += 1;
  }
  flushParagraph();
  return blocks;
}

function matchCodeOpen(line: string): { lang?: string } | null {
  const match = /^\{code(?::([^}]+))?\}/.exec(line.trim());
  if (!match) {
    return null;
  }
  const lang = match[1];
  return lang !== undefined ? { lang } : {};
}

/**
 * `{code}`/`{code:lang}` … `{/code}`, including a pair opened and closed on
 * one line, and an unclosed block implicitly closed at EOF
 * (docs/specs/adapter.md §9.5). Contents are carried verbatim — not
 * inline-converted — mirroring how Backlog itself treats code-macro bodies
 * as opaque text.
 */
function parseCodeBlock(
  lines: string[],
  startIndex: number,
  lang: string | undefined
): { node: Content; nextIndex: number } {
  const startLine = lines[startIndex] ?? '';
  const trimmed = startLine.trim();
  const openTag = lang ? `{code:${lang}}` : '{code}';
  const afterOpen = trimmed.slice(openTag.length);
  const closeIndex = afterOpen.indexOf('{/code}');

  if (closeIndex !== -1) {
    const value = afterOpen.slice(0, closeIndex);
    return { node: codeNode(value, lang), nextIndex: startIndex + 1 };
  }

  const body: string[] = afterOpen.length > 0 ? [afterOpen] : [];
  let i = startIndex + 1;
  while (i < lines.length) {
    const current = lines[i] ?? '';
    if (current.trim() === '{/code}') {
      return { node: codeNode(body.join('\n'), lang), nextIndex: i + 1 };
    }
    body.push(current);
    i += 1;
  }
  // Unclosed at EOF: close it there anyway (§9.5).
  return { node: codeNode(body.join('\n'), lang), nextIndex: i };
}

function codeNode(value: string, lang: string | undefined): Content {
  return lang !== undefined ? codeBlock(value, lang) : codeBlock(value);
}

/**
 * Each quote level is one recursion into `parseNotationBlocks`, so an
 * unbounded depth lets one comment of a few thousand `> ` overflow the stack
 * and fail every read of its thread. Past this depth the rest is kept as
 * quoted text rather than parsed further.
 */
const MAX_QUOTE_DEPTH = 16;

function quoteOf(body: string[], quoteDepth: number): Content {
  const text = body.join('\n');
  return blockquote(
    quoteDepth + 1 < MAX_QUOTE_DEPTH
      ? parseNotationBlocks(text, quoteDepth + 1)
      : [paragraph(inlineToNodes(text))]
  );
}

function parseQuoteMacro(
  lines: string[],
  startIndex: number,
  quoteDepth: number
): { node: Content; nextIndex: number } {
  const body: string[] = [];
  let i = startIndex + 1;
  while (i < lines.length && (lines[i] ?? '').trim() !== '{/quote}') {
    body.push(lines[i] ?? '');
    i += 1;
  }
  const nextIndex = i < lines.length ? i + 1 : i;
  return { node: quoteOf(body, quoteDepth), nextIndex };
}

function parseQuoteLines(
  lines: string[],
  startIndex: number,
  quoteDepth: number
): { node: Content; nextIndex: number } {
  const body: string[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const current = lines[i] ?? '';
    if (current.startsWith('> ')) {
      body.push(current.slice(2));
    } else if (current === '>') {
      body.push('');
    } else {
      break;
    }
    i += 1;
  }
  return { node: quoteOf(body, quoteDepth), nextIndex: i };
}

function matchHeading(
  line: string
): { depth: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
  const match = /^(\*{1,6})\s+(.*)$/.exec(line);
  if (!match) {
    return null;
  }
  const marker = match[1] ?? '';
  const depth = Math.min(marker.length, 6) as 1 | 2 | 3 | 4 | 5 | 6;
  return { depth, text: match[2] ?? '' };
}

type ListMarker = { ordered: boolean; depth: number; text: string };

/**
 * A `+`/`-` run followed by text. The text must be non-empty, which is what
 * keeps a trailing space from making a line a list item: `----␣` would
 * otherwise match as marker `----` with no text, and because `parseList` asks
 * this predicate alone while `parseNotationBlocks` tests `----` first, the same
 * line became a depth-4 empty item after a list and a `thematicBreak` anywhere
 * else (docs/specs/adapter.md §9.5). Rejecting an empty text sends both
 * `----␣` and `-␣` back to `parseNotationBlocks`, which classifies them
 * like any other line that is no list item.
 *
 * `matchHeading` carries no such guard, so `*␣` is a `heading` with no
 * content while `*` alone is a paragraph. Do not read this predicate as a
 * parser-wide rule about trailing whitespace: §9.5 leaves the heading side to
 * a separate change.
 */
function matchListMarker(line: string): ListMarker | null {
  const match = /^([+-]+)\s+(.*)$/.exec(line);
  if (!match) {
    return null;
  }
  const itemText = match[2] ?? '';
  if (itemText === '') {
    return null;
  }
  const marker = match[1] ?? '';
  return {
    ordered: marker[0] === '+',
    depth: marker.length,
    text: itemText,
  };
}

/**
 * One list: the items sharing `marker`'s depth and kind, plus everything
 * nested under them (`+`/`-` with depth by marker repetition,
 * docs/specs/adapter.md §9.5). Each depth transition opens one nested `list`,
 * however far the marker jumps, and the list ends at the first marker it
 * cannot contain — shallower than its own, or of the other kind at its own
 * depth — or at the first line that is no list item at all (`matchListMarker`).
 * The caller resumes there: `parseNotationBlocks` for the outermost list, the
 * enclosing list for a nested one.
 *
 * Neither marker can be absorbed instead: mdast hangs a nested `list` off a
 * `listItem`, so a list shallower than this one has no item above it to hang
 * from, and reopening this list with the other kind would put its `ordered`
 * in the hands of whichever marker came last.
 */
function parseList(
  lines: string[],
  startIndex: number,
  marker: ListMarker
): { list: List; nextIndex: number } {
  const list: List = {
    type: 'list',
    ordered: marker.ordered,
    children: [],
  };
  let currentItem = listItemOf(marker.text);
  list.children.push(currentItem);

  let i = startIndex + 1;
  while (i < lines.length) {
    const next = matchListMarker(lines[i] ?? '');
    if (!next || next.depth < marker.depth) {
      break;
    }
    if (next.depth === marker.depth) {
      if (next.ordered !== marker.ordered) {
        break;
      }
      currentItem = listItemOf(next.text);
      list.children.push(currentItem);
      i += 1;
      continue;
    }

    const nested = parseList(lines, i, next);
    currentItem.children.push(nested.list);
    i = nested.nextIndex;
  }

  return { list, nextIndex: i };
}

function listItemOf(itemText: string): ListItem {
  return { type: 'listItem', children: [paragraph(inlineToNodes(itemText))] };
}

function matchTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.length > 1;
}

/**
 * `|a|b|h` marks the header row; `|~cell` marks a header cell within any row
 * (docs/specs/adapter.md §9.5). Column alignment has no notation counterpart
 * so every table round-trips without an `align` array — the same loss as the
 * outbound direction (§9.6).
 */
function parseTable(
  lines: string[],
  startIndex: number
): { node: Content; nextIndex: number } {
  const rows: { cells: string[]; isHeader: boolean }[] = [];
  let i = startIndex;
  while (i < lines.length && matchTableRow(lines[i] ?? '')) {
    const trimmed = (lines[i] ?? '').trim();
    const isHeaderRow = trimmed.endsWith('|h');
    const body = isHeaderRow ? trimmed.slice(1, -2) : trimmed.slice(1, -1);
    const cells = body.split('|').map((cell) => cell.replace(/^~/, ''));
    rows.push({ cells, isHeader: isHeaderRow });
    i += 1;
  }

  type TableRowNode = Extract<Content, { type: 'tableRow' }>;
  type TableCellNode = Extract<Content, { type: 'tableCell' }>;

  const tableRows: TableRowNode[] = rows.map((row) => ({
    type: 'tableRow',
    children: row.cells.map((cell): TableCellNode => ({
      type: 'tableCell',
      children: inlineToNodes(cell),
    })),
  }));

  return { node: { type: 'table', children: tableRows }, nextIndex: i };
}

function matchImage(trimmed: string): string | null {
  const match = /^#image\(([^)]*)\)$/.exec(trimmed);
  return match ? (match[1] ?? '') : null;
}

/**
 * Inline notation within one logical line: `'''x'''` (italic) before `''x''`
 * (bold) because the longer marker would otherwise be split by the shorter
 * one's pattern; `%%x%%`; `[[label>url]]` / `[[label:url]]` / `[[url]]`;
 * `&br;`. Anything else (colour macros, `#rev`, `#contents`, `#attach`,
 * `#thumbnail`, wiki links, issue-key auto-links) is left as plain text —
 * §9.5 draws the line there rather than growing this into a wiki parser.
 */
function inlineToNodes(input: string): PhrasingNode[] {
  const nodes: PhrasingNode[] = [];
  let buffer = '';
  let i = 0;

  const flushText = (): void => {
    if (buffer.length > 0) {
      nodes.push(text(buffer));
      buffer = '';
    }
  };

  while (i < input.length) {
    if (input.startsWith('&br;', i)) {
      flushText();
      nodes.push({ type: 'break' });
      i += 4;
      continue;
    }

    if (input.startsWith("'''", i)) {
      const end = input.indexOf("'''", i + 3);
      if (end !== -1) {
        flushText();
        nodes.push(emphasis(inlineToNodes(input.slice(i + 3, end))));
        i = end + 3;
        continue;
      }
    }

    if (input.startsWith("''", i)) {
      const end = input.indexOf("''", i + 2);
      if (end !== -1) {
        flushText();
        nodes.push(strong(inlineToNodes(input.slice(i + 2, end))));
        i = end + 2;
        continue;
      }
    }

    if (input.startsWith('%%', i)) {
      const end = input.indexOf('%%', i + 2);
      if (end !== -1) {
        flushText();
        nodes.push(strikethrough(inlineToNodes(input.slice(i + 2, end))));
        i = end + 2;
        continue;
      }
    }

    if (input.startsWith('[[', i)) {
      const end = input.indexOf(']]', i + 2);
      if (end !== -1) {
        const inner = input.slice(i + 2, end);
        flushText();
        nodes.push(parseLinkInner(inner));
        i = end + 2;
        continue;
      }
    }

    buffer += input[i];
    i += 1;
  }
  flushText();
  return nodes;
}

function parseLinkInner(inner: string): PhrasingNode {
  const labeled = /^(.*?)>(.+)$/.exec(inner);
  if (labeled) {
    const label = labeled[1] ?? '';
    const url = labeled[2] ?? '';
    return link(url, [text(label)]);
  }
  const aliased = /^(.*?):(https?:\/\/.+)$/.exec(inner);
  if (aliased) {
    const label = aliased[1] ?? '';
    const url = aliased[2] ?? '';
    return link(url, [text(label)]);
  }
  return link(inner, [text(inner)]);
}
