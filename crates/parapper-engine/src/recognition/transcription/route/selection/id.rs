use std::path::Path;

use crate::{
    config::ParapperConfig,
    recognition::{
        control::engine_cache::build_language_id_engine,
        transcription::route::language_id::LanguageDetector,
    },
};

pub(crate) fn build_id_detector(
    models_root: &Path,
    config: &ParapperConfig,
) -> Option<Box<dyn LanguageDetector>> {
    match build_language_id_engine(models_root, config) {
        Ok(Some(engine)) => Some(Box::new(engine)),
        Ok(None) => None,
        Err(error) => {
            log::warn!("Failed to initialize language identification: {error}");
            None
        }
    }
}
