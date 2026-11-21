import { createAudioTransport, createVideoTransport } from '@lumen-timeline/media'
import { createDemoAssets } from './assets.mjs'

export async function attachPlayer(video, editor, onError) {
  const context = new AudioContext()
  let assets
  try {
    assets = createDemoAssets(context)
    const options = { editor, context, ...assets, onError }
    const player = video ? createVideoTransport({ ...options, video }) : createAudioTransport(options)
    return { transport: player,
      dispose() { player.dispose(); assets.dispose(); video?.pause(); return context.close() },
    }
  } catch (error) { assets?.dispose(); await context.close(); throw error }
}
