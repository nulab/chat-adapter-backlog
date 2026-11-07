import { describe, expect, it } from 'vite-plus/test';
import type { CardElement } from 'chat';

import { converter } from './format';

function cardWithLink(label: string, url: string): CardElement {
  return { type: 'card', children: [{ type: 'link', label, url }] };
}

describe('converter.renderPostable', () => {
  it('posts a markdown payload as written, neither escaped nor restyled', () => {
    const markdown = '*bold*   with  extra   spaces and a literal [[';

    expect(converter.renderPostable({ markdown })).toBe(markdown);
  });

  it('renders a card link as a Markdown link, keeping its URL', () => {
    expect(
      converter.renderPostable(
        cardWithLink('Open build', 'https://example.test/b/1')
      )
    ).toBe('[Open build](https://example.test/b/1)');
  });

  it('renders a card link with no distinct label as the bare URL', () => {
    expect(
      converter.renderPostable(
        cardWithLink('https://example.test/b/1', 'https://example.test/b/1')
      )
    ).toBe('https://example.test/b/1');
  });
});
