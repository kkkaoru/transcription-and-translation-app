//! Minimal, dependency-light WebAssembly ABI for the AzooKey converter.
//!
//! The desktop converter accepts filesystem-backed dictionaries. Cloudflare
//! Workers do not expose a filesystem, so this wrapper accepts the same
//! official LOUDS/MM/CID files through one portable in-memory archive while
//! keeping the ABI independent of `wasm-bindgen` and WASI.

use caption_bridge_azookey_rust::{
    convert_kana_to_kanji, convert_with_dictionary, AzooKeyDictionary, ConversionOptions,
};
use std::alloc::{alloc, dealloc, Layout};
use std::slice;
use std::sync::Mutex;

const DICTIONARY_INIT_OK: u32 = 0;
const DICTIONARY_INIT_INVALID: u32 = 1;
const DICTIONARY_INIT_UNAVAILABLE: u32 = 2;
const AZOOKEY_ABI_VERSION: u32 = 2;

static ACTIVE_DICTIONARY: Mutex<Option<AzooKeyDictionary>> = Mutex::new(None);

/// Return the raw ABI revision. Version 2 adds the owned portable dictionary
/// initialization entrypoint while preserving the version 1 conversion ABI.
#[no_mangle]
pub extern "C" fn azookey_abi_version() -> u32 {
    AZOOKEY_ABI_VERSION
}

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

/// Initialize the converter with an official portable AzooKey dictionary.
///
/// Returns zero on success, one when the archive is malformed, or two when
/// the process-wide dictionary lock is unavailable. A failed reinitialization
/// preserves the last valid dictionary.
///
/// # Safety
///
/// `pointer` must be a live allocation returned by [`azookey_alloc`] with
/// exactly `length` bytes. This function takes ownership of that allocation
/// on every non-empty call, including an error result; the caller must not
/// release or reuse it afterwards.
#[no_mangle]
pub unsafe extern "C" fn azookey_dictionary_init_owned(pointer: *mut u8, length: usize) -> u32 {
    if pointer.is_null() || length == 0 {
        return DICTIONARY_INIT_INVALID;
    }
    // SAFETY: the caller transfers an allocation created by this module's
    // global allocator with capacity exactly equal to `length`.
    let bytes = Vec::from_raw_parts(pointer, length, length);
    let Ok(dictionary) = AzooKeyDictionary::from_portable_system_dictionary(bytes) else {
        return DICTIONARY_INIT_INVALID;
    };
    let Ok(mut active) = ACTIVE_DICTIONARY.lock() else {
        return DICTIONARY_INIT_UNAVAILABLE;
    };
    *active = Some(dictionary);
    DICTIONARY_INIT_OK
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
    let output = convert_with_active_dictionary(input);
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
    pack_output(output_pointer as usize, output_length)
}

/// Pack a conversion output into the raw ABI return value.
///
/// The high 32 bits carry the output pointer (truncated to the Wasm32 address
/// space) and the low 32 bits carry the output byte length. Kept as a pure
/// helper so host tests can pin the boundary math without a Wasm runtime.
fn pack_output(pointer: usize, length: usize) -> u64 {
    ((pointer as u32 as u64) << 32) | length as u64
}

fn convert_with_active_dictionary(input: &str) -> String {
    let Ok(active) = ACTIVE_DICTIONARY.lock() else {
        return convert_kana_to_kanji(input);
    };
    let Some(dictionary) = active.as_ref() else {
        return convert_kana_to_kanji(input);
    };
    convert_with_dictionary(input, dictionary, ConversionOptions::default())
        .into_iter()
        .next()
        .map(|candidate| candidate.text)
        .unwrap_or_else(|| input.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        azookey_alloc, azookey_convert, azookey_dealloc, azookey_dictionary_init_owned,
        convert_with_active_dictionary, pack_output, ACTIVE_DICTIONARY,
    };

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
    fn output_packing_pins_the_wasm32_abi_boundaries() {
        // High 32 bits carry the pointer (the Wasm32 address space truncates
        // to u32), low 32 bits carry the byte length.
        assert_eq!(pack_output(0, 0), 0);
        assert_eq!(pack_output(0xff00_0000, 7), (0xff00_0000u64 << 32) | 7);
        assert_eq!(pack_output(usize::MAX, u32::MAX as usize), 0xffff_ffff_ffff_ffff);
        // A host-width pointer truncates to its low 32 bits, exactly as the
        // Worker observes a Wasm32 output pointer. A pointer whose contents
        // live only in the high word of a host address collapses to zero.
        assert_eq!(pack_output(0x0000_0001_0000_0000, 0), 0);
        assert_eq!(pack_output(0x0000_0001_0000_4321, 4), 0x0000_4321_0000_0004);
    }

    #[test]
    fn conversion_falls_back_to_the_builtin_converter_when_no_dictionary_is_active() {
        // A fresh ABI (no dictionary initialized) must still convert using the
        // crate's built-in lexicon instead of returning empty output.
        let result = convert_with_active_dictionary("きょうははいしんです");
        assert!(!result.is_empty(), "fallback converter returned empty output");
        assert_eq!(result, "今日は配信です");
    }

    #[test]
    fn conversion_falls_back_to_the_builtin_converter_when_the_dictionary_lock_is_poisoned() {
        // A panicked holder must not make every subsequent conversion fail:
        // the boundary stays usable through the built-in fallback path.
        std::thread::spawn(|| {
            let _guard = ACTIVE_DICTIONARY.lock().expect("test holds the dictionary lock");
            panic!("poison the active dictionary lock on purpose");
        })
        .join()
        .expect_err("the spawned test thread panics by design");

        let result = convert_with_active_dictionary("きょうははいしんです");
        assert!(!result.is_empty(), "poisoned-lock fallback returned empty output");
        assert_eq!(result, "今日は配信です");
    }

    #[test]
    fn zero_length_allocations_are_safe() {
        let pointer = azookey_alloc(0);
        assert!(!pointer.is_null());
        unsafe { azookey_dealloc(pointer, 0) };
        let result = unsafe { azookey_convert(std::ptr::null(), 0) };
        assert_eq!(result & u64::from(u32::MAX), 0);
    }

    #[test]
    fn dictionary_initialization_rejects_empty_and_malformed_archives() {
        assert_eq!(super::azookey_abi_version(), 2);
        assert_eq!(unsafe { azookey_dictionary_init_owned(std::ptr::null_mut(), 0) }, 1);
        let malformed = b"not-a-dictionary";
        let pointer = azookey_alloc(malformed.len());
        assert!(!pointer.is_null());
        unsafe { std::ptr::copy_nonoverlapping(malformed.as_ptr(), pointer, malformed.len()) };
        assert_eq!(unsafe { azookey_dictionary_init_owned(pointer, malformed.len()) }, 1);
    }
}
