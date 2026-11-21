import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit, firefox } from 'playwright'
import { generateVideo, generateSoak } from './fixture.mjs'

const engine = process.argv[2] ?? 'chrome'
const control = process.argv[3] === '--control'
const pcmOnly = process.argv[3] === '--pcm'
const soakSeconds = control || pcmOnly ? 0 : Number(process.argv[3] ?? 0)
if (!Number.isInteger(soakSeconds) || soakSeconds < 0 || soakSeconds > 3600) throw new Error('Invalid soak duration')
const engines = { chrome: chromium, chromium, webkit, firefox }
if (!engines[engine]) throw new Error('Choose chrome, chromium, firefox or webkit')
const root = fileURLToPath(new URL('../../', import.meta.url))
const fixture = await mkdtemp(join(tmpdir(), 'lumen-sync-'))
const probe = pcmOnly ? 'verifyEditedPcm()' : soakSeconds ? 'soak(' + soakSeconds + ')' : 'run(' + (control ? 0.100 : 0) + ')'
const pageHtml = `<video muted playsinline width="160" height="64"></video><button>Run</button>
<script type="module">
import {run} from '/experiments/sync/browser.mjs'
import {soak} from '/experiments/sync/soak.mjs'
import {verifyEditedPcm} from '/experiments/sync/edited-pcm.mjs'
document.querySelector('button').onclick = () => { window.result = ${probe}; window.result.catch(() => {}) }
</script>`
const modules = new Set(['/experiments/sync/browser.mjs', '/experiments/sync/probe.js',
  '/experiments/sync/transport.mjs', '/experiments/sync/soak.mjs', '/experiments/sync/edited-pcm.mjs',
  '/packages/core/index.mjs', '/packages/core/editor.mjs', '/packages/core/document.mjs',
  '/packages/core/clip-patches.mjs', '/packages/core/entity-data.mjs', '/packages/core/history.mjs', '/packages/core/time.mjs'])
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(pageHtml); return }
    if (modules.has(req.url)) {
      res.setHeader('Content-Type', 'text/javascript')
      res.end(await readFile(join(root, req.url)))
      return
    }
    if (/^\/fixture\/(init\.mp4|soak\.mp4|chunk-\d+\.m4s)$/.test(req.url)) {
      res.setHeader('Content-Type', 'video/mp4')
      res.end(await readFile(join(fixture, req.url.slice('/fixture/'.length))))
      return
    }
    res.writeHead(404).end()
  } catch { res.writeHead(500).end() }
})
let browser
try {
  if (soakSeconds) generateSoak(fixture, soakSeconds)
  else if (!pcmOnly) generateVideo(fixture)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await engines[engine].launch(engine === 'chrome' ? { channel: 'chrome' } : {})
  const page = await browser.newPage()
  page.setDefaultTimeout(45000)
  page.on('console', message => { if (message.text().startsWith('Soak ')) console.error(message.text()) })
  page.on('pageerror', e => console.error(e.message))
  await page.goto('http://127.0.0.1:' + server.address().port)
  await page.locator('button').click()
  await page.waitForFunction(() => typeof window.result !== 'undefined', null, { timeout: 45000 })
  let deadline
  const result = await Promise.race([page.evaluate(() => window.result),
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Playback probe timed out')), 45000 + soakSeconds * 1000) }),
  ]).finally(() => clearTimeout(deadline))
  const passed = control ? !result.withinOneFrame && result.missingFrames.length === 0 &&
    result.p95AbsoluteMs >= 75 && result.p95AbsoluteMs <= 140 : (pcmOnly ? result.passed : result.withinOneFrame)
  console.log(JSON.stringify({ engine, browser: browser.version(), injectedDelayMs: control ? 100 : 0,
    ...result, passed }, null, 2))
  if (!passed) process.exitCode = 1
} finally {
  await browser?.close()
  if (server.listening) await new Promise(resolve => server.close(resolve))
  await rm(fixture, { recursive: true, force: true })
}
