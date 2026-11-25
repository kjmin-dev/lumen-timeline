# Validate the first release

**Status.** Delivered in one pull request, which started from 2990666, after #65. [Milestone 6](../../ROADMAP.md#milestones) · [Domain extensions and persistence](../design.md#domain-extensions-and-persistence)

**User outcome.** A team can ship on the first release. Its podcast editor, built on the public packages like the dubbing studio, mixes two speakers who talk over each other with music, chapters and a level per clip. Its saved projects open in later releases, and a later release's projects open read-only in this one instead of failing or being misread. A project passes unharmed through an editor that lacks one of its plugins. A host attaches the timeline to the player it already has.

## Starting point

- **One schema, no versions inside it.** `openProject` accepts `schemaVersion: 1` only and throws `unsupported-schema` for anything else, so a project from a later release cannot even be looked at. A plugin declares a `version`, but nothing records which version wrote a project's payloads, so a plugin cannot tell an old payload from a new one.
- **Missing plugins.** Payloads without a plugin are kept, and splitting a clip that carries one fails with `split-policy-required`. This held already, but no test took a project through an editor without its plugin and back.
- **Gain per track only.** `track.gain` scales a track's spans. A clip has no level of its own, so a podcast cannot even out one quiet paragraph, and the waveform shows the source's level, not what plays.
- **The podcast example.** The docs site's podcast screen has two exclusive voice tracks, a theme on a music track and chapters as markers, but its speakers never overlap, it has no level control, and no test drives it beyond removing filler words.
- **External players.** The transport contract is documented as something a host can adapt, and the video transport follows its element's events, but no page attaches a timeline to a player the page did not build, and no guide says how.
- **Plugin documentation.** The editing guide describes `validate` and `onSplit`. The design document's plugin example uses a `clipFields` API that does not exist.

## Schema 2

A field whose absence an older reader would misread changes the schema. Two such fields come with this milestone, so the project schema moves to 2:

- **`clip.gain`**, a linear level from 0 to `MAX_CLIP_GAIN` (16, about +24 dB), multiplied with the track's gain in every planned span. A schema-1 reader would keep it as an unknown field and play the clip at unity. A snapshot omits a gain of 1, as it omits a rate of 1. A split gives both halves the gain. `invalid-gain` rejects one out of range.
- **`project.extensionVersions`**, the version of the plugin that wrote each namespace's payloads, sorted, without version 1. A schema-1 reader would hand a later version's payloads to its own plugin.

`SCHEMA_VERSION` is 2. Migration steps live in a table keyed by the version they start from; 1 to 2 changes the version alone, because a schema-1 project carries neither field.

## Migration

`createEditor` and the new `migrateProject(project, { plugins })` share one path:

1. Check the plugins, then read `schemaVersion`. A version above `SCHEMA_VERSION` opens read-only with no migration and no plugins.
2. Run each schema step on a frozen copy. The input is never changed.
3. For each plugin, compare its version with the one the project records for its namespace. Equal: nothing. Lower in the project: run the plugin's `migrate({ target, id, value, from })` on every payload of the namespace, then record the plugin's version. Higher in the project: leave the namespace unread.
4. Open the result, which validates every payload with the plugins that read it.

`migrateProject` returns the validated snapshot with `from`, the upgraded namespaces, the unread ones, `readOnly` and `upgraded`, so a host can back up the original before saving over it. A project that needs nothing returns the input itself to `createEditor`, so an editor's own snapshot still opens without a parse.

- **Read-only.** A later schema that reads under schema 2's rules opens with `editor.readOnly === "newer-schema"`. Dispatch, undo, redo, preview and replacement fail with `read-only` and that target, before any gate. The snapshot keeps the schema version and every field, so saving it loses nothing. The timeline view's `readOnly` defaults to the editor's. One that does not read fails with `unsupported-schema`.
- **Unread namespaces.** Kept as written and not validated, as with no plugin at all. A split of a clip carrying one fails with `split-policy-required`, naming the later version. The recorded version is never lowered.
- **Replacement.** `editor.replace` migrates its input with the editor's plugins. One that would need a different set of unread namespaces, or would be read-only, fails with `unsupported-schema`.

