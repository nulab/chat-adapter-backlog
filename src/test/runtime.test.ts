import { describe, expect, it } from 'vite-plus/test';

// Only the ci.yml test matrix sets this. `vp` launches the test runner itself,
// so the Node a shell step gets is not evidence of the Node the tests ran on.
const expectedMajor = process.env.EXPECTED_NODE_MAJOR;

describe.skipIf(expectedMajor === undefined)('the test matrix', () => {
  it('runs the tests on the Node major the job asked for', () => {
    expect(process.versions.node.split('.')[0]).toBe(expectedMajor);
  });
});
