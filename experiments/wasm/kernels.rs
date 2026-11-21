#![no_std]

use core::arch::wasm32::*;
use core::slice;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    unreachable()
}

#[unsafe(no_mangle)]
pub extern "C" fn source_position(time: f64, start: f64, end: f64, offset: f64) -> f64 {
    if time >= start && time < end {
        time - start + offset
    } else {
        -1.0
    }
}

// The harness supplies safe integer positions and positive u32 rates within
// the project's seven-day range. Use i128 for the intermediate product.
#[unsafe(no_mangle)]
pub extern "C" fn units_to_ticks(units: f64, numerator: u32, denominator: u32) -> f64 {
    let product = (units as i64 as i128) * (denominator as i128) * 282_240_000;
    let divisor = numerator as i128;
    let absolute = (product.abs() + divisor / 2) / divisor;
    (absolute * product.signum()) as f64
}

// The benchmark supplies disjoint input/output slices and complete 256-sample
// buckets of finite PCM. The JavaScript runner allocates both inside this memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peaks(input: *const f32, buckets: usize, output: *mut f32) {
    let samples = unsafe { slice::from_raw_parts(input, buckets * 256) };
    let pairs = unsafe { slice::from_raw_parts_mut(output, buckets * 2) };
    for (chunk, pair) in samples.chunks_exact(256).zip(pairs.chunks_exact_mut(2)) {
        let mut lo = f32::INFINITY;
        let mut hi = f32::NEG_INFINITY;
        for &sample in chunk {
            if sample < lo {
                lo = sample;
            }
            if sample > hi {
                hi = sample;
            }
        }
        pair.copy_from_slice(&[lo, hi]);
    }
}

#[unsafe(no_mangle)]
#[target_feature(enable = "simd128")]
pub unsafe extern "C" fn peaks_simd(input: *const f32, buckets: usize, output: *mut f32) {
    for bucket in 0..buckets {
        let mut lo = f32x4_splat(f32::INFINITY);
        let mut hi = f32x4_splat(f32::NEG_INFINITY);
        for i in (0..256).step_by(4) {
            let values = unsafe { v128_load(input.add(bucket * 256 + i).cast()) };
            lo = f32x4_pmin(lo, values);
            hi = f32x4_pmax(hi, values);
        }
        let min = f32x4_extract_lane::<0>(lo)
            .min(f32x4_extract_lane::<1>(lo))
            .min(f32x4_extract_lane::<2>(lo))
            .min(f32x4_extract_lane::<3>(lo));
        let max = f32x4_extract_lane::<0>(hi)
            .max(f32x4_extract_lane::<1>(hi))
            .max(f32x4_extract_lane::<2>(hi))
            .max(f32x4_extract_lane::<3>(hi));
        unsafe {
            output.add(bucket * 2).write(min);
            output.add(bucket * 2 + 1).write(max);
        }
    }
}
