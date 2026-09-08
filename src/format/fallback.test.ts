import { createMockLogger } from '@chat-adapter/tests';
import { paragraph, root, text } from 'chat';
import type { BaseFormatConverter, CardElement, Root as RootNode } from 'chat';
import { describe, expect, it, vi } from 'vitest';

import { converterFor, FallbackFormatConverter } from './fallback';
import { BacklogMarkdownConverter } from './markdown';
import { BacklogNotationConverter } from './notation';

const context = { host: 'example.backlog.com', projectId: 500 };

describe('FallbackFormatConverter', () => {
  it('a converter that throws on input degrades to a plain paragraph', () => {
    const throwingConverter = {
      toAst: vi.fn(() => {
        throw new Error('boom');
      }),
      fromAst: vi.fn(),
    } as unknown as BaseFormatConverter;
    const logger = createMockLogger();
    const fallback = new FallbackFormatConverter(
      throwingConverter,
      logger,
      context
    );

    const ast = fallback.toAst('raw text from Backlog');

    expect(ast).toEqual(root([paragraph([text('raw text from Backlog')])]));
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      'format conversion failed; falling back to plain text',
      context
    );
  });

  it('propagates a fromAst failure instead of posting fabricated output', () => {
    const throwingConverter = {
      toAst: vi.fn(),
      fromAst: vi.fn(() => {
        throw new Error('cannot render');
      }),
    } as unknown as BaseFormatConverter;
    const fallback = new FallbackFormatConverter(
      throwingConverter,
      createMockLogger(),
      context
    );
    const ast: RootNode = root([paragraph([text('hello')])]);

    expect(() => fallback.fromAst(ast)).toThrow('cannot render');
  });

  it('does not log or fall back when toAst succeeds', () => {
    const logger = createMockLogger();
    const fallback = new FallbackFormatConverter(
      new BacklogMarkdownConverter(),
      logger,
      context
    );

    fallback.toAst('**bold**');

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('converterFor', () => {
  it('selects the markdown converter for a markdown project', () => {
    const fallback = converterFor('markdown', createMockLogger(), context);

    // BacklogMarkdownConverter overrides renderPostable to pass {markdown}
    // through verbatim; a notation converter would not.
    expect(fallback.renderPostable({ markdown: '*x*   y' })).toBe('*x*   y');
  });

  it('selects the notation converter for a backlog project', () => {
    const fallback = converterFor('backlog', createMockLogger(), context);

    expect(fallback.fromAst(root([paragraph([text('plain')])]))).toBe('plain');
    expect(fallback.toAst("''bold''").children).toEqual(
      new BacklogNotationConverter().toAst("''bold''").children
    );
  });
});

describe('a card fallback under each formatting rule', () => {
  const IMAGE_URL = 'https://example.test/cover.png';

  /**
   * Every member of `CardChild` — `text | image | divider | actions |
   * section | fields | link | table | chart`. A fixture short of one cannot
   * catch that child being dropped, which is how `link` and `divider` went
   * missing once already.
   */
  const card: CardElement = {
    type: 'card',
    title: 'Release 1.4',
    subtitle: 'ready to ship',
    children: [
      { type: 'text', content: 'Two blockers left.' },
      { type: 'link', label: 'Open build', url: 'https://example.test/b/1' },
      { type: 'divider' },
      {
        type: 'section',
        children: [
          {
            type: 'fields',
            children: [
              { type: 'field', label: 'Owner', value: 'the release team' },
            ],
          },
        ],
      },
      { type: 'table', headers: ['Blocker'], rows: [['#12']] },
      {
        type: 'chart',
        title: 'Failures',
        chart: {
          type: 'bar',
          categories: ['w1'],
          series: [{ name: 'week', data: [{ label: 'w1', value: 3 }] }],
        },
      },
      { type: 'image', url: IMAGE_URL, alt: 'the release cover' },
      { type: 'actions', children: [] },
    ],
  };

  it('renders each child in GFM, bolding with asterisks', () => {
    const fallback = converterFor('markdown', createMockLogger(), context);

    expect(fallback.renderPostable(card)).toBe(
      [
        '**Release 1.4**',
        'ready to ship',
        'Two blockers left.',
        '[Open build](https://example.test/b/1)',
        '---',
        '**Owner**: the release team',
        'Blocker',
        '-------',
        '#12',
        'Failures',
        '   | week',
        '---|-----',
        'w1 | 3',
      ].join('\n')
    );
  });

  it("renders each child in notation, with '' and never an asterisk", () => {
    const fallback = converterFor('backlog', createMockLogger(), context);

    expect(fallback.renderPostable(card)).toBe(
      [
        "''Release 1.4''",
        'ready to ship',
        'Two blockers left.',
        '[[Open build>https://example.test/b/1]]',
        '----',
        "''Owner'': the release team",
        'Blocker',
        '-------',
        '#12',
        'Failures',
        '   | week',
        '---|-----',
        'w1 | 3',
      ].join('\n')
    );
  });

  it('drops an image under either rule, and that is not an oversight', () => {
    // `chat@4.39.0` has no `image` case in any of its three card walks — the
    // `BaseFormatConverter` method, the standalone `cardChildToFallbackText`
    // and `@chat-adapter/shared`'s, which delegates to the standalone one —
    // so nothing was lost by routing cards through the converter, and there
    // is no Backlog syntax this adapter is declining to emit.
    for (const rule of ['markdown', 'backlog'] as const) {
      const fallback = converterFor(rule, createMockLogger(), context);

      expect(fallback.renderPostable(card)).not.toContain(IMAGE_URL);
    }
  });
});
