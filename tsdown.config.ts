import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'es2022',
  // Reads as redundant next to `sourcemap: true` below, and is not: tsdown
  // assembles the declaration pass's options without forwarding the top-level
  // flag, so `rolldown-plugin-dts` falls back to tsconfig.json's
  // `declarationMap` -- which is `true`. Saying it here is what drops
  // `index.d.ts.map`, and it turns the map and the `sourceMappingURL` off
  // together, so the `.d.ts` never points at a file that is not there. The
  // map is unresolvable in the tarball either way: it refers to
  // `../src/*.ts`, and `files: ["dist"]` publishes no `src/`.
  dts: { sourcemap: false },
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
