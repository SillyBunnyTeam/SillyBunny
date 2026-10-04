**SillyBunny version 1.6.2 has released**
This release tightens Bun/client-disconnect cancellation, mobile API and model picking, mobile shell scaling, reasoning token accounting, and Server Admin branch reporting for the 1.6 line.

**Detailed Changelog**
- Bun-safe request cancellation now aborts upstream generation, image, and provider work when the request, response, or socket disconnects without logging expected disconnects as provider failures.
- Streaming disconnect cleanup now handles Bun raw abort reasons cleanly.
- Thought and reasoning token totals now use the higher of provider-reported and locally counted reasoning tokens.
- Server Admin now shows the tracked branch when Git reports an unresolved local branch.
- Mobile shell rail buttons now scale with the Mobile Button Size slider.
- Mobile-friendly inline and native picker controls improve OpenRouter model, sort, provider, quantization, middle-out, and searchable model ID selection on touch or narrow screens.
- Character drawer routing, header copy, empty editor copy, and import intro text are clearer across mobile and desktop panel layouts.
- Navigation defaults return to a labeled horizontal layout, while vertical icon-only navigation remains opt-in.
- Side rails can derive shortcuts from all registered Workspace and Customize tabs when rail shortcuts are enabled.

**How to update**
- Built-in updater: open Customize > Server and update from there.
- Git clone: run `git pull`.
- Launcher users: close and reopen Start.bat, Start.command, or start.sh.
- ZIP users: grab the new release directly.
