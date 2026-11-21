import assert from 'node:assert/strict'
import { chromium, firefox, webkit } from 'playwright'
import { serve } from './server.mjs'

const server = await serve()
const engine = process.argv[2] ?? 'chromium'
const browser = await ({ chromium, firefox, webkit }[engine]).launch()
const hz = 282240000
try {
  for (const dpr of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 840 }, deviceScaleFactor: dpr })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(server.url)
    await page.waitForFunction(() => document.querySelector('.lt-ruler') && document.querySelector('video').readyState >= 2)
    const api = (fn, arg) => page.evaluate(async ({ fn, arg }) => {
      const { studio } = await import('./app.mjs')
      // The test calls the same handles returned to the example host.
      const calls = {
        viewport: v => studio.view.setViewport(v), state: () => ({ ...studio.transport.snapshot(),
          ids: studio.editor.session.getSelection(), rev: studio.editor.getSnapshot().revision,
          history: studio.editor.history.undoDepth, view: studio.view.getViewport(), counts: studio.view.getDiagnostics() }),
        seek: t => studio.transport.seek(t),
        race: async () => {
          const results = await Promise.all([1,8,3].map(t => studio.transport.seek(t * 282240000)))
          return { results, tick: studio.transport.snapshot().presentedTick }
        },
        mounts: async () => {
          const { mountTimeline } = await import('@lumen-timeline/timeline')
          const div = document.createElement('div'); document.body.append(div)
          const second = mountTimeline(div, studio)
          const nav = div.querySelector('select')
          nav.value = 'bed'; nav.dispatchEvent(new Event('change'))
          const shared = document.querySelector('#timeline select').value
          second.dispose(); second.dispose(); div.remove()
          return shared
        },
      }
      return calls[fn](arg)
    }, { fn, arg })
    await api('viewport',{ startTick:12*hz, pixelsPerSecond:100 })
    const ruler = page.getByRole('slider',{name:'Seek',exact:true})
    const surface = page.getByRole('group',{name:'Timeline clips'})
    await surface.click({position:{x:90,y:20}})
    const selected = await api('state')
    assert.deepEqual(selected.ids,['line'])
    assert.equal(selected.presentedTick,0)
    const requests = await page.evaluateHandle(async () => {
      const { studio } = await import('./app.mjs')
      const ticks = []
      const off = studio.transport.subscribe(state => { if (state.requestedTick !== null) ticks.push(state.requestedTick) })
      return { ticks, off }
    })
    await ruler.click({position:{x:220,y:12}})
    assert.equal(await requests.evaluate(r => { r.off(); return r.ticks.at(-1) }), 14.2 * hz)
    await requests.dispose()
    await page.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 14.2) < 0.05)
    assert.deepEqual((await api('state')).ids,['line'])
    const race=await api('race')
    assert.equal(race.results.at(-1),'arrived')
    assert.equal(race.tick,3*hz)
    assert.equal(await api('mounts'),'bed')
    await page.getByRole('button',{name:'Zoom in',exact:true}).click()
    assert.equal((await api('state')).view.pixelsPerSecond,150)
    await api('viewport',{startTick:0,pixelsPerSecond:50})
    await api('seek',0)
    if (dpr===1) {
      await page.getByRole('button',{name:'Play',exact:true}).click()
      await page.waitForFunction(() => document.querySelector('video').currentTime > 0.25)
      const before=await api('state')
      await page.waitForFunction(t => document.querySelector('video').currentTime >= t, before.presentedTick/hz + 10,
        { timeout:20000 })
      const after=await api('state')
      assert.ok(after.presentedTick-before.presentedTick >= 9.8*hz)
      assert.deepEqual(after.counts,before.counts)
      assert.equal(after.rev,before.rev)
      assert.equal(after.history,before.history)
      await page.getByRole('button',{name:'Pause',exact:true}).click()
      if (process.env.LUMEN_SCREENSHOT) await page.screenshot({path:process.env.LUMEN_SCREENSHOT})
    }
    if (dpr === 2) {
      const layout = await page.evaluate(async () => {
        const { createEditor, commands, TICKS_PER_SECOND: hz } = await import('@lumen-timeline/core')
        const { mountTimeline } = await import('@lumen-timeline/timeline')
        const { studio } = await import('./app.mjs')
        const tracks = Array.from({ length: 20 }, (_, i) => ({ id: 'track-' + i }))
        const editor = createEditor({ project: { schemaVersion: 1, duration: 24 * hz, tracks,
          clips: tracks.map(t => ({ id: t.id, kind: 'audio', trackId: t.id, start: hz, duration: hz, contentIn: 0 })) } })
        const host = document.createElement('div'); document.body.append(host)
        const view = mountTimeline(host, { editor, transport: studio.transport })
        const scroller = host.querySelector('.lt-scroll')
        scroller.scrollTop = scroller.scrollHeight
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const visible = [...host.querySelectorAll('.lt-label')].map(label => label.textContent)
        const before = view.getDiagnostics().staticPaints
        editor.dispatch(commands.setEntityData({ scope: 'take', id: 'a', key: 'status', value: 'ready' }), { history: 'ignore' })
        editor.dispatch(commands.moveClips({ clipIds: ['track-0'], delta: hz }))
        const extraPaints = view.getDiagnostics().staticPaints - before
        view.dispose(); editor.dispose(); host.remove()
        return { visible, extraPaints }
      })
      assert.ok(layout.visible.includes('track-19') && !layout.visible.includes('track-0'))
      assert.equal(layout.extraPaints, 0)
    }
    assert.deepEqual(errors,[])
    console.log(engine + ' DPR ' + dpr + ': selection, seek, zoom and mount checks passed')
    await page.close()
  }
  await verifyUnavailable()
} finally { await browser.close(); await server.close() }

async function verifyUnavailable() {
  const page = await browser.newPage()
  try {
    await page.route('**/media/*', route => route.abort())
    await page.goto(server.url)
    await page.getByLabel('Clip navigator').selectOption('line')
    assert.equal(await page.locator('#clip-name').textContent(), 'Tidal contours')
    console.log(engine + ': selection remains available without media')
  } finally { await page.close() }
}
