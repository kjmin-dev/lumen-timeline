import { quadFloats } from "./layout.ts";
import { devicePixels, size, Staging } from "./renderer.ts";
import type { DeviceEvents, Frame, PixelRect, Pixels, Renderer } from "./renderer.ts";

const vertex = `#version 300 es
in vec2 corner;
in vec4 rect;
in vec4 uv;
in vec4 color;
uniform vec2 viewport;
out vec2 vUv;
out vec4 vColor;
out vec2 vLocal;
flat out vec2 vHalf;
flat out float vRadius;
flat out int vImage;
void main() {
  vec2 p = rect.xy + corner * rect.zw;
  gl_Position = vec4(p.x / viewport.x * 2.0 - 1.0, 1.0 - p.y / viewport.y * 2.0, 0.0, 1.0);
  vUv = mix(uv.xy, uv.zw, corner);
  vColor = color;
  vLocal = (corner - 0.5) * rect.zw;
  vHalf = rect.zw * 0.5;
  vRadius = uv.y;
  vImage = uv.z > uv.x ? 1 : 0;
}`;
const fragment = `#version 300 es
precision highp float;
uniform sampler2D atlas;
uniform float dpr;
in vec2 vUv;
in vec4 vColor;
in vec2 vLocal;
flat in vec2 vHalf;
flat in float vRadius;
flat in int vImage;
out vec4 outColor;
void main() {
  if (vImage == 1) {
    outColor = texture(atlas, vUv);
    return;
  }
  float a = vColor.a;
  // A rounded quad fades over one device pixel at its corners.
  if (vRadius > 0.0) {
    vec2 q = abs(vLocal) - (vHalf - vRadius);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - vRadius;
    a *= clamp(0.5 - d * dpr, 0.0, 1.0);
  }
  outColor = vec4(vColor.rgb * a, a);
}`;

interface Resources {
  readonly program: WebGLProgram;
  readonly vao: WebGLVertexArrayObject;
  readonly geometry: WebGLBuffer;
  readonly colors: WebGLBuffer;
  readonly texture: WebGLTexture;
  readonly viewport: WebGLUniformLocation | null;
  readonly dpr: WebGLUniformLocation | null;
  capacity: number;
  /** The atlas version the texture holds, or -1 for none. */
  atlas: number;
  atlasSize: number;
}

function shader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const made = gl.createShader(type);
  if (!made) throw new Error("WebGL2 could not create a shader");
  gl.shaderSource(made, source);
  gl.compileShader(made);
  if (!gl.getShaderParameter(made, gl.COMPILE_STATUS) && !gl.isContextLost())
    throw new Error("WebGL2 shader: " + (gl.getShaderInfoLog(made) ?? ""));
  return made;
}

function setup(gl: WebGL2RenderingContext): Resources {
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, shader(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost())
    throw new Error("WebGL2 program: " + (gl.getProgramInfoLog(program) ?? ""));
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const corners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, "corner");
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
  const geometry = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, geometry);
  for (const [name, offset] of [
    ["rect", 0],
    ["uv", 16],
  ] as const) {
    const location = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 4, gl.FLOAT, false, quadFloats * 4, offset);
    gl.vertexAttribDivisor(location, 1);
  }
  const colors = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, colors);
  const color = gl.getAttribLocation(program, "color");
  gl.enableVertexAttribArray(color);
  gl.vertexAttribPointer(color, 4, gl.UNSIGNED_BYTE, true, 4, 0);
  gl.vertexAttribDivisor(color, 1);
  gl.bindVertexArray(null);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // The atlas is the program's only texture, on unit 0 from here on.
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, "atlas"), 0);
  return {
    program,
    vao,
    geometry,
    colors,
    texture,
    viewport: gl.getUniformLocation(program, "viewport"),
    dpr: gl.getUniformLocation(program, "dpr"),
    capacity: 0,
    atlas: -1,
    atlasSize: 0,
  };
}

/**
 * Whether a context draws through a software rasterizer such as SwiftShader or
 * llvmpipe, where Canvas 2D costs the page less than emulating a GPU.
 */
