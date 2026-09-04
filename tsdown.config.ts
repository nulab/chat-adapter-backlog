import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'es2022',
  dts: true,
  // tsdown turns this on by default whenever `platform` resolves to `node`,
  // which would publish `index.mjs`. Every `@chat-adapter/*` adapter ships a
  // plain `index.js`, and with `"type": "module"` the bare extension is
  // already unambiguous, so the fixed one only makes our paths differ.
  fixedExtension: false,
  clean: true,
  sourcemap: true,
  publint: true,
  attw: {
    // `strict` also requires the package to resolve from a `require()` call,
    // which no ESM-only package can satisfy on the Node versions that predate
    // `require(esm)`. `esm-only` is attw's own profile for that shape.
    profile: 'esm-only',
    // The default is `warn`, which reports problems without failing the build.
    level: 'error',
  },
});
