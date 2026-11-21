# Lumen Timeline

Lumen Timeline is a planned JavaScript framework for building browser-based audio and video editors. Its smallest integration is a timeline mounted beneath an existing player. A dubbing studio can add synchronized audio tracks, alternate takes and a bilingual script inspector. A podcast editor can use the same engine with an audio clock and a chapter list.

The core will own editing commands, time and history. A shared browser view will handle waveforms, pointer input and playhead updates. React, Svelte, SolidJS and Vue will each get a thin wrapper around that view, targeting the latest stable major of the framework.

**Project status** — The v1 core architecture is specified. Browser clock and waveform experiments inform the implementation plan.

- [Core implementation architecture](docs/core-architecture.md) defines the JavaScript engine, sample scheduling and optional Rust waveform worker.
- [Design](docs/design.md) covers the project format, playback clocks, editing semantics, GPU rendering and extension API.
- [Roadmap](ROADMAP.md) lists the implementation milestones, framework version targets and acceptance tests.
