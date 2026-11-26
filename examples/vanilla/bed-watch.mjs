// Watches the example's music voice while a trace edits during playback. A clock correction
// rebooks every voice under a new generation, which a loaded machine does on its own; an edit
// must never touch the music. Each input event is checked from its capture to its bubble on the
// window, inside the task that handled it, so a correction cannot fall between the two.
export async function watchBed(page) {
  await page.evaluate(async () => {
    const { studio } = await import("./app.mjs");
    const read = () => {
      const { reservation, generation, endSample } = studio.transport.diagnostics("bed");
      return { reservation, generation, endSample };
    };
    const start = read();
    const touched = [];
    let before = null;
    const types = [
      "pointerdown",
      "pointermove",
      "pointerup",
      "click",
      "keydown",
      "keyup",
      "change",
    ];
    const capture = () => {
      before = read();
    };
    const bubble = (event) => {
      if (!before) return;
      const after = read();
      const same =
        after.reservation === before.reservation &&
        after.generation === before.generation &&
        after.endSample === before.endSample;
      if (!same) touched.push(event.type);
      before = null;
    };
    for (const type of types) {
      window.addEventListener(type, capture, true);
      window.addEventListener(type, bubble);
    }
    window.lumenBedWatch = () => {
      for (const type of types) {
        window.removeEventListener(type, capture, true);
        window.removeEventListener(type, bubble);
      }
      const end = read();
      return {
        touched,
        // Without a clock correction in between, the music keeps its reservation throughout.
        kept: end.generation !== start.generation || end.reservation === start.reservation,
        booked: end.reservation !== undefined,
      };
    };
  });
  return () => page.evaluate(() => window.lumenBedWatch());
}
