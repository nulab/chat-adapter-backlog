import { describe, expect, it } from 'vite-plus/test';

// Only the ci.yml test matrix sets this. `vp` has Node-management logic of its
// own, so the Node that started it is not evidence of the Node the tests ran
// on.
const expectedMajor = process.env.EXPECTED_NODE_MAJOR;

describe.skipIf(expectedMajor === undefined)('the test matrix', () => {
  it('runs the tests on the Node major the job asked for', () => {
    expect(process.versions.node.split('.')[0]).toBe(expectedMajor);
  });

  it('runs the tests on a Node that was not linked into node_modules', () => {
    expect(process.execPath).not.toContain('node_modules');
  });
});
