//! Allocation-conscious helpers shared by the live Native runtime and its benchmark.

use std::time::Duration;

/// PCM samples in one 32 ms frame at the 16 kHz recognition rate.
pub const NATIVE_PCM_FRAME_SAMPLES: usize = 512;

/// Maximum interval between output-window liveness checks when the caption is unchanged.
pub const OUTPUT_WINDOW_HEALTH_INTERVAL: Duration = Duration::from_millis(250);

/// Normalize one PCM16 frame into a reusable f32 buffer.
pub fn normalize_pcm16_into(samples: &[i16], output: &mut Vec<f32>) {
    output.clear();
    output.extend(samples.iter().map(|sample| f32::from(*sample) / 32_768.0));
}

/// Return true only when a caption copy is required.
pub fn caption_changed(
    previous: Option<&(String, String)>,
    source: &str,
    translation: &str,
) -> bool {
    previous.is_none_or(|caption| caption.0 != source || caption.1 != translation)
}

/// Keep output-window closure detection bounded without crossing GPUI windows every active poll.
pub fn should_check_output_window(output_changed: bool, since_last_check: Duration) -> bool {
    output_changed || since_last_check >= OUTPUT_WINDOW_HEALTH_INTERVAL
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{
        caption_changed, normalize_pcm16_into, should_check_output_window, NATIVE_PCM_FRAME_SAMPLES,
    };

    #[test]
    fn normalization_preserves_full_scale_and_reuses_the_preallocated_buffer() {
        let mut output = Vec::with_capacity(NATIVE_PCM_FRAME_SAMPLES);
        normalize_pcm16_into(&[-32_768, 0, 16_384, 32_767], &mut output);
        assert_eq!(output, vec![-1.0, 0.0, 0.5, 0.9999695]);
        let capacity = output.capacity();
        let allocation = output.as_ptr();

        normalize_pcm16_into(&[8_192, -8_192], &mut output);

        assert_eq!(output, vec![0.25, -0.25]);
        assert_eq!(output.capacity(), capacity);
        assert_eq!(output.as_ptr(), allocation);
    }

    #[test]
    fn caption_change_detection_avoids_unchanged_string_copies() {
        let previous = ("こんにちは".to_string(), "Hello".to_string());

        assert!(!caption_changed(Some(&previous), "こんにちは", "Hello"));
        assert!(caption_changed(Some(&previous), "こんばんは", "Hello"));
        assert!(caption_changed(Some(&previous), "こんにちは", "Hi"));
        assert!(caption_changed(None, "", ""));
    }

    #[test]
    fn unchanged_output_checks_window_liveness_at_four_hertz() {
        assert!(!should_check_output_window(false, Duration::from_millis(249)));
        assert!(should_check_output_window(false, Duration::from_millis(250)));
        assert!(should_check_output_window(true, Duration::ZERO));
    }
}
