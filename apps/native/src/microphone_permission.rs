//! Explicit macOS microphone authorization before CoreAudio stream creation.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AuthorizationStatus {
    NotDetermined,
    Restricted,
    Denied,
    Authorized,
    Unknown,
}

impl AuthorizationStatus {
    fn from_raw(raw: i32) -> Self {
        match raw {
            0 => Self::NotDetermined,
            1 => Self::Restricted,
            2 => Self::Denied,
            3 => Self::Authorized,
            _ => Self::Unknown,
        }
    }
}

fn resolve_authorization(status: AuthorizationStatus, request: impl FnOnce() -> bool) -> bool {
    match status {
        AuthorizationStatus::Authorized => true,
        AuthorizationStatus::NotDetermined => request(),
        AuthorizationStatus::Restricted
        | AuthorizationStatus::Denied
        | AuthorizationStatus::Unknown => false,
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;
    use std::sync::mpsc;

    use super::{resolve_authorization, AuthorizationStatus};

    extern "C" {
        fn kotoba_microphone_authorization_status() -> i32;
        fn kotoba_request_microphone_access(
            callback: extern "C" fn(u8, *mut c_void),
            context: *mut c_void,
        );
    }

    extern "C" fn permission_callback(granted: u8, context: *mut c_void) {
        // SAFETY: `request_access` allocates exactly one sender for the AVFoundation
        // completion handler, which Apple invokes exactly once.
        let sender = unsafe { Box::from_raw(context.cast::<mpsc::SyncSender<bool>>()) };
        let _ = sender.send(granted != 0);
    }

    fn request_access() -> bool {
        let (sender, receiver) = mpsc::sync_channel(1);
        let context = Box::into_raw(Box::new(sender)).cast::<c_void>();
        // SAFETY: The Objective-C shim retains its completion block and returns the
        // same opaque context to `permission_callback` exactly once.
        unsafe { kotoba_request_microphone_access(permission_callback, context) };
        receiver.recv().unwrap_or(false)
    }

    pub(super) fn ensure_microphone_access() -> bool {
        // SAFETY: The shim returns the integer value of AVAuthorizationStatus.
        let status = unsafe { kotoba_microphone_authorization_status() };
        resolve_authorization(AuthorizationStatus::from_raw(status), request_access)
    }
}

#[cfg(target_os = "macos")]
pub fn ensure_microphone_access() -> bool {
    platform::ensure_microphone_access()
}

#[cfg(not(target_os = "macos"))]
pub fn ensure_microphone_access() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::{resolve_authorization, AuthorizationStatus};

    #[test]
    fn undetermined_microphone_permission_requests_access() {
        let requested = Cell::new(false);
        let granted = resolve_authorization(AuthorizationStatus::NotDetermined, || {
            requested.set(true);
            true
        });

        assert!(requested.get());
        assert!(granted);
    }

    #[test]
    fn denied_microphone_permission_does_not_request_again() {
        let requested = Cell::new(false);
        let granted = resolve_authorization(AuthorizationStatus::Denied, || {
            requested.set(true);
            true
        });

        assert!(!requested.get());
        assert!(!granted);
    }

    #[test]
    fn authorized_microphone_permission_bypasses_request() {
        let requested = Cell::new(false);
        let granted = resolve_authorization(AuthorizationStatus::Authorized, || {
            requested.set(true);
            false
        });

        assert!(!requested.get());
        assert!(granted);
    }

    #[test]
    fn raw_authorization_status_matches_avfoundation_values() {
        assert_eq!(AuthorizationStatus::from_raw(0), AuthorizationStatus::NotDetermined);
        assert_eq!(AuthorizationStatus::from_raw(1), AuthorizationStatus::Restricted);
        assert_eq!(AuthorizationStatus::from_raw(2), AuthorizationStatus::Denied);
        assert_eq!(AuthorizationStatus::from_raw(3), AuthorizationStatus::Authorized);
        assert_eq!(AuthorizationStatus::from_raw(99), AuthorizationStatus::Unknown);
    }
}
