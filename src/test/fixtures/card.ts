import type { CardElement } from 'chat';

export const CARD_IMAGE_URL = 'https://example.test/cover.png';

/**
 * Every member of `CardChild`. A fixture short of one cannot catch that child
 * being dropped, which is how `link` and `divider` went missing once already.
 */
export const EVERY_CHILD_CARD: CardElement = {
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
    { type: 'image', url: CARD_IMAGE_URL, alt: 'the release cover' },
    { type: 'actions', children: [] },
  ],
};
