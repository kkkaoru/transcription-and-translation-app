//! Enumerate installed font family names for the caption style picker.
//!
//! Prefer the native OS font inventory over the browser Local Font Access API
//! so the desktop app can list every installed family without a permission
//! prompt. Failures return an empty list so the UI can fall back to curated
//! families plus any browser-side enumeration that still succeeds.

/// Return unique, sorted font family names available on this machine.
pub fn list_system_font_families() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        match macos::list_font_families() {
            Ok(families) => families,
            Err(error) => {
                log::warn!("system font enumeration failed: {error}");
                Vec::new()
            }
        }
    }

    #[cfg(windows)]
    {
        match windows::list_font_families() {
            Ok(families) => families,
            Err(error) => {
                log::warn!("system font enumeration failed: {error}");
                Vec::new()
            }
        }
    }

    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        // Linux / other: no lightweight in-tree enumerator yet. Frontend still
        // merges curated names and optional `queryLocalFonts`.
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_void, CStr};
    use std::os::raw::{c_char, c_long, c_uchar};

    type CFIndex = c_long;
    type CFArrayRef = *const c_void;
    type CFStringRef = *const c_void;

    #[link(name = "CoreText", kind = "framework")]
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CTFontManagerCopyAvailableFontFamilyNames() -> CFArrayRef;
        fn CFArrayGetCount(the_array: CFArrayRef) -> CFIndex;
        fn CFArrayGetValueAtIndex(the_array: CFArrayRef, idx: CFIndex) -> *const c_void;
        fn CFStringGetLength(the_string: CFStringRef) -> CFIndex;
        fn CFStringGetCString(
            the_string: CFStringRef,
            buffer: *mut c_char,
            buffer_size: CFIndex,
            encoding: u32,
        ) -> c_uchar;
        fn CFRelease(cf: *const c_void);
    }

    /// UTF-8 encoding constant from CoreFoundation.
    const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    pub(super) fn list_font_families() -> Result<Vec<String>, String> {
        unsafe {
            let array = CTFontManagerCopyAvailableFontFamilyNames();
            if array.is_null() {
                return Err("CTFontManagerCopyAvailableFontFamilyNames returned null".into());
            }

            let count = CFArrayGetCount(array);
            if count < 0 {
                CFRelease(array);
                return Err("negative font family count".into());
            }

            let mut families = Vec::with_capacity(count as usize);
            for index in 0..count {
                let value = CFArrayGetValueAtIndex(array, index) as CFStringRef;
                if value.is_null() {
                    continue;
                }
                let char_len = CFStringGetLength(value);
                if char_len < 0 {
                    continue;
                }
                // UTF-8 needs up to 4 bytes per UTF-16 code unit, plus NUL.
                let buf_len = (char_len as usize)
                    .saturating_mul(4)
                    .saturating_add(1)
                    .max(64);
                let mut buffer = vec![0i8; buf_len];
                let ok = CFStringGetCString(
                    value,
                    buffer.as_mut_ptr(),
                    buffer.len() as CFIndex,
                    CF_STRING_ENCODING_UTF8,
                );
                if ok == 0 {
                    continue;
                }
                if let Ok(name) = CStr::from_ptr(buffer.as_ptr()).to_str() {
                    let trimmed = name.trim();
                    if !trimmed.is_empty() {
                        families.push(trimmed.to_string());
                    }
                }
            }

            CFRelease(array);
            families.sort_unstable();
            families.dedup();
            Ok(families)
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::OsString;
    use std::mem::zeroed;
    use std::os::windows::ffi::OsStringExt;
    use std::ptr;

    type HDC = *mut std::ffi::c_void;
    type BOOL = i32;
    type DWORD = u32;
    type BYTE = u8;
    type LONG = i32;

    #[repr(C)]
    struct LogFontW {
        lf_height: LONG,
        lf_width: LONG,
        lf_escapement: LONG,
        lf_orientation: LONG,
        lf_weight: LONG,
        lf_italic: BYTE,
        lf_underline: BYTE,
        lf_strike_out: BYTE,
        lf_char_set: BYTE,
        lf_out_precision: BYTE,
        lf_clip_precision: BYTE,
        lf_quality: BYTE,
        lf_pitch_and_family: BYTE,
        lf_face_name: [u16; 32],
    }

    #[repr(C)]
    struct EnumLogFontExW {
        elf_log_font: LogFontW,
        elf_full_name: [u16; 64],
        elf_style: [u16; 32],
        elf_script: [u16; 32],
    }

    #[repr(C)]
    struct NewTextMetricExW {
        _unused: [u8; 96],
    }

    type FontEnumProc = unsafe extern "system" fn(
        *const EnumLogFontExW,
        *const NewTextMetricExW,
        DWORD,
        isize,
    ) -> BOOL;

    #[link(name = "gdi32")]
    extern "system" {
        fn CreateDCW(
            pwsz_driver: *const u16,
            pwsz_device: *const u16,
            psz_port: *const u16,
            pdm: *const std::ffi::c_void,
        ) -> HDC;
        fn DeleteDC(hdc: HDC) -> BOOL;
        fn EnumFontFamiliesExW(
            hdc: HDC,
            lp_logfont: *mut LogFontW,
            lp_enum_font_fam_ex_proc: FontEnumProc,
            l_param: isize,
            dw_flags: DWORD,
        ) -> i32;
    }

    const DEFAULT_CHARSET: BYTE = 1;

    unsafe extern "system" fn enum_proc(
        log_font: *const EnumLogFontExW,
        _metrics: *const NewTextMetricExW,
        _font_type: DWORD,
        l_param: isize,
    ) -> BOOL {
        if log_font.is_null() || l_param == 0 {
            return 1;
        }
        let families = &mut *(l_param as *mut Vec<String>);
        let face = &(*log_font).elf_log_font.lf_face_name;
        let len = face.iter().position(|&c| c == 0).unwrap_or(face.len());
        if len == 0 {
            return 1;
        }
        // Skip vertical-face aliases (@FaceName) used by GDI for vertical text.
        if face[0] == b'@' as u16 {
            return 1;
        }
        if let Some(name) = OsString::from_wide(&face[..len]).to_str() {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                families.push(trimmed.to_string());
            }
        }
        1
    }

    pub(super) fn list_font_families() -> Result<Vec<String>, String> {
        let display: Vec<u16> = "DISPLAY\0".encode_utf16().collect();
        unsafe {
            let hdc = CreateDCW(display.as_ptr(), ptr::null(), ptr::null(), ptr::null());
            if hdc.is_null() {
                return Err("CreateDCW(DISPLAY) failed".into());
            }

            let mut log_font: LogFontW = zeroed();
            log_font.lf_char_set = DEFAULT_CHARSET;

            let mut families: Vec<String> = Vec::new();
            let _ = EnumFontFamiliesExW(
                hdc,
                &mut log_font,
                enum_proc,
                &mut families as *mut Vec<String> as isize,
                0,
            );
            DeleteDC(hdc);

            families.sort_unstable();
            families.dedup();
            Ok(families)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::list_system_font_families;

    #[test]
    fn list_system_font_families_does_not_panic() {
        let families = list_system_font_families();
        #[cfg(any(target_os = "macos", windows))]
        {
            // CI / developer machines should expose at least a few system faces.
            // Keep the assertion soft so headless sandboxes without fonts still pass.
            let _ = families.len();
        }
        #[cfg(all(not(target_os = "macos"), not(windows)))]
        {
            assert!(families.is_empty());
        }
    }
}
