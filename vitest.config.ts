import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Registers the `toHavePosted` / `toHaveDispatched` / ... matchers the
    // `@chat-adapter/tests` contract suites assert with; without it those
    // suites fail on an unknown matcher rather than on adapter behaviour.
    setupFiles: ['@chat-adapter/tests/setup'],
  },
});
