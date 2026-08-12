use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

/// Monotonic millisecond clock used for speech→caption spans.
///
/// Values are milliseconds from an arbitrary origin (session start, or a test
/// epoch). They are **not** wall-clock Unix time. Deltas between fields on the
/// same turn are meaningful; absolute values are not comparable across sessions.
pub(crate) trait CaptionClock: Send + Sync {
    fn now_millis(&self) -> u64;
}

/// Production clock: milliseconds since this instance was constructed.
pub(crate) struct MonotonicCaptionClock {
    origin: Instant,
}

impl MonotonicCaptionClock {
    pub(crate) fn new() -> Self {
        Self { origin: Instant::now() }
    }
}

impl CaptionClock for MonotonicCaptionClock {
    fn now_millis(&self) -> u64 {
        u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

/// Test clock: tests advance this explicitly so spans do not depend on wall time.
#[derive(Clone)]
pub(crate) struct InjectedCaptionClock {
    millis: Arc<AtomicU64>,
}

impl InjectedCaptionClock {
    pub(crate) fn new(start_millis: u64) -> Self {
        Self { millis: Arc::new(AtomicU64::new(start_millis)) }
    }

    pub(crate) fn set(&self, millis: u64) {
        self.millis.store(millis, Ordering::SeqCst);
    }
}

impl CaptionClock for InjectedCaptionClock {
    fn now_millis(&self) -> u64 {
        self.millis.load(Ordering::SeqCst)
    }
}
