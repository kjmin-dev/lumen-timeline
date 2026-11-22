# Delivery plans

Each plan states a user outcome, the commit it starts from, the pull requests that deliver it and the gates each one must pass before merging. A delivered plan stays as the record of those decisions, so its starting point and file links describe the repository before the work began. The guides linked from the [README](../../README.md) describe current behavior.

| Plan                                                       | Outcome                                                                                      | Pull requests      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------ |
| [Playback planning](playback-planning.md)                  | Revision-pinned reads and a pure audio planner keep unaffected audio playing across edits    | #5, #6             |
| [First interactive vanilla timeline](vanilla-timeline.md)  | Canvas 2D selection, seeking, and pointer and keyboard edits with undo                       | #7, #8             |
| [Audio-only playback](audio-only-transport.md)             | A shared voice scheduler, an audio-output transport and a video-free workspace               | #9, #10            |
| [Core in TypeScript](typescript-core.md)                   | oxfmt, Oxlint, a tsrs build, typed tests and a locked API surface                            | #11–#15            |
| [Media and timeline in TypeScript](typescript-packages.md) | An assertion-free core, then media and timeline in the same TypeScript                       | #16–#18            |
| [Saved timeline markers](timeline-markers.md)              | Marker commands, history and reads, drawn and navigated in the timeline                      | #19, #20           |
| [Close milestone 2](milestone-2-closeout.md)               | Marker crossings during playback and one trace over the milestone 2 exit criteria            | #22, #23           |
| [Candidate takes per clip](clip-takes.md)                  | Shared, reusable candidate takes with undoable choice, guarded async results and previews    | #24, #28, #30, #31 |
| [Edits that replay elsewhere](replayable-edits.md)         | Session-scoped IDs, commits that replay in another editor, and clip records by ID            | #25, #26           |
| [Share one project between editors](shared-sessions.md)    | Optional sharing with no server required: any participant orders commands                    | #29, #35–#38       |
| [Render a large timeline](scale-rendering.md)              | Waveform tiles from a worker, WebGL2, opt-in WebGPU and Canvas 2D on one layout, device loss | #39–#44            |

Milestones and their exit criteria are in the [roadmap](../../ROADMAP.md#milestones).
