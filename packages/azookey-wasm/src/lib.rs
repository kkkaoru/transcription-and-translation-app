//! Minimal, dependency-light WebAssembly ABI for the AzooKey converter.
//!
//! The desktop converter accepts filesystem-backed dictionaries. Cloudflare
//! Workers do not expose a filesystem, so this wrapper accepts the same
//! official LOUDS/MM/CID files through one portable in-memory archive while
//! keeping the ABI independent of `wasm-bindgen` and WASI.

#[cfg(test)]
use caption_bridge_azookey_rust::DictionaryPaths;
use caption_bridge_azookey_rust::{
    convert_kana_to_kanji, convert_with_dictionary, AzooKeyDictionary, ConversionCandidate,
    ConversionOptions, PrecedingContext,
};
use std::alloc::{alloc, dealloc, Layout};
use std::slice;
use std::sync::Mutex;

const DICTIONARY_INIT_OK: u32 = 0;
const DICTIONARY_INIT_INVALID: u32 = 1;
const DICTIONARY_INIT_UNAVAILABLE: u32 = 2;
const AZOOKEY_ABI_VERSION: u32 = 2;
const N_BEST_STATUS_OK: u32 = 0;
const N_BEST_STATUS_FALLBACK: u32 = 1 << 0;
const N_BEST_STATUS_INVALID_UTF8: u32 = 1 << 1;
const N_BEST_STATUS_INVALID_ARGUMENT: u32 = 1 << 2;
const N_BEST_HEADER_BYTES: usize = 8;
const N_BEST_CANDIDATE_FIXED_BYTES: usize = 4 + 4 + 1 + 2 + 2;

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

/// Release a buffer previously returned by [`azookey_alloc`],
/// [`azookey_convert`], or [`azookey_convert_n_best`].
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

/// Convert UTF-8 input into up to `n_best` dictionary candidates.
///
/// The existing [`azookey_convert`] ABI remains the compatibility 1-best path.
/// This additive entry point keeps ABI version 2 so existing consumers that
/// require an exact version match continue to load the module.
///
/// `has_preceding` must be zero or one. When it is one, `preceding_rcid` and
/// `preceding_mid` must fit in `u16`; the three scalar arguments represent the
/// optional continuation context returned by an earlier chunk. Invalid values
/// are ignored and reported in the returned status word.
///
/// The returned `u64` uses the same Wasm32 pointer/length packing as
/// [`azookey_convert`]. The pointed-to buffer is a packed, alignment-free
/// little-endian record:
///
/// ```text
/// u32 status
/// u32 count
/// repeat count times:
///   u32 utf8_byte_length
///   [utf8_byte_length] UTF-8 text bytes (no NUL terminator)
///   f32 score (IEEE-754 binary32, `ConversionCandidate.score`)
///   u8  has_trailing (0 = None, 1 = Some)
///   u16 trailing_rcid (zero when has_trailing is zero)
///   u16 trailing_mid  (zero when has_trailing is zero)
/// ```
///
/// All integer and floating-point fields are little-endian. No alignment or
/// padding is inserted between fields; callers must use explicit byte reads
/// (for example, JavaScript `DataView` with the little-endian flag). The
/// caller owns the returned allocation and must release it exactly once with
/// [`azookey_dealloc`], passing the packed pointer and total byte length.
/// A return value of zero means that the input pointer was invalid or the
/// module could not allocate/represent the result. A valid `n_best == 0`
/// request returns an allocated header with `count == 0`.
///
/// Status bit 0 marks the built-in/1-best fallback path, bit 1 marks invalid
/// UTF-8 (the conversion continues with an empty input), and bit 2 marks an
/// invalid continuation-context argument. A zero status means that the
/// requested dictionary path completed normally.
/// The ABI has a preceding-context input now, but no current Cloudflare Worker
/// or Next.js caller retains and supplies `rcid`/`mid` between requests yet.
///
/// # Safety
///
/// If `length` is non-zero, `pointer` must point to a readable UTF-8 byte
/// buffer of at least `length` bytes for the duration of this call. The
/// function does not retain the input buffer after returning.
#[no_mangle]
pub unsafe extern "C" fn azookey_convert_n_best(
    pointer: *const u8,
    length: usize,
    n_best: u32,
    has_preceding: u32,
    preceding_rcid: u32,
    preceding_mid: u32,
) -> u64 {
    if pointer.is_null() && length != 0 {
        return 0;
    }

    let bytes = if length == 0 { &[] } else { slice::from_raw_parts(pointer, length) };
    let mut status = N_BEST_STATUS_OK;
    let input = match std::str::from_utf8(bytes) {
        Ok(input) => input,
        Err(_) => {
            status |= N_BEST_STATUS_INVALID_UTF8;
            ""
        }
    };
    let (preceding, preceding_status) =
        parse_preceding_context(has_preceding, preceding_rcid, preceding_mid);
    status |= preceding_status;

    let (candidates, conversion_status) = if n_best == 0 {
        (Vec::new(), N_BEST_STATUS_OK)
    } else {
        convert_with_active_dictionary_n_best(input, n_best as usize, preceding)
    };
    status |= conversion_status;

    allocate_n_best_output(status, &candidates).unwrap_or(0)
}

