# Vendored Eruda Patches

`eruda.js` is built from Eruda 3.4.3 (`50cc399d3b5ff6135515a95e1c97f49eef32745d`) with Chobitsu 1.8.6 (`819b9d01ce56c1cea9491ead50b021ec02d0d5c0`). The checked-in bundle SHA-256 is `499ea431a3ed48a008efc871c8b7a49e61124b85d54fd91c4562f98b581424a3`.

The local patch makes teardown safe for a long-lived SillyBunny page:

- Network capture is lifecycle-gated, retains at most 100 requests and 256 KiB per body, clears bodies on disable, and ignores in-flight work from older activations.
- Overlay inspect listeners and active drag/resize listeners are removed during teardown.
- DOM observation is disabled and closed shadow roots stay in a private `WeakMap`.
- Eruda removes all Network listeners, bounds its request panel, and preserves console wrappers installed by other code.
- Initialization and destruction are idempotent and continue cleanup after partial failures.

The exact source changes are checked in as `patches/eruda-3.4.3.patch` and `patches/chobitsu-1.8.6.patch`. To rebuild:

1. Check out the commits above and apply each zero-context patch with `git apply --unidiff-zero`.
2. Run `npm install`, `npm run lint`, and `npx tsc` in Chobitsu.
3. Run `npm install` in Eruda, then copy Chobitsu's generated `dist/cjs/domains/{DOM,Network,Overlay}.js` and `dist/cjs/lib/{nodeManager,request}.js` over the same paths in Eruda's installed `chobitsu` package.
4. Eruda 3.4.3 omits one build dependency, so install the version used here with `npm install --no-save terser-webpack-plugin@5.6.1`.
5. Run `npm run lint`, both `build/webpack.prod.js` and `build/webpack.polyfill.js`, `node build/build.js`, and `npx es-check es5 dist/eruda.js dist/eruda-polyfill.js`.
6. Copy `dist/eruda.js` here and verify its SHA-256 against the value above.

Do not replace this file with the stock npm bundle unless these guarantees and the browser teardown tests are preserved.
