import {
  blockquote,
  codeBlock,
  link,
  paragraph,
  root,
  strikethrough,
  strong,
  text,
} from 'chat';
import type { Content, Root as RootNode } from 'chat';
import { describe, expect, it } from 'vitest';

import { BacklogNotationConverter } from './notation';

function heading1(children: Content[]): Content {
  // `chat` does not export a `heading` builder, so tests construct the node
  // literally — this mirrors what `BacklogNotationConverter.toAst` produces.
  return { type: 'heading', depth: 1, children } as Content;
}

const converter = new BacklogNotationConverter();

describe('BacklogNotationConverter outbound (fromAst)', () => {
  it('bold, italic and strikethrough round-trip through Backlog notation', () => {
    const ast: RootNode = root([
      paragraph([
        strong([text('bold')]),
        text(' '),
        { type: 'emphasis', children: [text('italic')] },
        text(' '),
        strikethrough([text('gone')]),
      ]),
    ]);

    expect(converter.fromAst(ast)).toBe("''bold'' '''italic''' %%gone%%");
    expect(converter.toAst(converter.fromAst(ast))).toEqual(ast);
  });

  it('a fenced code block becomes a code macro with its language', () => {
    const ast: RootNode = root([codeBlock('const x = 1;', 'js')]);

    expect(converter.fromAst(ast)).toBe('{code:js}\nconst x = 1;\n{/code}');
  });

  it('renders a code block with no language as a bare code macro', () => {
    const ast: RootNode = root([codeBlock('plain text')]);

    expect(converter.fromAst(ast)).toBe('{code}\nplain text\n{/code}');
  });

  it('renders headings as leading asterisks matching their depth', () => {
    const ast: RootNode = root([heading1([text('Title')])]);

    expect(converter.fromAst(ast)).toBe('* Title');
  });

  it('renders a link with a label distinct from its url as a labeled link', () => {
    const ast: RootNode = root([
      paragraph([link('https://example.backlog.com', [text('space')])]),
    ]);

    expect(converter.fromAst(ast)).toBe(
      '[[space>https://example.backlog.com]]'
    );
  });

  it('renders a link whose label equals its url as a bare link', () => {
    const ast: RootNode = root([
      paragraph([
        link('https://example.backlog.com', [
          text('https://example.backlog.com'),
        ]),
      ]),
    ]);

    expect(converter.fromAst(ast)).toBe('[[https://example.backlog.com]]');
  });

  it('renders an image node as an image macro', () => {
    const ast: RootNode = root([
      { type: 'image', url: 'https://example.backlog.com/icon.png', alt: null },
    ]);

    expect(converter.fromAst(ast)).toBe(
      '#image(https://example.backlog.com/icon.png)'
    );
  });

  it('renders a break node as a br macro and a thematic break as four hyphens', () => {
    const ast: RootNode = root([
      paragraph([text('line one'), { type: 'break' }, text('line two')]),
      { type: 'thematicBreak' },
    ]);

    expect(converter.fromAst(ast)).toBe('line one&br;line two\n\n----');
  });

  it('renders a blockquote with every line prefixed', () => {
    const ast: RootNode = root([
      blockquote([paragraph([text('quoted line')])]),
    ]);

    expect(converter.fromAst(ast)).toBe('> quoted line');
  });

  it('renders an unordered list with nesting expressed by marker repetition', () => {
    const ast: RootNode = root([
      {
        type: 'list',
        ordered: false,
        children: [
          {
            type: 'listItem',
            children: [
              paragraph([text('top')]),
              {
                type: 'list',
                ordered: false,
                children: [
                  { type: 'listItem', children: [paragraph([text('nested')])] },
                ],
              },
            ],
          },
        ],
      },
    ]);

    expect(converter.fromAst(ast)).toBe('- top\n-- nested');
  });

  it('renders an ordered list using the + marker', () => {
    const ast: RootNode = root([
      {
        type: 'list',
        ordered: true,
        children: [
          { type: 'listItem', children: [paragraph([text('first')])] },
          { type: 'listItem', children: [paragraph([text('second')])] },
        ],
      },
    ]);

    expect(converter.fromAst(ast)).toBe('+ first\n+ second');
  });

  it('a header row suffixed with h becomes a table header', () => {
    const ast: RootNode = root([
      {
        type: 'table',
        children: [
          {
            type: 'tableRow',
            children: [
              { type: 'tableCell', children: [text('Name')] },
              { type: 'tableCell', children: [text('Value')] },
            ],
          },
          {
            type: 'tableRow',
            children: [
              { type: 'tableCell', children: [text('a')] },
              { type: 'tableCell', children: [text('1')] },
            ],
          },
        ],
      },
    ]);

    expect(converter.fromAst(ast)).toBe('|Name|Value|h\n|a|1|');
  });

  it('drops table column alignment on the way to notation, as a known lossy conversion', () => {
    const ast: RootNode = root([
      {
        type: 'table',
        align: ['left', 'right'],
        children: [
          {
            type: 'tableRow',
            children: [
              { type: 'tableCell', children: [text('Name')] },
              { type: 'tableCell', children: [text('Value')] },
            ],
          },
        ],
      },
    ]);

    // §9.6: alignment has no notation counterpart, so it is silently dropped.
    expect(converter.fromAst(ast)).not.toContain('left');
    expect(converter.fromAst(ast)).not.toContain('right');
    expect(converter.fromAst(ast)).toBe('|Name|Value|h');
  });

  it('inline code is flattened to text on notation projects', () => {
    const ast: RootNode = root([
      paragraph([{ type: 'inlineCode', value: 'const x' }]),
    ]);

    // §9.4/§9.6: Backlog notation has no inline-code syntax, so the value is
    // emitted unchanged — indistinguishable from plain text once rendered.
    expect(converter.fromAst(ast)).toBe('const x');
  });
});

