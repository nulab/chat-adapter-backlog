import { describe, expect, it } from 'vitest';

import { BacklogMarkdownConverter } from './markdown';
import { CARD_IMAGE_URL, EVERY_CHILD_CARD } from '../test/fixtures/card';

const converter = new BacklogMarkdownConverter();

/** Strips remark's source `position` metadata so ASTs from differently-sized
 * input strings can be compared on shape and content alone. */
function withoutPositions(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, val) => (key === 'position' ? undefined : val))
  );
}

describe('BacklogMarkdownConverter', () => {
  it('a markdown project renders GFM unchanged', () => {
    // fromAst is a real parse/stringify round trip (§9.3), so it may
    // normalize GFM's own style choices (list bullet, emphasis marker,
    // alignment-row dashes) without losing any content — verify that by
    // checking the AST is unchanged by a second round trip, not by
    // byte-for-byte input/output equality.
    const gfm =
      '# Title\n\n**bold** and _italic_ and ~~gone~~\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |';

    const ast = converter.toAst(gfm);
    const rendered = converter.fromAst(ast);

    expect(withoutPositions(converter.toAst(rendered))).toEqual(
      withoutPositions(ast)
    );
  });

  it('extracts plain text by stripping markdown formatting', () => {
    expect(converter.extractPlainText('**bold** text')).toBe('bold text');
  });

  describe('renderPostable', () => {
    it('passes a raw string through untouched', () => {
      expect(converter.renderPostable('**not bold**')).toBe('**not bold**');
    });

    it('passes an explicit raw payload through untouched', () => {
      expect(converter.renderPostable({ raw: '**not bold**' })).toBe(
        '**not bold**'
      );
    });

    it('renders a markdown payload verbatim, without a parse/stringify round trip', () => {
      // stringifyMarkdown would normalize `*bold*` to `_bold_` or similar;
      // verbatim passthrough proves no round trip happened (docs/specs/adapter.md §9.3).
      const markdown = '*bold*   with  extra   spaces';

      expect(converter.renderPostable({ markdown })).toBe(markdown);
    });

    it('renders every card child in GFM, bolding with asterisks', () => {
      expect(converter.renderPostable(EVERY_CHILD_CARD)).toBe(
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

    it('drops a card image, as every chat card walk does', () => {
      expect(converter.renderPostable(EVERY_CHILD_CARD)).not.toContain(
        CARD_IMAGE_URL
      );
    });

    it("posts a card's caller-supplied fallback text verbatim", () => {
      expect(
        converter.renderPostable({
          card: EVERY_CHILD_CARD,
          fallbackText: 'Release 1.4 is ready',
        })
      ).toBe('Release 1.4 is ready');
    });
  });
});
