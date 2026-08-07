# Vendored Eruda Patches

`eruda.js` is built from Eruda 3.4.3 (`50cc399d3b5ff6135515a95e1c97f49eef32745d`) with Chobitsu 1.8.6 (`819b9d01ce56c1cea9491ead50b021ec02d0d5c0`). The checked-in bundle SHA-256 is `caff41e30297b7893be28c5365cc2e74152644becf91ebd9aaead454498bc00f`.

The local patch makes teardown safe for a long-lived SillyBunny page:

- Network capture is lifecycle-gated, retains at most 100 requests, clears its redacted body markers on disable, and ignores in-flight work from older activations.
- Captured HTTP(S) and WS(S) URLs retain only protocol and host, preserve `/` only for a root pathname, replace every other pathname with `/[redacted]`, replace any query with `?[redacted]`, and omit userinfo and fragments. URL parsing uses cleared per-call anchors rather than module-global state.
- Header capture is fail-closed: only canonical `Content-Type` and `Content-Length` names remain. Common media types use fixed allowlisted values, other known media families use fixed redacted markers, and content lengths are bounded numeric metadata. Other headers are omitted, and Eruda does not synthesize a `User-Agent` or referrer.
- Cookie metadata, request and response bodies, and WebSocket payloads are never read into capture storage. The Network panel receives fixed `[redacted]` body markers, and response sizes use `Content-Length` only.
- Overlay inspect listeners and active drag/resize listeners are removed during teardown.
- DOM observation is disabled and closed shadow roots stay in a private `WeakMap`.
- Eruda removes all Network listeners, bounds its request panel, and preserves console wrappers installed by other code.
- The browser build exports to `globalThis.__sillyBunnyDebuggerEruda` without creating `globalThis.eruda`.
- The Info tool shows only the current page origin rather than its path, query, fragment, or URL credentials.
- The floating entry control is a themed, keyboard-operable `Open debugger` button with a visible focus indicator that does not change opacity, a 44x44 CSS-pixel target, and default/drag bounds that follow the visual viewport and all four safe-area insets.
- Reduced motion disables EntryBtn and debugger-panel transitions and makes panel show/hide immediate. Pending panel transition timers are cleared during teardown.
- Initialization and destruction are idempotent and continue cleanup after partial failures.

The exact source changes are checked in as `patches/eruda-3.4.3.patch` and `patches/chobitsu-1.8.6.patch`. To rebuild:

1. Check out the commits above and apply each zero-context patch with `git apply --unidiff-zero`.
2. Run `npm install`, `npm run lint`, and `npx tsc` in Chobitsu.
3. Run `npm install` in Eruda, then copy Chobitsu's generated `dist/cjs/domains/{DOM,Network,Overlay}.js` and `dist/cjs/lib/{nodeManager,request}.js` over the same paths in Eruda's installed `chobitsu` package.
4. Eruda 3.4.3 omits one build dependency, so install the version used here with `npm install --no-save terser-webpack-plugin@5.6.1`.
5. Run `npm run lint`, both `build/webpack.prod.js` and `build/webpack.polyfill.js`, `node build/build.js`, and `npx es-check es5 dist/eruda.js dist/eruda-polyfill.js`.
6. Copy `dist/eruda.js` here and verify its SHA-256 against the value above.

Do not replace this file with the stock npm bundle unless these guarantees and the browser teardown tests are preserved.
