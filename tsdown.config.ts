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
    // A second, declaration-only build rather than one config with
    // `dts: { sourcemap: false }` (what #107 originally shipped, and had to
    // correct): rolldown-plugin-dts's fake-js `outputOptions` hook sets the
    // bundled `.d.ts`'s own sourcemap flag to `options.sourcemap || sourcemap`
    // -- the *build's* top-level `sourcemap` OR'd with the dts plugin's own
    // resolved one (rolldown-plugin-dts@0.27.14 dist/index.mjs ~409). In one
    // config, `sourcemap: true` above -- needed for `index.js.map` -- is that
    // same build's flag for the declaration pass too, so it always wins the
    // OR: `index.d.ts` gets a `//# sourceMappingURL=index.d.ts.map` comment
    // no matter what `dts.sourcemap` says, while `dts.sourcemap: false` only
    // ever suppressed the matching `.d.ts.map` file -- so the comment shipped
    // orphaned, pointing at a file the tarball never contains (#102).
    // TypeScript 7's `tsgo` generator and `tsconfig.json`'s `declarationMap`
    // are not part of this: disproved by running `tsgo` standalone with the
    // plugin's own flags, and by flipping each independently.
    //
    // A second build whose own top-level `sourcemap` is `false` removes that
    // side of the OR. `dts.sourcemap: false` here still has to be explicit,
    // too: left unset, it falls back to tsconfig.json's `declarationMap: true`
    // and the OR is true again -- this time matched by a real `.d.ts.map`,
    // but one still unresolvable in the tarball, since it points at
    // `../src/*.ts` and `files: ["dist"]` publishes no `src/` (#95, the
    // reason this repo drops the map at all).
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'es2022',
    fixedExtension: false,
    dts: { emitDtsOnly: true, sourcemap: false },
    clean: false,
    sourcemap: false,
  },
]);
