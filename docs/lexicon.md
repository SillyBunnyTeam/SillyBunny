# The SillyBunny Lexicon

The SillyBunny Lexicon is the lorebook that teaches the bundled assistants, Assistant Reisen and Assistant Tewi, how SillyBunny works. It ships as `default/content/SillyBunny Lexicon.json`, and both assistant cards link it through `data.extensions.world`. Whenever a change adds, renames, moves or removes something a user can see or do, the Lexicon must change with it, or the assistants will give outdated help.

## When to update it

Update the Lexicon in the same change when you:

- add, rename, move or remove a feature, setting, menu entry, window or Help topic;
- change how a feature behaves in a way a user would notice, or the steps to reach it;
- change install, update or launcher behaviour, supported providers, or anything else the entries describe.

Pure refactors, styling and bug fixes that restore documented behaviour need no change.

## How it is built

- **Entries.** There are 80 entries, `A0` to `A79`. An entry's `comment` starts with its id (`A13 Temperature`), and its `uid` is the same number.
- **The overview.** `A0` is the only constant entry. It describes SillyBunny as a whole: what it is, the shell, and the two chat modes. Every other entry is triggered by its keys.
- **Keys.** Keys are specific phrases a user would type ("temperature setting", "reply randomness"), never a common word of their own ("chat", "model", "preset"), which would pull the entry into most prompts. The test keeps a list of words that are not allowed as keys.
- **Help topics.** `extensions.sb_topic` lists the ids of the Help topics an entry covers (`public/scripts/sillybunny-help/topics.js`). Every Help topic must be covered by at least one entry, and an entry may only name topics that exist.
- **Both chat modes read it.** Conversation mode scans the same lorebook, with limits that every entry must respect:
  - `position` is `0` or `1` (before or after the character definitions), the only places Conversation reads;
  - `sticky`, `cooldown` and `delay` stay `0`, because Conversation keeps no timed effects between replies;
  - no macros (`{{…}}`), because Conversation resolves them against whichever character is open in Roleplay.
- **Voice.** Entries are plain, factual and neutral, with no character voice, because both assistants and any card that links the Lexicon read the same text. Name controls as they appear in the interface, and give the path to reach them with "▸" between the steps ("Backend ▸ Connections").
- **Removed things.** Never mention features or content that SillyBunny no longer ships. The test keeps a list of removed names.

## Making a change

1. Edit the entry, or add one with the next free id (its `uid` and `comment` id must match), its keys, its `sb_topic` ids, and position `0` or `1`, and raise `INVENTORY_SIZE` in the test. The ids must run from `A0` without gaps, so when a feature goes away, rewrite its entry for whatever replaced it instead of deleting it. If an entry must be deleted, renumber the ones after it and lower `INVENTORY_SIZE`.
2. If you added or renamed a Help topic, give an entry its id in `sb_topic`.
3. If you removed a feature, add its name to `REMOVED_NAMES` in the test so it cannot come back.
4. Rebuild the managed manifest:
   - **After the Lexicon has shipped in a release:** run `node scripts/build-managed-manifest.js default/content`. The Lexicon's version goes up by one and its old fingerprint is kept, so users whose copy is unedited get the new one on the next start (their old copy is backed up), and users who edited theirs keep it and see it as modified, with Restore.
5. Run the tests below.

## Tests

From `tests/`:

- `npm run test:unit -- unit/sillybunny-lexicon-coverage.test.js`: the inventory, Help topic coverage, removed names, the single constant entry, keys, positions, timers, macros and common-word keys.
- `npm run test:unit -- unit/sillybunny-shipped-managed-content.test.js`: the manifest matches what the build script writes, and every managed item is indexed.
- `npm run test:unit -- world-info-scan-target.test.js`: the Lexicon reaches the Conversation scan through a character that links it, and each keyword entry is triggered by its first key.

To check the wording with a real model, open Assistant Reisen or Assistant Tewi in both Roleplay and Conversation and ask about the feature you changed. The answer should follow the entry.
