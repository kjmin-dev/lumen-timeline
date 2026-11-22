import { quadFloats } from "./layout.ts";
import { devicePixels, size, Staging } from "./renderer.ts";
import type { DeviceEvents, Frame, PixelRect, Pixels, Renderer } from "./renderer.ts";

const shader = /* wgsl */ `
struct Uniforms { viewport: vec2f, pad: vec2f };
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var atlasSampler: sampler;
struct Out {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) @interpolate(flat) image: u32,
};
@vertex fn vs(@builtin(vertex_index) v: u32, @location(0) rect: vec4f, @location(1) uv: vec4f,
    @location(2) color: vec4f) -> Out {
  let corner = vec2f(f32(v & 1u), f32(v >> 1u));
  let p = rect.xy + corner * rect.zw;
  var out: Out;
  out.position = vec4f(p.x / u.viewport.x * 2.0 - 1.0, 1.0 - p.y / u.viewport.y * 2.0, 0.0, 1.0);
  out.uv = mix(uv.xy, uv.zw, corner);
  out.color = color;
  out.image = select(0u, 1u, uv.z > uv.x);
  return out;
}
@fragment fn fs(input: Out) -> @location(0) vec4f {
  let texel = textureSampleLevel(atlas, atlasSampler, input.uv, 0.0);
  if (input.image == 1u) { return texel; }
  return vec4f(input.color.rgb * input.color.a, input.color.a);
}`;

const gpuOf = (): GPU | undefined => {
  const gpu: unknown = Reflect.get(navigator, "gpu");
  return typeof gpu === "object" && gpu !== null && "requestAdapter" in gpu
    ? navigator.gpu
    : undefined;
};

/** Whether this browser exposes WebGPU at all. */
export const hasWebGPU = (): boolean => typeof navigator !== "undefined" && gpuOf() !== undefined;

/**
 * WebGPU: the same instances, order and blending as WebGL2, in WGSL. Resolves
 * to `null` where no adapter or device is granted. When the device is lost,
 * the renderer reports it and stops drawing; a new renderer takes its place.
 */
export async function createWebGPURenderer(
  canvas: HTMLCanvasElement,
  events: Pick<DeviceEvents, "lost">,
): Promise<Renderer | null> {
  const gpu = gpuOf();
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) {
    device.destroy();
    return null;
  }
  const format = gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });
  const module = device.createShaderModule({ code: shader });
  const blend: GPUBlendComponent = {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  };
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: quadFloats * 4,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x4" },
            { shaderLocation: 1, offset: 16, format: "float32x4" },
          ],
        },
        {
          arrayStride: 4,
          stepMode: "instance",
          attributes: [{ shaderLocation: 2, offset: 0, format: "unorm8x4" }],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: "fs",
      targets: [{ format, blend: { color: blend, alpha: blend } }],
    },
    primitive: { topology: "triangle-strip" },
  });
  const uniforms = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const sampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
  let texture: GPUTexture | null = null;
  let bindGroup: GPUBindGroup | null = null;
  let atlasVersion = -1;
  let geometry: GPUBuffer | null = null;
  let colors: GPUBuffer | null = null;
  let capacity = 0;
  const staging = new Staging();
  let uploads = 0;
  let lost = false;
  let disposed = false;
  void device.lost.then(() => {
    lost = true;
    if (!disposed) events.lost();
  });
  // Uploads what changed and returns the instance count.
  function prepare(frame: Frame): number {
    size(canvas, frame.width, frame.height, frame.dpr);
    const { atlas } = frame;
    if (!texture || texture.width !== atlas.size) {
      texture?.destroy();
      texture = device.createTexture({
        size: [atlas.size, atlas.size],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: texture.createView() },
          { binding: 2, resource: sampler },
        ],
      });
      atlasVersion = -1;
    }
    const changed = atlas.changes(atlasVersion);
    const rows = changed === "all" ? { y0: 0, y1: atlas.size } : changed;
    if (rows && rows.y1 > rows.y0)
      device.queue.copyExternalImageToTexture(
        { source: atlas.canvas, origin: { x: 0, y: rows.y0 } },
        { texture, origin: { x: 0, y: rows.y0 }, premultipliedAlpha: true },
        { width: atlas.size, height: rows.y1 - rows.y0 },
      );
    atlasVersion = atlas.version;
    device.queue.writeBuffer(
      uniforms,
      0,
      new Float32Array([Math.max(1, frame.width), Math.max(1, frame.height), 0, 0]),
    );
    const count = staging.gather(frame.rows);
    if (!geometry || !colors || count > capacity) {
      geometry?.destroy();
      colors?.destroy();
      capacity = staging.colors.length;
      geometry = device.createBuffer({
        size: capacity * quadFloats * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      colors = device.createBuffer({
        size: capacity * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    if (count) {
      device.queue.writeBuffer(geometry, 0, staging.data, 0, count * quadFloats);
      device.queue.writeBuffer(colors, 0, staging.colors, 0, count);
    }
    uploads++;
    return count;
  }
  // Records one pass that clears `target` and draws `count` instances into it.
  function encode(encoder: GPUCommandEncoder, target: GPUTextureView, count: number): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" },
      ],
    });
    if (count && bindGroup && geometry && colors) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setVertexBuffer(0, geometry);
      pass.setVertexBuffer(1, colors);
      pass.draw(4, count);
    }
    pass.end();
  }
  return {
    backend: "webgpu",
    canvas,
    get uploads() {
      return uploads;
    },
    get gpuBytes() {
      return (
        capacity * (quadFloats * 4 + 4) + (texture ? texture.width * texture.height * 4 : 0) + 16
      );
    },
    draw(frame: Frame): void {
      if (lost || disposed) return;
      const count = prepare(frame);
      const encoder = device.createCommandEncoder();
      encode(encoder, context.getCurrentTexture().createView(), count);
      device.queue.submit([encoder.finish()]);
    },
    // Draws into a texture of the canvas's size and format and maps a copy of
    // the region, rather than reading the canvas, which a page cannot do for
    // WebGPU without the browser presenting it.
    async read(frame: Frame, rect: PixelRect): Promise<Pixels> {
      if (lost || disposed) throw new Error("The WebGPU device is gone");
      const count = prepare(frame);
      const target = device.createTexture({
        size: [canvas.width, canvas.height],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      const { x, y, w, h } = devicePixels(canvas, rect, frame.dpr);
      const stride = Math.ceil((4 * w) / 256) * 256;
      const buffer = device.createBuffer({
        size: stride * h,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder();
      encode(encoder, target.createView(), count);
      encoder.copyTextureToBuffer(
        { texture: target, origin: { x, y } },
        { buffer, bytesPerRow: stride },
        { width: w, height: h },
      );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(buffer.getMappedRange());
      const data = new Uint8Array(4 * w * h);
      const bgra = format === "bgra8unorm";
      for (let row = 0; row < h; row++)
        for (let col = 0; col < w; col++) {
          const from = row * stride + 4 * col;
          const to = 4 * (row * w + col);
          data[to] = mapped[from + (bgra ? 2 : 0)] ?? 0;
          data[to + 1] = mapped[from + 1] ?? 0;
          data[to + 2] = mapped[from + (bgra ? 0 : 2)] ?? 0;
          data[to + 3] = mapped[from + 3] ?? 0;
        }
      buffer.unmap();
      buffer.destroy();
      target.destroy();
      return { width: w, height: h, data };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      context.unconfigure();
      device.destroy();
    },
  };
}