/// Pack a conversion output into the raw ABI return value.
///
/// The high 32 bits carry the output pointer (truncated to the Wasm32 address
/// space) and the low 32 bits carry the output byte length. Kept as a pure
/// helper so host tests can pin the boundary math without a Wasm runtime.
fn pack_output(pointer: usize, length: usize) -> u64 {
    ((pointer as u32 as u64) << 32) | length as u64
}

fn parse_preceding_context(
    has_preceding: u32,
    preceding_rcid: u32,
    preceding_mid: u32,
) -> (Option<PrecedingContext>, u32) {
    match has_preceding {
        0 => (None, N_BEST_STATUS_OK),
        1 if preceding_rcid <= u32::from(u16::MAX) && preceding_mid <= u32::from(u16::MAX) => (
            Some(PrecedingContext { rcid: preceding_rcid as u16, mid: preceding_mid as u16 }),
            N_BEST_STATUS_OK,
        ),
        _ => (None, N_BEST_STATUS_INVALID_ARGUMENT),
    }
}

fn fallback_candidate(input: &str) -> ConversionCandidate {
    ConversionCandidate { text: convert_kana_to_kanji(input), score: 0.0, trailing: None }
}

fn convert_n_best_with_dictionary_or_fallback(
    input: &str,
    n_best: usize,
    preceding: Option<PrecedingContext>,
    dictionary: Option<&AzooKeyDictionary>,
) -> (Vec<ConversionCandidate>, u32) {
    if n_best == 0 {
        return (Vec::new(), N_BEST_STATUS_OK);
    }

    if let Some(dictionary) = dictionary {
        let options = ConversionOptions { n_best, preceding, ..ConversionOptions::default() };
        let candidates = convert_with_dictionary(input, dictionary, options);
        if !candidates.is_empty() {
            return (candidates.into_iter().take(n_best).collect(), N_BEST_STATUS_OK);
        }
    }

    (vec![fallback_candidate(input)], N_BEST_STATUS_FALLBACK)
}

fn convert_with_active_dictionary_n_best(
    input: &str,
    n_best: usize,
    preceding: Option<PrecedingContext>,
) -> (Vec<ConversionCandidate>, u32) {
    match ACTIVE_DICTIONARY.lock() {
        Ok(active) => {
            convert_n_best_with_dictionary_or_fallback(input, n_best, preceding, active.as_ref())
        }
        Err(_) => convert_n_best_with_dictionary_or_fallback(input, n_best, preceding, None),
    }
}

fn serialize_n_best(status: u32, candidates: &[ConversionCandidate]) -> Option<Vec<u8>> {
    let count = u32::try_from(candidates.len()).ok()?;
    let mut output_length = N_BEST_HEADER_BYTES;
    for candidate in candidates {
        let text_length = candidate.text.len();
        u32::try_from(text_length).ok()?;
        output_length =
            output_length.checked_add(N_BEST_CANDIDATE_FIXED_BYTES)?.checked_add(text_length)?;
    }
    u32::try_from(output_length).ok()?;

    let mut output = Vec::new();
    output.try_reserve_exact(output_length).ok()?;
    output.extend_from_slice(&status.to_le_bytes());
    output.extend_from_slice(&count.to_le_bytes());
    for candidate in candidates {
        let text = candidate.text.as_bytes();
        output.extend_from_slice(&(text.len() as u32).to_le_bytes());
        output.extend_from_slice(text);
        output.extend_from_slice(&candidate.score.to_le_bytes());
        if let Some(trailing) = candidate.trailing {
            output.push(1);
            output.extend_from_slice(&trailing.rcid.to_le_bytes());
            output.extend_from_slice(&trailing.mid.to_le_bytes());
        } else {
            output.extend_from_slice(&[0, 0, 0, 0, 0]);
        }
    }
    Some(output)
}

