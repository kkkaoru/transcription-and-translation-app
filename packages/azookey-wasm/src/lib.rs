//! Minimal, dependency-light WebAssembly ABI for the built-in AzooKey converter.
//!
//! The desktop converter accepts filesystem-backed dictionaries, but the
//! Cloudflare Worker cannot use a filesystem or ship the multi-hundred-MB
//! public dictionary.  This wrapper intentionally exposes only the compact
//! built-in lexicon through a raw ABI so the Worker can import the generated
//! module without a `wasm-bindgen` runtime or WASI.

use caption_bridge_azookey_rust::convert_kana_to_kanji;
use std::alloc::{alloc, dealloc, Layout};
use std::slice;

/// Allocate a byte buffer owned by the Wasm module.
///
/// The caller must release the buffer with [`azookey_dealloc`], passing the
/// same length.  A zero-length allocation uses a dangling, aligned pointer;
/// callers should not dereference it.
#[no_mangle]
pub extern "C" fn azookey_alloc(length: usize) -> *mut u8 {
    if length == 0 {
        return std::ptr::NonNull::<u8>::dangling().as_ptr();
    }
    let layout = match Layout::array::<u8>(length) {
        Ok(layout) => layout,
        Err(_) => return std::ptr::null_mut(),
    };
    // SAFETY: `layout` is a valid non-zero layout constructed above.
    unsafe { alloc(layout) }
}

/// Release a buffer previously returned by [`azookey_alloc`] or
/// [`azookey_convert`].
///
/// # Safety
///
/// `pointer` must be either null/zero-length or a pointer previously returned
/// by this module's allocator, and `length` must be the original allocation
/// length. The allocation must not have been released already.
#[no_mangle]
pub unsafe extern "C" fn azookey_dealloc(pointer: *mut u8, length: usize) {
    if pointer.is_null() || length == 0 {
        return;
    }
    let Ok(layout) = Layout::array::<u8>(length) else {
        return;
    };
    // SAFETY: the caller promises this pointer/length came from this module's
    // allocator and has not already been released.
    dealloc(pointer, layout);
}

/// Convert UTF-8 input into UTF-8 output.
///
/// The return value packs the output pointer in the high 32 bits and the
/// output byte length in the low 32 bits.  Wasm32 pointers are 32-bit, and the
/// Worker rejects text larger than 4 KiB before invoking this function.
/// A zero return indicates allocation failure.
///
/// # Safety
///
/// If `length` is non-zero, `pointer` must point to a readable UTF-8 byte
/// buffer of at least `length` bytes for the duration of this call. The Worker
/// validates UTF-8 before invoking the ABI, but invalid bytes are still handled
/// defensively as an empty string.
#[no_mangle]
pub unsafe extern "C" fn azookey_convert(pointer: *const u8, length: usize) -> u64 {
    if pointer.is_null() && length != 0 {
        return 0;
    }
    // SAFETY: the caller provides a valid UTF-8 request buffer and length;
    // invalid UTF-8 is handled as an empty input rather than crossing a panic
    // boundary into the Worker.
    let bytes = if length == 0 { &[] } else { slice::from_raw_parts(pointer, length) };
    let input = std::str::from_utf8(bytes).unwrap_or_default();
    let output = convert_kana_to_kanji(input);
    let output_bytes = output.as_bytes();
    let output_length = output_bytes.len();
    if output_length > u32::MAX as usize {
        return 0;
    }
    let output_pointer = azookey_alloc(output_length);
    if output_pointer.is_null() && output_length != 0 {
        return 0;
    }
    if output_length != 0 {
        // SAFETY: `output_pointer` is a fresh allocation of `output_length`
        // bytes and `output_bytes` is valid for the same number of bytes.
        std::ptr::copy_nonoverlapping(output_bytes.as_ptr(), output_pointer, output_length);
    }
    ((output_pointer as u32 as u64) << 32) | output_length as u64
}

#[cfg(test)]
mod tests {
    use super::{azookey_alloc, azookey_convert, azookey_dealloc};

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn raw_abi_converts_and_releases_utf8_buffers() {
        let input = "きょうははいしんです";
        let mut input_bytes = input.as_bytes().to_vec();
        let result = unsafe { azookey_convert(input_bytes.as_mut_ptr(), input_bytes.len()) };
        assert_ne!(result, 0);
        let pointer = (result >> 32) as u32 as usize as *mut u8;
        let length = (result & u64::from(u32::MAX)) as usize;
        let output = unsafe { std::slice::from_raw_parts(pointer, length) };
        assert_eq!(std::str::from_utf8(output), Ok("今日は配信です"));
        unsafe { azookey_dealloc(pointer, length) };
    }

    #[test]
    fn zero_length_allocations_are_safe() {
        let pointer = azookey_alloc(0);
        assert!(!pointer.is_null());
        unsafe { azookey_dealloc(pointer, 0) };
        let result = unsafe { azookey_convert(std::ptr::null(), 0) };
        assert_eq!(result & u64::from(u32::MAX), 0);
    }
}
