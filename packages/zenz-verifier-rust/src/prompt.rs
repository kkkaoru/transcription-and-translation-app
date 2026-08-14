use caption_bridge_azookey_rust::SessionContext;
use std::error::Error;
use std::fmt;
use unicode_segmentation::UnicodeSegmentation;

pub const DEFAULT_CONTEXT_MAX_GRAPHEMES: usize = 40;
pub const INPUT_TAG: char = '\u{ee00}';
pub const OUTPUT_TAG: char = '\u{ee01}';
pub const LEFT_CONTEXT_TAG: char = '\u{ee02}';
pub const RIGHT_CONTEXT_TAG: char = '\u{ee07}';

/// Text fields used by the Zenz v3 candidate-evaluation prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CandidatePrompt<'a> {
    pub left_context: &'a str,
    pub right_context: &'a str,
    pub input: &'a str,
}

impl CandidatePrompt<'_> {
    /// Builds the exact v3 prompt consumed by the embedded verifier.
    ///
    /// A context tag is emitted only when that context is non-empty, matching
    /// upstream `ZenzPromptBuilder.candidateEvaluationPrompt`. Empty tags are
    /// not a neutral placeholder: they would make the model read a different,
    /// unseen prompt.
    pub fn build(&self) -> String {
        build_candidate_prompt(self.left_context, self.right_context, self.input)
    }
}

/// Optional `U+EE02{left}`, optional `U+EE07{right}`, then
/// `U+EE00{input} U+EE01`, without spaces.
pub fn build_candidate_prompt(left_context: &str, right_context: &str, input: &str) -> String {
    let left_graphemes = UnicodeSegmentation::graphemes(left_context, true).collect::<Vec<_>>();
    let left_start = left_graphemes.len().saturating_sub(DEFAULT_CONTEXT_MAX_GRAPHEMES);
    let trimmed_left = left_graphemes[left_start..].concat();
    let trimmed_right = UnicodeSegmentation::graphemes(right_context, true)
        .take(DEFAULT_CONTEXT_MAX_GRAPHEMES)
        .collect::<String>();
    let capacity = trimmed_left.len() + trimmed_right.len() + input.len() + 12;
    let mut prompt = String::with_capacity(capacity);
    if !trimmed_left.is_empty() {
        prompt.push(LEFT_CONTEXT_TAG);
        prompt.push_str(&trimmed_left);
    }
    if !trimmed_right.is_empty() {
        prompt.push(RIGHT_CONTEXT_TAG);
        prompt.push_str(&trimmed_right);
    }
    prompt.push(INPUT_TAG);
    prompt.push_str(input);
    prompt.push(OUTPUT_TAG);
    prompt
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptError {
    InvalidInputUtf8,
    InvalidLeftContextUtf8,
    InvalidRightContextUtf8,
}

impl fmt::Display for PromptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInputUtf8 => formatter.write_str("session input is not valid UTF-8"),
            Self::InvalidLeftContextUtf8 => {
                formatter.write_str("session left context is not valid UTF-8")
            }
            Self::InvalidRightContextUtf8 => {
                formatter.write_str("session right context is not valid UTF-8")
            }
        }
    }
}

impl Error for PromptError {}

impl<'a> TryFrom<&'a SessionContext> for CandidatePrompt<'a> {
    type Error = PromptError;

    fn try_from(context: &'a SessionContext) -> Result<Self, Self::Error> {
        let input = std::str::from_utf8(&context.input_prefix)
            .map_err(|_| PromptError::InvalidInputUtf8)?;
        let left_context = context
            .left_context
            .as_deref()
            .map(std::str::from_utf8)
            .transpose()
            .map_err(|_| PromptError::InvalidLeftContextUtf8)?
            .unwrap_or_default();
        let right_context = context
            .right_context
            .as_deref()
            .map(std::str::from_utf8)
            .transpose()
            .map_err(|_| PromptError::InvalidRightContextUtf8)?
            .unwrap_or_default();
        Ok(Self { left_context, right_context, input })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_prompt_pins_all_v3_context_tag_combinations() {
        assert_eq!(
            build_candidate_prompt("前", "後", "入力"),
            "\u{ee02}前\u{ee07}後\u{ee00}入力\u{ee01}",
            "left and right context tags must retain upstream order"
        );
        assert_eq!(
            build_candidate_prompt("前", "", "入力"),
            "\u{ee02}前\u{ee00}入力\u{ee01}",
            "an empty right context must omit EE07"
        );
        assert_eq!(
            build_candidate_prompt("", "後", "入力"),
            "\u{ee07}後\u{ee00}入力\u{ee01}",
            "an empty left context must omit EE02"
        );
        assert_eq!(
            build_candidate_prompt("", "", "入力"),
            "\u{ee00}入力\u{ee01}",
            "no-context v3 is the upstream compact form, without empty tags"
        );
    }

    #[test]
    fn context_limits_count_graphemes_not_scalars() {
        let family = "👨‍👩‍👧‍👦";
        let combining = "e\u{301}";
        let left = format!("drop{family}{}", combining.repeat(39));
        let right = format!("{family}{}drop", combining.repeat(39));
        let prompt = build_candidate_prompt(&left, &right, "入力");
        assert_eq!(
            prompt,
            format!(
                "{LEFT_CONTEXT_TAG}{family}{}{RIGHT_CONTEXT_TAG}{family}{}{INPUT_TAG}入力{OUTPUT_TAG}",
                combining.repeat(39),
                combining.repeat(39),
            )
        );
    }

    #[test]
    fn session_bytes_are_validated_per_field() {
        let mut context = SessionContext::new("かな", 1, "mock-v1");
        context.left_context = Some(vec![0xff]);
        assert_eq!(CandidatePrompt::try_from(&context), Err(PromptError::InvalidLeftContextUtf8));
    }
}
