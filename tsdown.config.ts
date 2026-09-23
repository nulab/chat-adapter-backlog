import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'es2022',
  // Reads as redundant next to `sourcemap: true` below, and is not: tsdown
  // assembles the declaration pass's options without forwarding the top-level
  // flag, so `rolldown-plugin-dts` falls back to tsconfig.json's
  // `declarationMap` -- which is `true`. Saying it here is what drops
  // `index.d.ts.map` -- unresolvable in the tarball either way, since it
  // refers to `../src/*.ts` and `files: ["dist"]` publishes no `src/`.
  //
  // It does not, on its own, drop the `sourceMappingURL` comment that would
  // point at that map: with TypeScript 7 installed, rolldown-plugin-dts
  // picks its `tsgo` generator, which shells out to the `tsgo` binary
  // against tsconfig.json's own `declarationMap: true` and is only ever
  // told to add `--declarationMap`, never to negate it, so the comment
  // survives into `index.d.ts` regardless of this option (#102, measured
  // with tsdown 0.22.14 and 0.23.x). scripts/strip-orphaned-sourcemap-urls.mjs
  // removes it after tsdown runs, and scripts/check-published-types.mjs
  // fails the build if it ever comes back.
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
