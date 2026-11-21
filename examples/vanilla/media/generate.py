"""Regenerate the bundled silent 24-second guide with Python and FFmpeg."""
from math import sin, cos, exp, pi
from pathlib import Path
from subprocess import Popen, PIPE

w, h, fps = 480, 240, 10
target = Path(__file__).with_name('tidal-study.webm')
cmd = ['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24',
       '-video_size', f'{w}x{h}', '-framerate', str(fps), '-i', '-', '-an',
       '-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', '5', '-crf', '34',
       '-b:v', '0', '-g', str(fps), '-pix_fmt', 'yuv420p', str(target)]
with Popen(cmd, stdin=PIPE) as proc:
    for frame in range(24 * fps):
        t = frame * 2 * pi / (24 * fps)
        image = bytearray(bytes((18, 30, 33)) * (w * h))
        for z in range(46):
            depth = z / 45
            color = bytes((int(102 + 148*depth), int(148 + 36*depth), int(145 - 20*depth)))
            for x in range(18, w - 18):
                u = (x - w/2) / 120
                peak = exp(-((u - .25*sin(t))**2 + (depth - .56)**2 * 9))
                y = round(77 + 118*depth - peak*(54 + 21*sin(2.6*u + t + 5*depth))
                          + 6*cos(2.0*u - t + 3*depth))
                i = (y * w + x) * 3
                image[i:i+3] = color
        proc.stdin.write(image)
    proc.stdin.close()
    if proc.wait(): raise SystemExit('Video encoding failed')
