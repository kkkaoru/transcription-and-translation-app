//! Caption fonts embedded once for Native raster and Browser Source output.

#![forbid(unsafe_code)]

/// Typographic family declared by the bundled Google Fonts variable face.
pub const NOTO_SANS_JP_FAMILY: &str = "Noto Sans JP";
/// Stable Browser Source path for the bundled variable font.
pub const NOTO_SANS_JP_BROWSER_PATH: &str = "/fonts/NotoSansJP-Variable.ttf";
/// Official Google Fonts Noto Sans JP variable TTF, licensed under SIL OFL 1.1.
pub static NOTO_SANS_JP_VARIABLE_TTF: &[u8] = include_bytes!("../assets/NotoSansJP-Variable.ttf");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_font_has_a_complete_truetype_payload() {
        assert_eq!(&NOTO_SANS_JP_VARIABLE_TTF[..4], b"\0\x01\0\0");
        assert!(NOTO_SANS_JP_VARIABLE_TTF.len() > 9_000_000);
    }
}
