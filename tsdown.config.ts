import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    // The real build: `index.js` plus the `index.js.map` that actually
    // resolves. `dts: false` here on purpose -- the second entry below owns
    // declarations, and why they're split is explained there.
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'es2022',
    dts: false,
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
  },
  {
    // A second, declaration-only build, not one config with
    // `dts: { sourcemap: false }`: rolldown-plugin-dts's fake-js
    // `outputOptions` hook sets a bundled `.d.ts`'s sourcemap flag to
    // `options.sourcemap || sourcemap` -- the build's own top-level
    // `sourcemap` OR'd with the dts plugin's resolved one
    // (rolldown-plugin-dts@0.27.14 dist/index.mjs ~409). A single config's
    // `sourcemap: true` above, needed for `index.js.map`, would win that OR
    // for the declaration pass too and orphan a `sourceMappingURL` comment
    // on `index.d.ts` regardless of `dts.sourcemap` (#107). `tsconfig.json`'s
    // `declarationMap` and the `tsgo` generator are not the switch here.
    // This build's own `sourcemap: false` removes that side of the OR;
    // `dts.sourcemap: false` still has to be explicit too, or it falls back
    // to `declarationMap: true` and reintroduces a real but still
    // unresolvable `.d.ts.map` (#95).
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'es2022',
    fixedExtension: false,
    dts: { emitDtsOnly: true, sourcemap: false },
    clean: false,
    sourcemap: false,
  },
]);
