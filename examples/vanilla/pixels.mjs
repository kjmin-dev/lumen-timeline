// Reads what the page shows in a region, through a screenshot, so a probe sees
// the composited result of any drawing backend: Canvas 2D, WebGL2 or WebGPU.
// Returns { width, height, data } at device pixels, data as RGBA bytes.
export async function pixels(page, { x, y, width, height }) {
  const png = await page.screenshot({ clip: { x, y, width, height } });
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { width: bitmap.width, height: bitmap.height, data: Array.from(data) };
  }, png.toString("base64"));
}

/** The color at a device pixel of a region read by `pixels`. */
export function colorAt({ width, data }, px, py) {
  const i = 4 * (py * width + px);
  return data.slice(i, i + 3);
}

/** Counts pixels that differ from `color` by more than `tolerance`, summed over channels. */
export function countOff({ data }, color, tolerance = 24) {
  let count = 0;
  for (let i = 0; i < data.length; i += 4)
    if (
      Math.abs(data[i] - color[0]) +
        Math.abs(data[i + 1] - color[1]) +
        Math.abs(data[i + 2] - color[2]) >
      tolerance
    )
      count++;
  return count;
}