describe('BacklogNotationConverter inbound (toAst)', () => {
  it('a code macro opened and closed on one line is one code block', () => {
    const ast = converter.toAst('{code:js}const x = 1;{/code}');

    expect(ast.children).toEqual([codeBlock('const x = 1;', 'js')]);
  });

  it('closes an unclosed code macro at end of input', () => {
    const ast = converter.toAst('{code}\nfirst\nsecond');

    expect(ast.children).toEqual([codeBlock('first\nsecond')]);
  });

  it('leaves code macro contents unconverted', () => {
    const ast = converter.toAst("{code}\n''not bold''\n{/code}");

    expect(ast.children).toEqual([codeBlock("''not bold''")]);
  });

  it('a quote macro becomes a blockquote', () => {
    const ast = converter.toAst('{quote}\nquoted text\n{/quote}');

    expect(ast.children).toEqual([
      blockquote([paragraph([text('quoted text')])]),
    ]);
  });

  it('translates > prefixed lines to a blockquote', () => {
    const ast = converter.toAst('> quoted text');

    expect(ast.children).toEqual([
      blockquote([paragraph([text('quoted text')])]),
    ]);
  });

  it('translates heading markers of every depth from one to six asterisks', () => {
    const ast = converter.toAst('****** Deepest');

    expect(ast.children).toEqual([
      { type: 'heading', depth: 6, children: [text('Deepest')] },
    ]);
  });

  it('translates ---- to a thematic break', () => {
    const ast = converter.toAst('----');

    expect(ast.children).toEqual([{ type: 'thematicBreak' }]);
  });

  it('translates a nested list back to mdast list nodes', () => {
    const ast = converter.toAst('- top\n-- nested');

    expect(ast.children).toEqual([
      {
        type: 'list',
        ordered: false,
        children: [
          {
            type: 'listItem',
            children: [
              paragraph([text('top')]),
              {
                type: 'list',
                ordered: false,
                children: [
                  { type: 'listItem', children: [paragraph([text('nested')])] },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('translates a + list to an ordered list', () => {
    const ast = converter.toAst('+ first\n+ second');

    expect(ast.children).toEqual([
      {
        type: 'list',
        ordered: true,
        children: [
          { type: 'listItem', children: [paragraph([text('first')])] },
          { type: 'listItem', children: [paragraph([text('second')])] },
        ],
      },
    ]);
  });

  it('a header row suffixed with h becomes a table header', () => {
    const ast = converter.toAst('|Name|Value|h\n|a|1|');

    expect(ast.children).toEqual([
      {
        type: 'table',
        children: [
          {
            type: 'tableRow',
            children: [
              { type: 'tableCell', children: [text('Name')] },
              { type: 'tableCell', children: [text('Value')] },
            ],
          },
          {
            type: 'tableRow',
            children: [
              { type: 'tableCell', children: [text('a')] },
              { type: 'tableCell', children: [text('1')] },
            ],
          },
        ],
      },
    ]);
  });

  it('strips the header-cell marker from a ~ prefixed cell', () => {
    const ast = converter.toAst('|~Header|data|h');

    expect(ast.children).toEqual([
      {
        type: 'table',
        children: [
          {
            type: 'tableRow',
            children: [
              { type: 'tableCell', children: [text('Header')] },
              { type: 'tableCell', children: [text('data')] },
            ],
          },
        ],
      },
    ]);
  });

  it('translates an image macro to an image node', () => {
    const ast = converter.toAst('#image(https://example.backlog.com/icon.png)');

    expect(ast.children).toEqual([
      paragraph([
        {
          type: 'image',
          url: 'https://example.backlog.com/icon.png',
          alt: null,
        },
      ]),
    ]);
  });

  it.each<{ notation: string; label: string; expected: Content[] }>([
    {
      notation: "'''italic'''",
      label: 'triple-quote emphasis',
      expected: [{ type: 'emphasis', children: [text('italic')] }],
    },
    {
      notation: "''bold''",
      label: 'double-quote strong',
      expected: [strong([text('bold')])],
    },
    {
      notation: '%%gone%%',
      label: 'percent strikethrough',
      expected: [strikethrough([text('gone')])],
    },
    {
      notation: '[[space>https://example.backlog.com]]',
      label: 'labeled link with >',
      expected: [link('https://example.backlog.com', [text('space')])],
    },
    {
      notation: '[[space:https://example.backlog.com]]',
      label: 'labeled link with :',
      expected: [link('https://example.backlog.com', [text('space')])],
    },
    {
      notation: '[[https://example.backlog.com]]',
      label: 'bare link',
      expected: [
        link('https://example.backlog.com', [
          text('https://example.backlog.com'),
        ]),
      ],
    },
    {
      notation: 'a&br;b',
      label: 'line break',
      expected: [text('a'), { type: 'break' }, text('b')],
    },
  ])('translates inline notation for $label', ({ notation, expected }) => {
    const ast = converter.toAst(notation);

    expect(ast.children).toEqual([paragraph(expected)]);
  });

  it.each([
    '&color(red) { text }',
    '#rev(1)',
    '#contents',
    '#attach(1)',
    '#thumbnail(url)',
    '[WikiPage]',
    'BLG-1',
  ])(
    'leaves %s as plain text, outside the §9.5 inbound construct list',
    (notation) => {
      const ast = converter.toAst(notation);

      expect(ast.children).toEqual([paragraph([text(notation)])]);
    }
  );
});
