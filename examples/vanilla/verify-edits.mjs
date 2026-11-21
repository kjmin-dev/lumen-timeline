import assert from 'node:assert/strict'

const hz = 282240000
export async function verifyEdits(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1120, height: 1000 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  try {
    await page.goto(url)
    await page.waitForSelector('.lt-edit')
    const surface = page.getByRole('group', { name: 'Timeline clips' })
    const button = name => page.getByRole('button', { name, exact: true })
    async function state() {
      return page.evaluate(async () => {
        const { studio } = await import('./app.mjs')
        const e = studio.editor,
          s = e.getSnapshot()
        return {
          clips: s.clips,
          revision: s.revision,
          undo: e.history.undoDepth,
          redo: e.history.redoDepth,
          selected: e.session.getSelection(),
          ghost: studio.view.getDiagnostics().previewClipCount,
          seconds: studio.transport.snapshot().presentedTick / 282240000,
          message: document.querySelector('.lt-message')?.textContent ?? '',
        }
      })
    }
    async function point(second, row = 0) {
      const { startTick, pixelsPerSecond } = await page.evaluate(async () =>
        (await import('./app.mjs')).studio.view.getViewport(),
      )
      const r = await surface.boundingBox()
      return { x: r.x + (second - startTick / hz) * pixelsPerSecond, y: r.y + 20 + 46 * row }
    }
    async function drag(from, to, row = 0, end = row, release = true) {
      await surface.scrollIntoViewIfNeeded()
      const a = await point(from, row),
        b = await point(to, end)
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await page.mouse.move(b.x, b.y, { steps: 5 })
      if (release) await page.mouse.up()
    }
    const clip = s => s.clips.find(c => c.id === 'line')
    const numbers = s => {
      const c = clip(s)
      return [c.start / hz, c.duration / hz, c.contentIn / hz]
    }
    const initial = await state()
    await page.evaluate(async () => {
      const { studio } = await import('./app.mjs')
      studio.view.setViewport({ startTick: 10 * 282240000, pixelsPerSecond: 65 })
      await studio.transport.seek(13 * 282240000)
    })
    await button('Play').click()
    const studioHandle = await page.evaluateHandle(async () => (await import('./app.mjs')).studio)
    const bed = await page.waitForFunction(studio => {
      const { driver } = studio.transport
      const voice = driver.voices.get('bed')
      if (voice?.node && driver.voices.get('line')?.node) {
        return { node: voice.node, end: voice.endSample, generation: driver.generation }
      }
    }, studioHandle)
    // Alt bypasses snapping; these gestures have exact integer-second intent.
    await page.keyboard.down('Alt')
    await drag(13, 15, 0, 0, false)
    let s = await state()
    assert.deepEqual([s.revision, s.undo, s.ghost], [0, 0, 1])
    await page.evaluate(async () => {
      const { studio } = await import('./app.mjs'),
        { commands } = await import('@lumen-timeline/core')
      studio.editor.dispatch(
        commands.setEntityData({ scope: 'take', id: 'line', key: 'status', value: 'ready' }),
        { history: 'ignore' },
      )
    })
    await page.mouse.up()
    assert.deepEqual(numbers(await state()), [14, 4, 1])
    await drag(14 + 2 / 65, 15 + 2 / 65)
    await page.keyboard.up('Alt')
    s = await state()
    assert.deepEqual(numbers(s), [15, 3, 2])
    assert.deepEqual([s.undo, s.redo, s.revision, s.ghost], [2, 0, 3, 0])
    const sourceSample = await page.evaluate(async () => {
      const { studio } = await import('./app.mjs')
      const range = { start: Math.round(16.2 * 282240000), end: Math.round(16.3 * 282240000) }
      return studio.editor
        .read()
        .planAudio(range, studio.transport.driver.catalog)
        .spans.find(s => s.clipId === 'line').window.sourceStart
    })
    const rate = await page.evaluate(
      async () => (await import('./app.mjs')).studio.transport.driver.context.sampleRate,
    )
    assert.equal(sourceSample, Math.round(3.2 * rate))
    await button('Undo').click()
    await button('Undo').click()
    assert.deepEqual((await state()).clips, initial.clips)
    await drag(13, 13) // Zero displacement preserves redo.
    assert.equal((await state()).redo, 2)
    await button('Redo').click()
    await button('Redo').click()
    assert.deepEqual((await state()).clips, s.clips)
    assert.ok(
      await bed.evaluate(async b => {
        const { driver } = (await import('./app.mjs')).studio.transport
        const voice = driver.voices.get('bed')
        return voice?.node === b.node && voice.endSample === b.end && driver.generation === b.generation
      }),
      'music reservation changed during dialogue editing',
    )
    await bed.dispose()
    await studioHandle.dispose()
    await button('Pause').click()

    // Replay the same trace through accessible numeric controls.
    await button('Undo').click()
    await button('Undo').click()
    await page.getByLabel('Clip navigator').selectOption('line')
    const operation = page.getByLabel('Edit operation')
    const delta = page.getByLabel('Edit delta in seconds')
    await operation.selectOption('move')
    await delta.fill('2')
    await delta.press('Enter')
    await operation.selectOption('left')
    await delta.fill('1')
    await delta.press('Enter')
    assert.deepEqual((await state()).clips, s.clips)
    await button('Save project').click()
    // Text input and IME composition must never dispatch global editor commands.
    await delta.focus()
    await page.keyboard.press('Control+z')
    assert.deepEqual((await state()).clips, s.clips)
    await surface.dispatchEvent('keydown', { key: 's', isComposing: true, bubbles: true })
    assert.equal((await state()).undo, 2)
    await button('Undo').click()
    await button('Undo').click()
    await page.keyboard.down('Alt')
    await drag(13, 14, 0, 0, false)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    assert.deepEqual([(await state()).ghost, (await state()).redo], [0, 2])
    await drag(13, 20)
    assert.match((await state()).message, /overlap/i)
    assert.equal((await state()).undo, 0)
    await drag(13, 14, 1)
    assert.match((await state()).message, /locked/i)
    assert.equal((await state()).undo, 0)
    await surface.evaluate(el =>
      el.addEventListener(
        'pointerdown',
        e => {
          el.dataset.pointer = String(e.pointerId)
        },
        { once: true },
      ),
    )
    await drag(13, 14, 0, 0, false)
    await surface.dispatchEvent('pointercancel', {
      pointerId: Number(await surface.getAttribute('data-pointer')),
      bubbles: true,
    })
    await page.mouse.up()
    assert.equal((await state()).ghost, 0)
    assert.equal((await state()).undo, 0)
    await drag(13, 14, 0, 0, false)
    await page.evaluate(async () => {
      const { studio } = await import('./app.mjs'),
        { commands } = await import('@lumen-timeline/core')
      studio.editor.dispatch(commands.trimClip({ clipId: 'line', edge: 'right', delta: -282240000 }), {
        history: 'ignore',
      })
    })
    await page.mouse.up()
    await page.keyboard.up('Alt')
    assert.match((await state()).message, /changed during/i)
    assert.deepEqual(numbers(await state()), [12, 3, 1])
    assert.equal((await state()).undo, 0)
    await button('Reopen saved').click()
    await page.waitForFunction(
      () => document.querySelector('#status').textContent === 'Saved project reopened.',
    )
    const restored = await state()
    assert.deepEqual(restored.clips, s.clips)
    assert.deepEqual([restored.selected, restored.undo, restored.redo], [[], 0, 0])
    await page.getByLabel('Clip navigator').selectOption('line')
    // Both selected clips move atomically, then right trim owns only the end.
    await page.evaluate(async () => {
      const { studio } = await import('./app.mjs')
      studio.view.setViewport({ startTick: 13 * 282240000, pixelsPerSecond: 100 })
    })
    await page.keyboard.down('Shift')
    let cue = await point(19.5)
    await page.mouse.click(cue.x, cue.y)
    await page.keyboard.up('Shift')
    assert.deepEqual((await state()).selected, ['line', 'return'])
    await page.keyboard.down('Alt')
    const trace = await surface.evaluateHandle(el => {
      const events = []
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
        el.addEventListener(type, e => {
          const rect = el.getBoundingClientRect()
          events.push([type, e.clientX - rect.left, e.clientY - rect.top, e.button, e.pointerId])
        })
      }
      return events
    })
    await drag(16, 15)
    let grouped = await state()
    assert.deepEqual(
      [clip(grouped).start / hz, grouped.clips.find(c => c.id === 'return').start / hz, grouped.undo],
      [14, 18, 1],
    )
    await button('Undo').click()
    await drag(18 - 2 / 100, 17 - 2 / 100)
    assert.deepEqual(numbers(await state()), [15, 2, 2])
    await button('Undo').click()
    // The viewport cuts off the real start; its first visible pixel is a move.
    await page.evaluate(async () => {
      const { studio } = await import('./app.mjs')
      studio.view.setViewport({ startTick: 16 * 282240000, pixelsPerSecond: 130 })
    })
    await drag(16 + 2 / 130, 16.5 + 2 / 130)
    await page.keyboard.up('Alt')
    assert.deepEqual(numbers(await state()), [15.5, 3, 2])
    await button('Undo').click()
    await page.evaluate(async () => {
      await (await import('./app.mjs')).studio.transport.seek(16 * 282240000)
    })
    await surface.focus()
    await page.keyboard.press('s')
    const afterSplit = await state()
    assert.equal(afterSplit.clips.length, s.clips.length + 1)
    assert.equal(afterSplit.selected.length, 1)
    assert.notEqual(afterSplit.selected[0], 'line')
    await page.keyboard.press('Control+z')
    assert.deepEqual((await state()).clips, s.clips)
    await page.keyboard.press('Control+Shift+z')
    assert.deepEqual((await state()).clips, afterSplit.clips)
    // Dispose during an active gesture. The editor and driver remain host-owned.
    await page.evaluate(async () => {
      const { studio } = await import('./app.mjs')
      studio.view.setViewport({ startTick: 13 * 282240000, pixelsPerSecond: 100 })
    })
    await drag(17, 17.5, 0, 0, false)
    const pending = await state()
    assert.equal(pending.ghost, 1)
    await page.evaluate(async () => (await import('./app.mjs')).studio.view.dispose())
    await page.mouse.up()
    const disposed = await state()
    assert.deepEqual([disposed.revision, disposed.undo, disposed.ghost], [pending.revision, pending.undo, 0])
    // An unlocked destination accepts a multi-clip drag as one history step.
    const secondary = await page.evaluateHandle(async () => {
      const { createEditor } = await import('@lumen-timeline/core')
      const { mountTimeline } = await import('@lumen-timeline/timeline')
      const { studio } = await import('./app.mjs')
      const tick = 282240000
      const editor = createEditor({ project: { schemaVersion: 1, duration: 32 * tick,
        tracks: [{ id: 'from' }, { id: 'to', overlap: 'exclusive' }],
        clips: ['a', 'b'].map((id, i) => ({ id, trackId: 'from', kind: 'audio', start: (5 + 4 * i) * tick,
          duration: 2 * tick, contentIn: 0 })) } })
      const host = document.createElement('div')
      host.style.width = '600px'
      document.body.append(host)
      const view = mountTimeline(host, { editor, transport: studio.transport, startTick: 4 * tick, pixelsPerSecond: 60 })
      editor.session.select(['a', 'b'])
      return { editor, view, host }
    })
    const surface2 = page.getByRole('group', { name: 'Timeline clips' })
    await surface2.scrollIntoViewIfNeeded()
    const r = await surface2.boundingBox()
    await page.mouse.move(r.x + 120, r.y + 20)
    await page.mouse.down()
    await page.mouse.move(r.x + 120, r.y + 66, { steps: 4 })
    await page.mouse.up()
    const cross = await secondary.evaluate(({ editor }) => ({
      tracks: editor.getSnapshot().clips.map(c => c.trackId),
      starts: editor.getSnapshot().clips.map(c => c.start / 282240000), depth: editor.history.undoDepth,
    }))
    assert.deepEqual(cross, { tracks: ['to', 'to'], starts: [5, 9], depth: 1 })
    const anchorError = await secondary.evaluate(({ host, view }) => {
      const surface = host.querySelector('.lt-surface'), rect = surface.getBoundingClientRect()
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: rect.left + 120 })
      const x = wheel.clientX - rect.left
      const tickUnderPointer = () => {
        const v = view.getViewport()
        return v.startTick + Math.round(x * 282240000 / v.pixelsPerSecond)
      }
      const before = tickUnderPointer()
      surface.dispatchEvent(wheel)
      return Math.abs(tickUnderPointer() - before)
    })
    assert.ok(anchorError <= 1)
    await secondary.evaluate(({ host, view, editor }) => { view.dispose(); editor.dispose(); host.remove() })
    await secondary.dispose()
    assert.deepEqual(errors, [])
    console.log(
      'Pointer and keyboard edit trace, continuous music, cancellation, conflicting revision and JSON reopen passed',
    )
  } finally {
    await page.close()
  }
}
