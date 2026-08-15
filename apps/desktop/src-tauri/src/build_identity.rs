/// Values written by Vite (`apps/desktop/build-identity.mjs`) so the
/// structured log and the settings screen share one identity.
pub const APP_VERSION: &str = match option_env!("KOTOBA_APP_VERSION") {
    Some(value) if !value.is_empty() => value,
    _ => "unknown",
};
pub const BUILD_ID: &str = match option_env!("KOTOBA_BUILD_ID") {
    Some(value) if !value.is_empty() => value,
    _ => "unknown",
};

#[cfg(test)]
mod tests {
    #[test]
    fn missing_or_blank_embed_is_unknown_not_empty() {
        assert!(!super::APP_VERSION.is_empty());
        assert!(!super::BUILD_ID.is_empty());
        assert_ne!(super::APP_VERSION, "");
        assert_ne!(super::BUILD_ID, "");
    }
}
