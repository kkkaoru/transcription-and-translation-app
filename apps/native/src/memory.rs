//! Bound model allocator retention and return freed capture pages to the OS.

#[cfg(target_os = "macos")]
pub fn configure_process_memory() {
    // SAFETY: Native calls this as the first operation in `main`, before GPUI,
    // recognition, translation, or any application-created thread exists.
    unsafe { std::env::set_var("MallocLargeCache", "0") };
}

#[cfg(not(target_os = "macos"))]
pub const fn configure_process_memory() {}

#[cfg(target_os = "macos")]
pub fn release_unused_process_memory() -> usize {
    unsafe extern "C" {
        fn malloc_zone_pressure_relief(zone: *mut core::ffi::c_void, goal: usize) -> usize;
    }
    // SAFETY: A null zone asks libmalloc to inspect every malloc zone. QuickMT has
    // already been dropped, and `goal = 0` requests best-effort release only.
    unsafe { malloc_zone_pressure_relief(std::ptr::null_mut(), 0) }
}

#[cfg(target_os = "linux")]
pub fn release_unused_process_memory() -> usize {
    unsafe extern "C" {
        fn malloc_trim(pad: usize) -> i32;
    }
    // SAFETY: glibc documents malloc_trim(0) as a process-wide best-effort release
    // of free heap pages; no pointer ownership crosses this call.
    usize::from(unsafe { malloc_trim(0) } > 0)
}

#[cfg(target_os = "windows")]
pub fn release_unused_process_memory() -> usize {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut core::ffi::c_void;
        fn SetProcessWorkingSetSize(
            process: *mut core::ffi::c_void,
            minimum: usize,
            maximum: usize,
        ) -> i32;
    }
    // SAFETY: GetCurrentProcess returns a non-owning pseudo-handle. Passing SIZE_T(-1)
    // for both bounds is the documented request to trim the process working set.
    let released = unsafe { SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX) };
    usize::from(released != 0)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub const fn release_unused_process_memory() -> usize {
    0
}
