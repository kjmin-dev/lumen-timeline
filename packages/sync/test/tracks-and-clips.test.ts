import assert from "node:assert/strict";
import test from "node:test";
import { commands } from "@lumen-timeline/core";
import type { Project } from "@lumen-timeline/core";
import { connectSession, createLink, createSequencer } from "@lumen-timeline/sync";

const base: Project = {
  schemaVersion: 1,
  duration: 1000,
  tracks: [
    { id: "voice", name: "Voice" },
    { id: "music", name: "Music" },
  ],
  clips: [{ id: "c1", trackId: "voice", kind: "audio", start: 0, duration: 100, contentIn: 0 }],
};

test("synced sessions converge across track CRUD, clip CRUD and region marker edits", async () => {
  const sequencer = createSequencer({ id: "reusable", project: base });
  const linkA = createLink();
  const linkB = createLink();
  const stopA = sequencer.connect(linkA.sequencer);
  const stopB = sequencer.connect(linkB.sequencer);
  const sessionA = connectSession({ id: "reusable", transport: linkA.editor });
  const sessionB = connectSession({ id: "reusable", transport: linkB.editor });
  const settle = () => {
    while (linkA.flush() + linkB.flush() > 0) {}
  };
  try {
    settle();
    const editorA = await sessionA.ready;
    const editorB = await sessionB.ready;

    // Session A adds a track + clip + region marker in one transaction.
    const r1 = editorA.dispatch([
      commands.addTrack({ track: { id: "sfx", name: "SFX", color: "#ffaa44" } }),
      commands.addClip({
        clip: { id: "boom", trackId: "sfx", kind: "audio", start: 200, duration: 150 },
      }),
      commands.addMarker({ id: "intro", start: 0, duration: 250, label: "Intro" }),
    ]);
    assert.ok(r1.ok);
    settle();

    // Session B updates music mix settings and clip metadata.
    const r2 = editorB.dispatch([
      commands.updateTrack({ trackId: "music", mute: true, gain: 0.3 }),
      commands.updateClip({ clipId: "c1", name: "Opening" }),
    ]);
    assert.ok(r2.ok);
    settle();

    assert.deepEqual(editorA.getSnapshot(), sequencer.getSnapshot());
    assert.deepEqual(editorB.getSnapshot(), sequencer.getSnapshot());
    assert.deepEqual(
      editorB.getSnapshot().tracks.map((t) => [t.id, t.mute ?? false]),
      [
        ["voice", false],
        ["music", true],
        ["sfx", false],
      ],
    );
    assert.equal(editorB.getSnapshot().markers?.[0]?.duration, 250);

    // Session B removes the newly added track atomically with its clips, then undoes.
    assert.ok(editorB.dispatch(commands.removeTrack({ trackId: "sfx", removeClips: true })).ok);
    settle();
    assert.deepEqual(editorA.getSnapshot(), editorB.getSnapshot());
    assert.equal(editorA.getSnapshot().tracks.length, 2);

    assert.ok(editorB.history.undo().ok);
    settle();
    assert.deepEqual(editorA.getSnapshot(), editorB.getSnapshot());
    assert.equal(editorA.getSnapshot().tracks.length, 3);
    assert.ok(editorA.getSnapshot().clips.find((c) => c.id === "boom"));
  } finally {
    sessionA.dispose();
    sessionB.dispose();
    stopA();
    stopB();
    sequencer.dispose();
  }
});
