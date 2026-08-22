//! Minimal CSS-like color helpers for the renderer.

/// Parse a 6-digit hex color like `#061018` into RGB bytes.
pub fn parse_hex(hex: &str) -> Option<(u8, u8, u8)> {
    let trimmed = hex.trim();
    let without_hash = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if without_hash.len() == 6 {
        let r = u8::from_str_radix(&without_hash[0..2], 16).ok()?;
        let g = u8::from_str_radix(&without_hash[2..4], 16).ok()?;
        let b = u8::from_str_radix(&without_hash[4..6], 16).ok()?;
        Some((r, g, b))
    } else {
        None
    }
}
