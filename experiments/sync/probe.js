// Lower seven bits identify the take and source second. The high bit marks a pulse.
class Probe extends AudioWorkletProcessor {
  previous = 0;
  candidate = 0;
  runLength = 0;
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const size = outputs[0][0].length;
    for (let i = 0; i < size; i++) {
      const code = Math.round((input?.[i] || 0) * 256);
      if (code !== this.candidate) {
        this.candidate = code;
        this.runLength = 0;
      }
      this.runLength++;
      // Reject isolated interpolation values on an edge after rate correction.
      // Timestamp the first stable sample, including runs across worklet quanta.
      if (this.runLength === 4 && code !== this.previous) {
        this.port.postMessage({ audioTime: (currentFrame + i - 3) / sampleRate, code });
        this.previous = code;
      }
    }
    return true; // The zeroed output keeps the measurement silent.
  }
}
registerProcessor("sample-probe", Probe);
