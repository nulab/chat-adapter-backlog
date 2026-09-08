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
import type { Content, List, ListItem, Root as RootNode } from 'chat';
import { describe, expect, it } from 'vitest';

import { BacklogNotationConverter } from './notation';

function heading1(children: Content[]): Content {
  // `chat` does not export a `heading` builder, so tests construct the node
  // literally — this mirrors what `BacklogNotationConverter.toAst` produces.
  return { type: 'heading', depth: 1, children } as Content;
}

// `chat` exports no list builders either, and the tests below are about depth,
// so the nesting reads better as calls than as node literals.
function listItem(children: ListItem['children']): ListItem {
  return { type: 'listItem', children };
}

function textItem(value: string): ListItem {
  return listItem([paragraph([text(value)])]);
}

function list(ordered: boolean, children: ListItem[]): List {
  return { type: 'list', ordered, children };
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

  it('closes an unclosed quote macro at end of input', () => {
    const ast = converter.toAst('{quote}\nquoted text');

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

  it('keeps the deeper first item when a later marker is shallower', () => {
    const ast = converter.toAst('--- deep first\n- shallow');

    expect(ast.children).toEqual([
      list(false, [textItem('deep first')]),
      list(false, [textItem('shallow')]),
    ]);
  });

  it('leaves markers at two depths as two lists, not one list of two items', () => {
    const ast = converter.toAst('-- indented\n- back');

    // §9.5: joining them would read better here and cost the depth in every
    // other case, so a shallower marker always starts its own list. Do not
    // "simplify" this to one two-item list.
    expect(ast.children).toEqual([
      list(false, [textItem('indented')]),
      list(false, [textItem('back')]),
    ]);
  });

  it('nests a marker between two open depths as a second list in the same item', () => {
    const ast = converter.toAst('- a\n--- c\n-- b');

    expect(ast.children).toEqual([
      list(false, [
        listItem([
          paragraph([text('a')]),
          list(false, [textItem('c')]),
          list(false, [textItem('b')]),
        ]),
      ]),
    ]);
  });

  it('closes the nested list when the marker returns to the outer depth', () => {
    const ast = converter.toAst('- one\n-- nested\n- two');

    expect(ast.children).toEqual([
      list(false, [
        listItem([paragraph([text('one')]), list(false, [textItem('nested')])]),
        textItem('two'),
      ]),
    ]);
  });

  it('opens a single nested list for a depth jump of more than one', () => {
    const ast = converter.toAst('- one\n--- three');

    expect(ast.children).toEqual([
      list(false, [
        listItem([paragraph([text('one')]), list(false, [textItem('three')])]),
      ]),
    ]);
  });

  it('starts a second list when the marker changes kind at the same depth', () => {
    const ast = converter.toAst('+ one\n- two');

    expect(ast.children).toEqual([
      list(true, [textItem('one')]),
      list(false, [textItem('two')]),
    ]);
  });

  it('nests a deeper marker of the other kind as an ordered child list', () => {
    const ast = converter.toAst('- outer\n++ inner');

    expect(ast.children).toEqual([
      list(false, [
        listItem([paragraph([text('outer')]), list(true, [textItem('inner')])]),
      ]),
    ]);
  });

  it('a marker followed by nothing ends the list and stays a paragraph', () => {
    const ast = converter.toAst('- one\n-\n- two');

    expect(ast.children).toEqual([
      list(false, [textItem('one')]),
      paragraph([text('-')]),
      list(false, [textItem('two')]),
    ]);
  });

  it('a marker followed by only whitespace ends the list and stays a paragraph', () => {
    // The middle line is `-` and one space. A marker carrying no text is not
    // an item, so this reads like the bare `-` above rather than becoming an
    // item whose only child is an empty paragraph (§9.5).
    const ast = converter.toAst('- one\n- \n- two');

    expect(ast.children).toEqual([
      list(false, [textItem('one')]),
      paragraph([text('- ')]),
      list(false, [textItem('two')]),
    ]);
  });

  it('a thematic break ends the list whether or not it trails a space', () => {
    // `----` and `----` plus one space. Inside a list the second used to match
    // as a marker of depth four with no text, so an invisible character decided
    // between a thematic break and a nested empty item (§9.5).
    const withoutSpace = converter.toAst('- one\n----\n- two');
    const withSpace = converter.toAst('- one\n---- \n- two');

    expect(withoutSpace.children).toEqual([
      list(false, [textItem('one')]),
      { type: 'thematicBreak' },
      list(false, [textItem('two')]),
    ]);
    expect(withSpace.children).toEqual(withoutSpace.children);
  });

  it('four hyphens followed by text are a list item, not a thematic break', () => {
    // The emptiness rule is about the missing text, not about the `----` run.
    // A `list` is all the depth mdast records, so the marker's own depth of
    // four is only visible where it nests.
    expect(converter.toAst('---- four').children).toEqual([
      list(false, [textItem('four')]),
    ]);
    expect(converter.toAst('- one\n---- four').children).toEqual([
      list(false, [
        listItem([paragraph([text('one')]), list(false, [textItem('four')])]),
      ]),
    ]);
  });

  it('a marker with no text ends the outer list too, not just its own depth', () => {
    // The middle line is `--` and one space. Nothing absorbs a line that is no
    // list item, so the run above it ends with it and `two` opens a list of its
    // own instead of nesting under `one` (§9.5).
    const ast = converter.toAst('- one\n-- \n-- two');

    expect(ast.children).toEqual([
      list(false, [textItem('one')]),
      paragraph([text('-- ')]),
      list(false, [textItem('two')]),
    ]);
  });

  it('the whitespace between a marker and its text is taken greedily', () => {
    // So an item's text never begins with whitespace, and a marker followed by
    // nothing but spaces has no text at all (§9.5).
    expect(converter.toAst('-   one').children).toEqual([
      list(false, [textItem('one')]),
    ]);
    expect(converter.toAst('-   ').children).toEqual([
      paragraph([text('-   ')]),
    ]);
  });

  it('a CRLF line ending neither ends the list nor reaches the item text', () => {
    const ast = converter.toAst('- one\r\n-- two');

    expect(ast.children).toEqual([
      list(false, [
        listItem([paragraph([text('one')]), list(false, [textItem('two')])]),
      ]),
    ]);
  });

  it('takes the item text from after a tab separating it from the marker', () => {
    const ast = converter.toAst('-\tone');

    expect(ast.children).toEqual([list(false, [textItem('one')])]);
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

  it('splits a row at every |, a link url included', () => {
    const ast = converter.toAst('|[[a>https://example.backlog.com/?x=1|y]]|b|');

    // §9.5 gives `|` no escape, so a cell ends at the next one wherever it
    // falls; the halves of the split link are left as the text they now are.
    expect(ast.children).toEqual([
      {
        type: 'table',
        children: [
          {
            type: 'tableRow',
            children: [
              {
                type: 'tableCell',
                children: [text('[[a>https://example.backlog.com/?x=1')],
              },
              { type: 'tableCell', children: [text('y]]')] },
              { type: 'tableCell', children: [text('b')] },
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

  it('nests bold inside italic', () => {
    const ast = converter.toAst("'''italic ''bold'' italic'''");

    expect(ast.children).toEqual([
      paragraph([
        {
          type: 'emphasis',
          children: [text('italic '), strong([text('bold')]), text(' italic')],
        },
      ]),
    ]);
  });

  it('ends bold at the quote pair that opens a nested italic', () => {
    const ast = converter.toAst("''bold '''both''' bold''");

    // The longer marker only wins where it opens a span, not where it closes
    // one: `''` ends at the next `''`, which here is the first two quotes of
    // the inner `'''`. Pinned so the loss stays visible — italic outside bold
    // (above) is the nesting that survives.
    expect(ast.children).toEqual([
      paragraph([
        strong([text('bold ')]),
        text("'both"),
        strong([text("' bold")]),
      ]),
    ]);
  });

  it.each(["''bold", "'''italic", '%%gone', '[[https://example.backlog.com'])(
    'leaves the unterminated marker in %s as plain text',
    (notation) => {
      const ast = converter.toAst(notation);

      expect(ast.children).toEqual([paragraph([text(notation)])]);
    }
  );

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
