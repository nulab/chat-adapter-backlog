import { describe, expect, it } from 'vitest';

import { ADAPTER_ID } from './index';

describe('package entry point', () => {
  it('exposes the identifier under which the adapter registers itself', () => {
    expect(ADAPTER_ID).toBe('backlog');
  });
});