## Clip gain in the packages

- **Core.** `addClip` and `updateClip` take `gain`; `null` or 1 removes it. `planAudio` multiplies it into the span's gain and plans nothing for a clip at gain 0. `clipFieldChanges` reports it under `fields.gain`.
- **Media.** A span's gain already reaches the voice's gain node, and a changed gain books the voice again, as a track's gain does.
- **Timeline.** The view multiplies a clip's peaks by its gain before drawing, clipping at full height, so a clip turned down draws smaller. A provider may add `scale(peak)`, applied after the gain; `decibelScale(floor)` maps peaks to decibels. The docs examples' decibel wrapper becomes that scale, so their waveforms show each clip's real level.

## The podcast editor

- **Overlapping voices.** The guest's answer starts 0.55 s before the host's question ends, on the guest's own track, so both play.
- **Cuts across speakers.** A cut takes its time from every voice track, widened until no word on any track is cut in half, then closes the gap. The selection shows every word the cut will take, the other speaker's included. Filler removal uses the same rule.
- **Words under the playhead.** Every speaker's current word is marked, two where they overlap.
- **Level.** A control in the toolbar shows and sets the selected clips' gain in decibels, −24 to +12 dB in half-decibel steps. A drag dispatches each position outside history, so it is heard as it moves, then restores the start and records the final value: one undo step. Clicking a speaker's name selects that paragraph's clips on the timeline. The control is the only place the level is shown as a number; the waveform shows it as a size.
- **Test handle.** Each example session sets `window.lumenExample` to its editor and transport, public objects, so a trace reads the result of what it did on the screen.

## External players

`docs/external-players.md` covers two cases, each in `examples/vanilla/external.html`:

- **A player that owns its element.** Hand the element to `createVideoTransport` with its frame rate. The player's controls drive the element and the transport follows its events; the ruler sets `currentTime`. The project's audio is booked against the element's clock.
- **An embed with no element to reach.** `embed-transport.mjs`, printed in full in the guide, adapts a player API of `getCurrentTime`, `isPlaying`, `getPlaybackRate`, `play`, `pause`, `seekTo` and a state-change event. While the player plays it notifies every frame from the last report run on at the playback rate, holds rather than stepping back for a late report, and presents a seek's target tick once the player reports it. A stand-in embed in `embed-player.mjs` reports four times a second and answers after 60 ms.

## Checks

| Check                                   | What it shows                                                                                                                                                                                                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/test/migrate.test.ts`    | A schema-1 fixture with plugin version 1 migrates to the golden schema-2 fixture, which opens unchanged. It round-trips through editing, saving and reopening, through an editor without its plugin, and past a later plugin version. A later schema is read-only. Clip gain end to end. |
| `packages/timeline/test/layout.test.ts` | Waveform bars scale with clip gain and clip at full height; the scale sees the gained peak. `decibelScale` maps and rejects as documented.                                                                                                                                               |
| `apps/docs/test/podcast.test.mjs`       | Both example editors import public entry points only. In the built podcast screen: overlapping voices planned and booked, the theme at its track's gain, a chapter renamed, a level drag heard and undone in one step, a cut through the overlap taking whole words from both.           |
| `npm run verify:external`               | A timeline follows a player's own play, scrub and pause, seeks its element and books the project's audio; another follows an embed every frame within 50 ms and presents its seeks exactly. Chromium in CI, Firefox and WebKit by argument.                                              |

## Pull requests

| PR  | Scope                                                                                                                                                                           | Gate                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| M6  | Schema 2, migrations, read-only later schemas, clip gain through core, media and timeline, the podcast editor, the external-player guide and page, plugin and persistence guide | `npm run check`, `npm run check:docs` with the podcast test, `verify:external` in three engines, and every existing browser trace unchanged. |
