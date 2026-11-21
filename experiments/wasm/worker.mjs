import { reducePeaks } from "./peaks.mjs";

let wasm;
let input;
let output;
self.onmessage = async ({ data }) => {
  if (data.moduleBytes) {
    const { instance } = await WebAssembly.instantiate(data.moduleBytes);
    wasm = instance.exports;
    const address = Math.ceil(wasm.__heap_base.value / 16) * 16;
    const outputAddress = address + data.samples * 4;
    const bytes = outputAddress + (data.samples / 256) * 8 - wasm.memory.buffer.byteLength;
    if (bytes > 0) wasm.memory.grow(Math.ceil(bytes / 65536));
    input = new Float32Array(wasm.memory.buffer, address, data.samples);
    output = new Float32Array(wasm.memory.buffer, outputAddress, (data.samples / 256) * 2);
    self.postMessage("ready");
    return;
  }
  const { pcm, pairs, backend } = data;
  if (backend === "js") {
    reducePeaks(pcm, pairs);
  } else {
    input.set(pcm);
    wasm.peaks_simd(input.byteOffset, pcm.length / 256, output.byteOffset);
    pairs.set(output.subarray(0, pairs.length));
  }
  self.postMessage({ pcm, pairs }, [pcm.buffer, pairs.buffer]);
};
