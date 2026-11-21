import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// Thirty frames a second. Each integer second flashes white. Ten lower cells
// encode the frame number so the observer can check the actual decoded pixels.
const filter = "nullsrc=s=160x64:r=30,geq=lum='if(lt(Y,32),if(lt(mod(N,30),3),235,16),if(bitand(N,pow(2,floor(X/16))),235,16))':cb=128:cr=128"

export function generateVideo(directory) {
  const cmd = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', filter, '-t', '20',
    '-an', '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0', '-pix_fmt', 'yuv420p',
    '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-f', 'dash', '-seg_duration', '1',
    '-init_seg_name', 'init.mp4', '-media_seg_name', 'chunk-$Number$.m4s', join(directory, 'video.mpd')],
    { encoding: 'utf8' })
  if (cmd.error || cmd.status !== 0) throw cmd.error || new Error(cmd.stderr)
}

export function generateSoak(directory, seconds) {
  const cycle = join(directory, 'cycle.mp4')
  const encode = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', filter, '-t', '10',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', cycle], { encoding: 'utf8' })
  if (encode.error || encode.status) throw encode.error || new Error(encode.stderr)
  const mux = spawnSync('ffmpeg', ['-v', 'error', '-stream_loop', '-1', '-i', cycle,
    '-t', String(seconds + 2), '-c', 'copy', '-movflags', '+faststart', join(directory, 'soak.mp4')],
    { encoding: 'utf8' })
  if (mux.error || mux.status) throw mux.error || new Error(mux.stderr)
}