fn allocate_n_best_output(status: u32, candidates: &[ConversionCandidate]) -> Option<u64> {
    let output = serialize_n_best(status, candidates)?;
    let output_length = output.len();
    let output_pointer = azookey_alloc(output_length);
    if output_pointer.is_null() && output_length != 0 {
        return None;
    }
    if output_length != 0 {
        // SAFETY: `output_pointer` is a fresh allocation of `output_length`
        // bytes and `output` remains alive for the copy.
        unsafe {
            std::ptr::copy_nonoverlapping(output.as_ptr(), output_pointer, output_length);
        }
    }
    Some(pack_output(output_pointer as usize, output_length))
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
        convert_n_best_with_dictionary_or_fallback, convert_with_active_dictionary, pack_output,
        serialize_n_best, AzooKeyDictionary, ConversionCandidate, DictionaryPaths,
        PrecedingContext, ACTIVE_DICTIONARY, N_BEST_STATUS_FALLBACK,
        N_BEST_STATUS_INVALID_ARGUMENT,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_dictionary_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "caption-bridge-wasm-{label}-{}-{}.tsv",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ))
    }

    fn read_u32(bytes: &[u8], offset: &mut usize) -> u32 {
        let end = offset.checked_add(4).expect("u32 offset should not overflow");
        let value = u32::from_le_bytes(
            bytes
                .get(*offset..end)
                .expect("serialized output should contain a u32")
                .try_into()
                .expect("u32 has four bytes"),
        );
        *offset = end;
        value
    }

    fn read_u16(bytes: &[u8], offset: &mut usize) -> u16 {
        let end = offset.checked_add(2).expect("u16 offset should not overflow");
        let value = u16::from_le_bytes(
            bytes
                .get(*offset..end)
                .expect("serialized output should contain a u16")
                .try_into()
                .expect("u16 has two bytes"),
        );
        *offset = end;
        value
    }

    fn read_f32(bytes: &[u8], offset: &mut usize) -> f32 {
        let end = offset.checked_add(4).expect("f32 offset should not overflow");
        let value = f32::from_le_bytes(
            bytes
                .get(*offset..end)
                .expect("serialized output should contain an f32")
                .try_into()
                .expect("f32 has four bytes"),
        );
        *offset = end;
        value
    }

    fn read_candidate<'a>(bytes: &'a [u8], offset: &mut usize) -> (&'a str, f32, u8, u16, u16) {
        let text_length = read_u32(bytes, offset) as usize;
        let text_end = offset.checked_add(text_length).expect("text offset should not overflow");
        let text = std::str::from_utf8(
            bytes.get(*offset..text_end).expect("serialized output should contain candidate text"),
        )
        .expect("candidate text should be UTF-8");
        *offset = text_end;
        let score = read_f32(bytes, offset);
        let has_trailing = *bytes.get(*offset).expect("serialized output should contain a flag");
        *offset += 1;
        let rcid = read_u16(bytes, offset);
        let mid = read_u16(bytes, offset);
        (text, score, has_trailing, rcid, mid)
    }

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

    #[test]
    fn n_best_serializes_three_dictionary_candidates() {
        let path = temporary_dictionary_path("three");
        fs::write(
            &path,
            "ぬへも\t候補甲\t-1\nぬへも\t候補乙\t-2\nぬへも\t候補丙\t-3\nぬへも\t候補丁\t-4\n",
        )
        .expect("fixture should write");
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(path.clone()),
            ..DictionaryPaths::default()
        })
        .expect("TSV dictionary should load");

        let (candidates, status) =
            convert_n_best_with_dictionary_or_fallback("ぬへも", 3, None, Some(&dictionary));
        assert_eq!(status, 0);
        assert_eq!(candidates.len(), 3, "the requested N-best width must be preserved");
        let bytes = serialize_n_best(status, &candidates).expect("serialization should succeed");
        let mut offset = 0;
        assert_eq!(read_u32(&bytes, &mut offset), 0);
        assert_eq!(read_u32(&bytes, &mut offset), 3);
        for _ in 0..3 {
            let (text, score, has_trailing, _, _) = read_candidate(&bytes, &mut offset);
            assert!(!text.is_empty());
            assert!(score.is_finite());
            assert!(has_trailing <= 1);
        }
        assert_eq!(offset, bytes.len());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn n_best_never_exceeds_available_candidates() {
        let dictionary = AzooKeyDictionary::default();
        let (candidates, status) =
            convert_n_best_with_dictionary_or_fallback("", 3, None, Some(&dictionary));
        assert_eq!(status, 0);
        assert_eq!(candidates.len(), 1);
        let bytes = serialize_n_best(status, &candidates).expect("serialization should succeed");
        let mut offset = 0;
        assert_eq!(read_u32(&bytes, &mut offset), 0);
        assert_eq!(read_u32(&bytes, &mut offset), 1);
        let (text, score, has_trailing, rcid, mid) = read_candidate(&bytes, &mut offset);
        assert_eq!(text, "");
        assert_eq!(score, 0.0);
        assert_eq!((has_trailing, rcid, mid), (0, 0, 0));
        assert_eq!(offset, bytes.len());
    }

    #[test]
    fn n_best_zero_returns_an_empty_successful_record() {
        let dictionary = AzooKeyDictionary::default();
        let (candidates, status) = convert_n_best_with_dictionary_or_fallback(
            "きょうははいしんです",
            0,
            None,
            Some(&dictionary),
        );
        assert_eq!(status, 0);
        assert!(candidates.is_empty());
        assert_eq!(serialize_n_best(status, &candidates), Some(vec![0; 8]));
    }

    #[test]
    fn n_best_fallback_sets_a_degraded_status() {
        let (candidates, status) =
            convert_n_best_with_dictionary_or_fallback("きょうははいしんです", 3, None, None);
        assert_ne!(status & N_BEST_STATUS_FALLBACK, 0, "fallback must be observable to the caller");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].text, "今日は配信です");
    }

    #[test]
    fn n_best_rejects_a_null_pointer_with_nonzero_length() {
        let result = unsafe { super::azookey_convert_n_best(std::ptr::null(), 1, 3, 0, 0, 0) };
        assert_eq!(result, 0);
    }

    #[test]
    fn invalid_preceding_context_is_reported_without_discarding_candidates() {
        let dictionary = AzooKeyDictionary::default();
        let (preceding, status) = super::parse_preceding_context(2, 0, 0);
        assert!(preceding.is_none());
        assert_ne!(status & N_BEST_STATUS_INVALID_ARGUMENT, 0);
        let (candidates, conversion_status) = convert_n_best_with_dictionary_or_fallback(
            "きょうははいしんです",
            1,
            preceding,
            Some(&dictionary),
        );
        assert_eq!(conversion_status, 0);
        assert_eq!(candidates.len(), 1);
    }

    #[test]
    fn n_best_serializes_present_and_absent_trailing_context() {
        let candidates = vec![
            ConversionCandidate {
                text: "候補".to_string(),
                score: -1.25,
                trailing: Some(PrecedingContext { rcid: 17, mid: 29 }),
            },
            ConversionCandidate { text: "かな".to_string(), score: -2.5, trailing: None },
        ];
        let bytes = serialize_n_best(0, &candidates).expect("serialization should succeed");
        let mut offset = 0;
        assert_eq!(read_u32(&bytes, &mut offset), 0);
        assert_eq!(read_u32(&bytes, &mut offset), 2);
        let (text, score, has_trailing, rcid, mid) = read_candidate(&bytes, &mut offset);
        assert_eq!((text, score, has_trailing, rcid, mid), ("候補", -1.25, 1, 17, 29));
        let (text, score, has_trailing, rcid, mid) = read_candidate(&bytes, &mut offset);
        assert_eq!((text, score, has_trailing, rcid, mid), ("かな", -2.5, 0, 0, 0));
        assert_eq!(offset, bytes.len());
    }

    #[test]
    fn preceding_context_changes_a_system_dictionary_result() {
        let system_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../submodules/azooKey_dictionary_storage/Dictionary");
        assert!(system_path.is_dir(), "checked-in system dictionary should be available");
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(system_path),
            ..DictionaryPaths::default()
        })
        .expect("system dictionary should load");

        // Use context ids emitted by real dictionary rows rather than a magic
        // id that could be rejected as out of range by a future dictionary.
        // A context affects the first edge's connection cost, so at least one
        // common reading must expose a score or ranking change when it is
        // supplied instead of starting from BOS.
        let readings = ["はし", "かみ", "あめ", "きょう", "こうせい", "かんじ", "せいこう"];
        let contexts = readings
            .iter()
            .flat_map(|reading| dictionary.lookup_exact(reading).unwrap_or_default())
            .map(|entry| PrecedingContext { rcid: entry.rcid, mid: entry.mid })
            .take(24)
            .collect::<Vec<_>>();
        assert!(!contexts.is_empty(), "system dictionary should expose context ids");

        let mut changed = None;
        'search: for input in readings {
            let (baseline, baseline_status) =
                convert_n_best_with_dictionary_or_fallback(input, 1, None, Some(&dictionary));
            assert_eq!(baseline_status, 0);
            for context in &contexts {
                let (contextual, contextual_status) = convert_n_best_with_dictionary_or_fallback(
                    input,
                    1,
                    Some(*context),
                    Some(&dictionary),
                );
                assert_eq!(contextual_status, 0);
                if contextual != baseline {
                    changed = Some((input, *context, baseline, contextual));
                    break 'search;
                }
            }
        }
        assert!(changed.is_some(), "preceding context must affect conversion output");
    }
}