export function isSoftware(gl: WebGL2RenderingContext): boolean {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name: unknown = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  return (
    typeof name === "string" && /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)
  );
}

/**
 * WebGL2: one instanced draw of every visible quad. The geometry is uploaded
 * once per frame the view draws, and the label atlas only in the rows that
 * changed. Returns why not where WebGL2 is unavailable, and where it would only
 * run in software unless `software` allows that.
 */
export function createWebGL2Renderer(
  canvas: HTMLCanvasElement,
  events: DeviceEvents,
  software: boolean,
): Renderer | "unavailable" | "software" {
  const context = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
  });
  if (!context) return "unavailable";
  const gl = context;
  if (!software && isSoftware(gl)) {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return "software";
  }
  let resources: Resources | null;
  try {
    resources = setup(gl);
  } catch {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return "unavailable";
  }
  const staging = new Staging();
  let uploads = 0;
  let disposed = false;
  const lost = (event: Event): void => {
    // Ask the browser to restore the context; the view draws elsewhere meanwhile.
    event.preventDefault();
    resources = null;
    if (!disposed) events.lost();
  };
  const restored = (): void => {
    if (disposed) return;
    try {
      resources = setup(gl);
      events.restored();
    } catch {
      resources = null;
    }
  };
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);
  const renderer: Renderer = {
    backend: "webgl2",
    canvas,
    get uploads() {
      return uploads;
    },
    get gpuBytes() {
      const r = resources;
      return r ? r.capacity * (quadFloats * 4 + 4) + r.atlasSize * r.atlasSize * 4 : 0;
    },
    // The drawing buffer holds the frame until the browser shows it, so a draw
    // and a read in one task read what was drawn. Rows come bottom first.
    read(frame: Frame, rect: PixelRect): Promise<Pixels> {
      renderer.draw(frame);
      const { x, y, w, h } = devicePixels(canvas, rect, frame.dpr);
      const flipped = new Uint8Array(4 * w * h);
      gl.readPixels(x, canvas.height - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
      const data = new Uint8Array(flipped.length);
      for (let row = 0; row < h; row++)
        data.set(flipped.subarray((h - 1 - row) * 4 * w, (h - row) * 4 * w), row * 4 * w);
      return Promise.resolve({ width: w, height: h, data });
    },
    draw(frame: Frame): void {
      const r = resources;
      if (!r || gl.isContextLost()) return;
      size(canvas, frame.width, frame.height, frame.dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(r.program);
      gl.uniform2f(r.viewport, Math.max(1, frame.width), Math.max(1, frame.height));
      gl.uniform1f(r.dpr, frame.dpr);
      // The label atlas, premultiplied, in the rows that changed since the last upload.
      const { atlas } = frame;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, r.texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      const changed = r.atlasSize === atlas.size ? atlas.changes(r.atlas) : "all";
      if (changed === "all") {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
        r.atlasSize = atlas.size;
      } else if (changed) {
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, changed.y0);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          changed.y0,
          atlas.size,
          changed.y1 - changed.y0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          atlas.canvas,
        );
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      }
      r.atlas = atlas.version;
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      const count = staging.gather(frame.rows);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.geometry);
      if (count > r.capacity) {
        r.capacity = staging.colors.length;
        gl.bufferData(gl.ARRAY_BUFFER, staging.data.byteLength, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, r.colors);
        gl.bufferData(gl.ARRAY_BUFFER, staging.colors.byteLength, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, r.geometry);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, staging.data, 0, count * quadFloats);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.colors);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, staging.colors, 0, count);
      uploads++;
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindVertexArray(r.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      gl.bindVertexArray(null);
    },
    dispose(): void {
      disposed = true;
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      const r = resources;
      resources = null;
      if (r && !gl.isContextLost()) {
        gl.deleteBuffer(r.geometry);
        gl.deleteBuffer(r.colors);
        gl.deleteTexture(r.texture);
        gl.deleteVertexArray(r.vao);
        gl.deleteProgram(r.program);
      }
      // Release the context now rather than at garbage collection: browsers
      // keep only a few live contexts and lose the oldest beyond that, which a
      // host that remounts the view would otherwise reach.
      if (!gl.isContextLost()) gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
  return renderer;
}
