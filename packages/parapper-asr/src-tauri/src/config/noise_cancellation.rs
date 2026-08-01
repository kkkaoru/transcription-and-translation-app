use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
pub enum NoiseCancellationModel {
    #[serde(rename = "ul_unas")]
    #[default]
    UlUnas,
}
