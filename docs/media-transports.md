# Media transports

The `@lumen-timeline/media` workspace executes core audio plans on Web Audio and exposes a project-tick interface to the timeline. Importing the package acquires no browser resources.

```js
const transport = createVideoTransport({ video, context, output: context.destination,
  editor, catalog, resolveBuffer, onError })
const view = mountTimeline(container, { editor, transport })
```

The video driver observes presented frames and handles native seeking, buffering and clock reacquisition. A shared voice scheduler consumes its project-tick/context-time anchor. It owns its planning timer, editor subscription, gain and buffer source nodes, and abortable resolution requests. A clip edit preserves unrelated reservations and the active generation. A clock discontinuity invalidates the generation.

The public video factory accepts seeks in integer project ticks. Use `snapshot()`, `subscribe(listener)`, `play()`, `pause()`, `seek(tick)`, `setCatalog(catalog)` and `dispose()`. `diagnostics(clipId)` reports the generation, sample rate and an opaque reservation identity and end sample for that clip. The experiment's seconds-based API remains available to its original probes.

The host owns the editor, video element, AudioContext, output and asset cache. Disposing the factory detaches the driver and cancels its work; the host decides when to pause the element or close its context. [Scheduling behavior and probes](incremental-playback.md)
