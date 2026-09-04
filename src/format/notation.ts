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
import type { Content, List, MdastTable, Root } from 'chat';

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
        return getNodeValue(node);
      case 'strong':
        return `''${this.inlineChildren(node)}''`;
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
}

/**
 * Backlog notation → mdast. Line-based per docs/specs/adapter.md §9.5: the
 * upstream support article is the only syntax reference and does not specify
 * a grammar precise enough for a real parser, so this walks lines rather than
 * building a tokenizer, and deliberately leaves constructs outside §9.5's
 * list (colour, `#rev`, `#contents`, `#attach`, `#thumbnail`, wiki links,
 * issue-key auto-links) as plain text.
 */
function parseNotationBlocks(input: string): Content[] {
  const lines = input.split('\n');
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
      const { node, nextIndex } = parseQuoteMacro(lines, i);
      blocks.push(node);
      i = nextIndex;
      continue;
    }

    if (line.startsWith('> ') || line === '>') {
      flushParagraph();
      const { node, nextIndex } = parseQuoteLines(lines, i);
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
      const { node, nextIndex } = parseList(lines, i);
      blocks.push(node);
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

function parseQuoteMacro(
  lines: string[],
  startIndex: number
): { node: Content; nextIndex: number } {
  const body: string[] = [];
  let i = startIndex + 1;
  while (i < lines.length && (lines[i] ?? '').trim() !== '{/quote}') {
    body.push(lines[i] ?? '');
    i += 1;
  }
  const nextIndex = i < lines.length ? i + 1 : i;
  return { node: blockquote(parseNotationBlocks(body.join('\n'))), nextIndex };
}

function parseQuoteLines(
  lines: string[],
  startIndex: number
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
  return {
    node: blockquote(parseNotationBlocks(body.join('\n'))),
    nextIndex: i,
  };
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

function matchListMarker(
  line: string
): { ordered: boolean; depth: number } | null {
  const match = /^([+-]+)\s+/.exec(line);
  if (!match) {
    return null;
  }
  const marker = match[1] ?? '';
  return { ordered: marker[0] === '+', depth: marker.length };
}

/**
 * `+`/`-` lists with depth expressed by marker repetition
 * (docs/specs/adapter.md §9.5). Backlog has no single-list nesting model
 * documented beyond "repeat the marker", so each depth transition opens or
 * closes a nested `list` node to match.
 */
function parseList(
  lines: string[],
  startIndex: number
): { node: Content; nextIndex: number } {
  type StackFrame = { list: List; depth: number };
  const stack: StackFrame[] = [];

  let i = startIndex;
  while (i < lines.length) {
    const current = lines[i] ?? '';
    const marker = matchListMarker(current);
    if (!marker) {
      break;
    }
    const itemText = current
      .slice(current.indexOf(' ', marker.depth - 1) + 1)
      .trimStart();

    while (
      stack.length > 0 &&
      (stack[stack.length - 1]?.depth ?? 0) > marker.depth
    ) {
      stack.pop();
    }

    if (
      stack.length === 0 ||
      (stack[stack.length - 1]?.depth ?? 0) < marker.depth
    ) {
      const nested: List = {
        type: 'list',
        ordered: marker.ordered,
        children: [],
      };
      const parent = stack[stack.length - 1];
      if (parent) {
        const parentItem =
          parent.list.children[parent.list.children.length - 1];
        if (parentItem) {
          parentItem.children.push(nested);
        }
      }
      stack.push({ list: nested, depth: marker.depth });
    }

    const top = stack[stack.length - 1];
    if (top) {
      top.list.ordered = marker.ordered;
      top.list.children.push({
        type: 'listItem',
        children: toListItemChildren(inlineToNodes(itemText)),
      });
    }
    i += 1;
  }

  const outermost = stack[0];
  return {
    node: outermost
      ? outermost.list
      : { type: 'list', ordered: false, children: [] },
    nextIndex: i,
  };
}

function toListItemChildren(
  nodes: PhrasingNode[]
): [Extract<Content, { type: 'paragraph' }>] {
  return [paragraph(nodes)];
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
