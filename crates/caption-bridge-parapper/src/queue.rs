//! Bounded, synchronous port of Parapper's output queue.

use std::collections::{HashMap, VecDeque};

use crate::protocol::TurnOutput;

pub const MAX_PENDING: usize = 32;
pub const MAX_TRACKED_TURNS: usize = 128;
pub const DEFAULT_IDLE_TIMEOUT_MS: u64 = 8_000;

pub trait Clock {
    fn now_ms(&self) -> u64;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis() as u64)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedOutput {
    pub output: TurnOutput,
    pub is_final: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DropReason {
    Closed,
    StaleRevision,
    Duplicate,
    TruncatedRewrite,
    Overflow,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueueDecision {
    Accepted(Box<QueuedOutput>),
    Dropped(DropReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct QueueStats {
    pub processed: usize,
    pub dropped_partials: usize,
    pub dropped_finals: usize,
    pub pending: usize,
    pub tracked_turns: usize,
    pub in_flight: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleState {
    Idle,
    Waiting,
    TimedOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct TurnKey {
    session_id: u64,
    turn_session_id: u64,
    turn_id: u64,
}

impl TurnKey {
    fn from(output: &TurnOutput) -> Self {
        Self {
            session_id: stable_session_key(&output.session_id),
            turn_session_id: output.turn_session_id,
            turn_id: output.turn_id,
        }
    }
}

fn stable_session_key(session_id: &str) -> u64 {
    session_id.bytes().fold(14695981039346656037_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(1099511628211)
    })
}

fn surface(output: &TurnOutput) -> &str {
    output.source_text.as_deref().filter(|text| !text.trim().is_empty()).unwrap_or(&output.text)
}

fn shorter_rewrite(candidate: &QueuedOutput, current: &QueuedOutput) -> bool {
    let candidate_text = surface(&candidate.output).trim();
    let current_text = surface(&current.output).trim();
    !candidate_text.is_empty()
        && !current_text.is_empty()
        && candidate_text.chars().count() < current_text.chars().count()
        && current_text.contains(candidate_text)
}

fn compare_cursor(candidate: &QueuedOutput, current: &QueuedOutput) -> std::cmp::Ordering {
    candidate
        .output
        .revision
        .cmp(&current.output.revision)
        .then_with(|| candidate.output.output_sequence.cmp(&current.output.output_sequence))
        .then_with(|| candidate.output.segment_id.cmp(&current.output.segment_id))
        .then_with(|| candidate.is_final.cmp(&current.is_final))
}

pub struct OutputQueue {
    pending: VecDeque<QueuedOutput>,
    latest_by_turn: HashMap<TurnKey, QueuedOutput>,
    in_flight: bool,
    closed: bool,
    processed: usize,
    dropped_partials: usize,
    dropped_finals: usize,
    idle_started_at: Option<u64>,
}

impl Default for OutputQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl OutputQueue {
    pub fn new() -> Self {
        Self {
            pending: VecDeque::new(),
            latest_by_turn: HashMap::new(),
            in_flight: false,
            closed: false,
            processed: 0,
            dropped_partials: 0,
            dropped_finals: 0,
            idle_started_at: None,
        }
    }

    pub fn enqueue(&mut self, item: QueuedOutput) -> QueueDecision {
        if self.closed {
            return QueueDecision::Dropped(DropReason::Closed);
        }
        let key = TurnKey::from(&item.output);
        if let Some(current) = self.latest_by_turn.get(&key) {
            let stale = compare_cursor(&item, current).is_lt();
            let duplicate =
                compare_cursor(&item, current).is_eq() && item.is_final == current.is_final;
            let late_partial =
                current.is_final && !item.is_final && !shorter_rewrite(current, &item);
            if stale || duplicate || late_partial {
                self.record_drop(item.is_final);
                return QueueDecision::Dropped(if stale {
                    DropReason::StaleRevision
                } else {
                    DropReason::Duplicate
                });
            }
            if !item.is_final && shorter_rewrite(&item, current) {
                self.record_drop(false);
                return QueueDecision::Dropped(DropReason::TruncatedRewrite);
            }
        }
        if !item.is_final {
            if let Some(index) = self
                .pending
                .iter()
                .rposition(|queued| !queued.is_final && TurnKey::from(&queued.output) == key)
            {
                self.pending[index] = item.clone();
                self.record_drop(false);
            } else {
                self.pending.push_back(item.clone());
            }
        } else {
            self.pending.retain(|queued| {
                let same_turn = TurnKey::from(&queued.output) == key;
                if same_turn && !queued.is_final && !shorter_rewrite(queued, &item) {
                    self.dropped_partials += 1;
                    false
                } else {
                    true
                }
            });
            self.pending.push_back(item.clone());
        }
        self.latest_by_turn.insert(key, item.clone());
        self.bound_pending();
        self.idle_started_at = None;
        QueueDecision::Accepted(Box::new(item))
    }

    pub fn pop_next(&mut self) -> Option<QueuedOutput> {
        if self.closed || self.in_flight {
            return None;
        }
        let item = self.pending.pop_front()?;
        self.in_flight = true;
        Some(item)
    }

    pub fn complete_current(&mut self) {
        if self.in_flight {
            self.in_flight = false;
            self.processed += 1;
        }
    }

    pub fn drain<F>(&mut self, mut process: F)
    where
        F: FnMut(&QueuedOutput),
    {
        while let Some(item) = self.pop_next() {
            process(&item);
            self.complete_current();
        }
    }

    pub fn idle_state<C: Clock>(&mut self, clock: &C, timeout_ms: u64) -> IdleState {
        if self.is_idle() {
            self.idle_started_at = None;
            return IdleState::Idle;
        }
        let now = clock.now_ms();
        let started = *self.idle_started_at.get_or_insert(now);
        if now.saturating_sub(started) >= timeout_ms.max(1) {
            IdleState::TimedOut
        } else {
            IdleState::Waiting
        }
    }

    pub fn close(&mut self) {
        self.closed = true;
        self.pending.clear();
        self.latest_by_turn.clear();
        self.in_flight = false;
        self.idle_started_at = None;
    }

    pub fn is_idle(&self) -> bool {
        !self.in_flight && self.pending.is_empty()
    }

    pub fn stats(&self) -> QueueStats {
        QueueStats {
            processed: self.processed,
            dropped_partials: self.dropped_partials,
            dropped_finals: self.dropped_finals,
            pending: self.pending.len(),
            tracked_turns: self.latest_by_turn.len(),
            in_flight: self.in_flight,
        }
    }

    fn record_drop(&mut self, is_final: bool) {
        if is_final {
            self.dropped_finals += 1;
        } else {
            self.dropped_partials += 1;
        }
    }

    fn bound_pending(&mut self) {
        while self.pending.len() > MAX_PENDING {
            let drop_index = self.pending.iter().position(|item| !item.is_final).unwrap_or(0);
            let _ = self.pending.remove(drop_index);
            self.record_drop(false);
        }
        while self.latest_by_turn.len() > MAX_TRACKED_TURNS {
            let Some(key) = self.latest_by_turn.keys().next().copied() else {
                break;
            };
            self.latest_by_turn.remove(&key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::TurnOutput;

    struct FakeClock(u64);
    impl Clock for FakeClock {
        fn now_ms(&self) -> u64 {
            self.0
        }
    }

    fn output(text: &str, revision: u64, is_final: bool) -> QueuedOutput {
        QueuedOutput {
            output: TurnOutput {
                version: 1,
                session_id: "s".to_string(),
                turn_session_id: 1,
                turn_id: 1,
                revision,
                output_sequence: revision,
                segment_id: 1,
                previous_segment_id: None,
                text: text.to_string(),
                source_text: Some(text.to_string()),
                azookey_input_text: None,
                source_asr_model: "model".to_string(),
                source_language: "ja".to_string(),
                detected_language: None,
                elapsed_ms: 1,
                audio_duration_ms: None,
                latency: Default::default(),
            },
            is_final,
        }
    }

    #[test]
    fn processes_interim_then_final_in_order() {
        let mut queue = OutputQueue::new();
        assert!(matches!(queue.enqueue(output("いま", 1, false)), QueueDecision::Accepted(_)));
        assert!(matches!(queue.enqueue(output("いまです", 2, true)), QueueDecision::Accepted(_)));
        let mut seen = Vec::new();
        queue.drain(|item| seen.push(item.output.text.clone()));
        assert_eq!(seen, vec!["いま", "いまです"]);
        assert_eq!(queue.stats().processed, 2);
    }

    #[test]
    fn drops_stale_shorter_revision() {
        let mut queue = OutputQueue::new();
        let _ = queue.enqueue(output("今日はいい天気です", 2, false));
        let decision = queue.enqueue(output("今日は", 3, false));
        assert_eq!(decision, QueueDecision::Dropped(DropReason::TruncatedRewrite));
        assert_eq!(queue.stats().dropped_partials, 1);
    }

    #[test]
    fn injected_clock_reports_idle_timeout() {
        let mut queue = OutputQueue::new();
        let _ = queue.enqueue(output("保留", 1, false));
        let _ = queue.pop_next();
        let first = queue.idle_state(&FakeClock(100), 50);
        assert_eq!(first, IdleState::Waiting);
        let second = queue.idle_state(&FakeClock(151), 50);
        assert_eq!(second, IdleState::TimedOut);
        queue.complete_current();
        assert_eq!(queue.idle_state(&FakeClock(151), 50), IdleState::Idle);
    }
}
