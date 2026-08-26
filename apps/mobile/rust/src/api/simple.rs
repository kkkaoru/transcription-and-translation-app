use std::io::Read;
use std::sync::Mutex;

use caption_bridge_azookey_rust::{convert_with_dictionary, AzooKeyDictionary, ConversionOptions};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};

const PROTOCOL_VERSION: u16 = 1;
const MAX_TEXT_CHARACTERS: usize = 2_048;
const MAX_PAIRING_TOKEN_BYTES: usize = 128;
const MAX_DICTIONARY_BYTES: u64 = 256 * 1024 * 1024;

static AZOOKEY_DICTIONARY: Mutex<Option<AzooKeyDictionary>> = Mutex::new(None);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionDevice {
    Desktop,
    Mobile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineRoute {
    pub asr: ExecutionDevice,
    pub azookey: ExecutionDevice,
    pub translation: ExecutionDevice,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MobileCapabilities {
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub asr_available: bool,
    pub azookey_available: bool,
    pub translation_available: bool,
}

impl MobileCapabilities {
    pub fn supports(&self, stage: ProcessingStage) -> bool {
        match stage {
            ProcessingStage::Asr => self.asr_available,
            ProcessingStage::Azookey => self.azookey_available,
            ProcessingStage::Translation => self.translation_available,
        }
    }

    pub fn constrain(&self, route: PipelineRoute) -> PipelineRoute {
        PipelineRoute {
            asr: supported_owner(route.asr, self.asr_available),
            azookey: supported_owner(route.azookey, self.azookey_available),
            translation: supported_owner(route.translation, self.translation_available),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessingStage {
    Asr,
    Azookey,
    Translation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AzooKeyOutput {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairRequest {
    pub token: String,
    pub device_id: String,
    pub device_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionConfiguration {
    pub session_id: String,
    pub route: PipelineRoute,
    pub capabilities: MobileCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MobileStageResult {
    pub message_type: String,
    pub session_id: String,
    pub turn_id: u64,
    pub revision: u64,
    pub text: String,
    pub is_final: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopCommand {
    SessionReady { session_id: String, route: PipelineRoute },
    ConfigureRoute { route: PipelineRoute },
    StartAudio { session_id: String, turn_id: u64, revision: u64 },
    EndAudio { session_id: String, turn_id: u64, revision: u64 },
    RunAzookey { session_id: String, turn_id: u64, revision: u64, text: String, is_final: bool },
    RunTranslation { session_id: String, turn_id: u64, revision: u64, source_text: String },
    StopSession { session_id: String },
    SetTranslationEnabled { enabled: bool },
    Ping { nonce: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct WireEnvelope {
    version: u16,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    is_final: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    route: Option<PipelineRoute>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    capabilities: Option<MobileCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    nonce: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
}

#[cfg(feature = "flutter")]
#[flutter_rust_bridge::frb(init)]
pub fn init_app() {
    flutter_rust_bridge::setup_default_user_utils();
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn default_pipeline_route() -> PipelineRoute {
    PipelineRoute {
        asr: ExecutionDevice::Mobile,
        azookey: ExecutionDevice::Mobile,
        translation: ExecutionDevice::Mobile,
    }
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn all_pipeline_routes() -> Vec<PipelineRoute> {
    vec![
        PipelineRoute {
            asr: ExecutionDevice::Desktop,
            azookey: ExecutionDevice::Desktop,
            translation: ExecutionDevice::Desktop,
        },
        PipelineRoute {
            asr: ExecutionDevice::Desktop,
            azookey: ExecutionDevice::Desktop,
            translation: ExecutionDevice::Mobile,
        },
        PipelineRoute {
            asr: ExecutionDevice::Desktop,
            azookey: ExecutionDevice::Mobile,
            translation: ExecutionDevice::Desktop,
        },
        PipelineRoute {
            asr: ExecutionDevice::Desktop,
            azookey: ExecutionDevice::Mobile,
            translation: ExecutionDevice::Mobile,
        },
        PipelineRoute {
            asr: ExecutionDevice::Mobile,
            azookey: ExecutionDevice::Desktop,
            translation: ExecutionDevice::Desktop,
        },
        PipelineRoute {
            asr: ExecutionDevice::Mobile,
            azookey: ExecutionDevice::Desktop,
            translation: ExecutionDevice::Mobile,
        },
        PipelineRoute {
            asr: ExecutionDevice::Mobile,
            azookey: ExecutionDevice::Mobile,
            translation: ExecutionDevice::Desktop,
        },
        PipelineRoute {
            asr: ExecutionDevice::Mobile,
            azookey: ExecutionDevice::Mobile,
            translation: ExecutionDevice::Mobile,
        },
    ]
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn pipeline_route_id(route: PipelineRoute) -> String {
    format!("{}{}{}", device_id(route.asr), device_id(route.azookey), device_id(route.translation))
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn stage_owner(route: PipelineRoute, stage: ProcessingStage) -> ExecutionDevice {
    match stage {
        ProcessingStage::Asr => route.asr,
        ProcessingStage::Azookey => route.azookey,
        ProcessingStage::Translation => route.translation,
    }
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn should_continue_on_mobile(route: PipelineRoute, completed_stage: ProcessingStage) -> bool {
    match completed_stage {
        ProcessingStage::Asr => {
            route.asr == ExecutionDevice::Mobile && route.azookey == ExecutionDevice::Mobile
        }
        ProcessingStage::Azookey => {
            route.azookey == ExecutionDevice::Mobile && route.translation == ExecutionDevice::Mobile
        }
        ProcessingStage::Translation => false,
    }
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn encode_pair_request(
    token: String,
    device_id: String,
    device_name: String,
) -> Result<String, String> {
    let token = bounded_required_text(token, MAX_PAIRING_TOKEN_BYTES, "pairing token")?;
    let device_id = bounded_required_text(device_id, MAX_TEXT_CHARACTERS, "device ID")?;
    let device_name = bounded_required_text(device_name, MAX_TEXT_CHARACTERS, "device name")?;
    encode(WireEnvelope {
        version: PROTOCOL_VERSION,
        kind: "pair.request".to_string(),
        session_id: None,
        turn_id: None,
        revision: None,
        text: None,
        source_text: None,
        is_final: None,
        token: Some(token),
        device_name: Some(device_name),
        device_id: Some(device_id),
        route: None,
        capabilities: None,
        nonce: None,
        enabled: None,
    })
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn decode_pair_request(json: String) -> Result<PairRequest, String> {
    let envelope = decode_wire(&json)?;
    if envelope.kind != "pair.request" {
        return Err(format!("expected pair.request, received {}", envelope.kind));
    }
    Ok(PairRequest {
        token: bounded_required_text(
            required(envelope.token, "pairing token")?,
            MAX_PAIRING_TOKEN_BYTES,
            "pairing token",
        )?,
        device_id: bounded_required_text(
            required(envelope.device_id, "device ID")?,
            MAX_TEXT_CHARACTERS,
            "device ID",
        )?,
        device_name: bounded_required_text(
            required(envelope.device_name, "device name")?,
            MAX_TEXT_CHARACTERS,
            "device name",
        )?,
    })
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn encode_session_configure(
    session_id: String,
    route: PipelineRoute,
    capabilities: MobileCapabilities,
) -> Result<String, String> {
    let session_id = bounded_required_text(session_id, MAX_TEXT_CHARACTERS, "session ID")?;
    encode(WireEnvelope {
        version: PROTOCOL_VERSION,
        kind: "session.configure".to_string(),
        session_id: Some(session_id),
        turn_id: None,
        revision: None,
        text: None,
        source_text: None,
        is_final: None,
        token: None,
        device_name: None,
        device_id: None,
        route: Some(route),
        capabilities: Some(capabilities),
        nonce: None,
        enabled: None,
    })
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn decode_session_configuration(json: String) -> Result<SessionConfiguration, String> {
    let envelope = decode_wire(&json)?;
    if envelope.kind != "session.configure" {
        return Err(format!("expected session.configure, received {}", envelope.kind));
    }
    Ok(SessionConfiguration {
        session_id: bounded_required_text(
            required(envelope.session_id, "session ID")?,
            MAX_TEXT_CHARACTERS,
            "session ID",
        )?,
        route: required(envelope.route, "pipeline route")?,
        capabilities: validate_mobile_capabilities(required(
            envelope.capabilities,
            "mobile capabilities",
        )?)?,
    })
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn encode_session_ready(session_id: String, route: PipelineRoute) -> Result<String, String> {
    let mut envelope = desktop_envelope("session.ready", session_id, None, None);
    envelope.route = Some(route);
    encode(envelope)
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn encode_route_configuration(route: PipelineRoute) -> Result<String, String> {
    encode_route_message("route.configure", route)
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn encode_route_request(route: PipelineRoute) -> Result<String, String> {
    encode_route_message("route.request", route)
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn decode_mobile_route_request(json: String) -> Result<PipelineRoute, String> {
    let envelope = decode_wire(&json)?;
    if envelope.kind != "route.request" {
        return Err(format!("expected route.request, received {}", envelope.kind));
    }
    required(envelope.route, "pipeline route")
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn encode_audio_boundary(
    message_type: String,
    session_id: String,
    turn_id: u64,
    revision: u64,
) -> Result<String, String> {
    if !matches!(message_type.as_str(), "audio.start" | "audio.end") {
        return Err(format!("unsupported audio boundary: {message_type}"));
    }
    encode_desktop_message(&message_type, session_id, Some(turn_id), Some(revision), None, None)
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn encode_stage_request(
    message_type: String,
    session_id: String,
    turn_id: u64,
    revision: u64,
    text: String,
    is_final: bool,
) -> Result<String, String> {
    if !matches!(message_type.as_str(), "azookey.request" | "translation.request") {
        return Err(format!("unsupported stage request: {message_type}"));
    }
    let mut envelope = desktop_envelope(
        &message_type,
        bounded_required_text(session_id, MAX_TEXT_CHARACTERS, "session ID")?,
        Some(turn_id),
        Some(revision),
    );
    let text = bounded_required_text(text, MAX_TEXT_CHARACTERS, "stage input")?;
    if message_type == "translation.request" {
        envelope.source_text = Some(text);
    } else {
        envelope.text = Some(text);
        envelope.is_final = Some(is_final);
    }
    encode(envelope)
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn decode_mobile_stage_result(json: String) -> Result<MobileStageResult, String> {
    let envelope = decode_wire(&json)?;
    if !matches!(envelope.kind.as_str(), "asr.update" | "azookey.result" | "translation.result") {
        return Err(format!("unsupported mobile result: {}", envelope.kind));
    }
    Ok(MobileStageResult {
        message_type: envelope.kind,
        session_id: required(envelope.session_id, "session ID")?,
        turn_id: required(envelope.turn_id, "turn ID")?,
        revision: required(envelope.revision, "revision")?,
        text: bounded_required_text(
            required(envelope.text, "stage result")?,
            MAX_TEXT_CHARACTERS,
            "stage result",
        )?,
        is_final: required(envelope.is_final, "final marker")?,
    })
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn encode_translation_enabled(session_id: String, enabled: bool) -> Result<String, String> {
    let session_id = bounded_required_text(session_id, MAX_TEXT_CHARACTERS, "session ID")?;
    let mut envelope = desktop_envelope("translation.enabled", session_id, None, None);
    envelope.enabled = Some(enabled);
    encode(envelope)
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn decode_desktop_command(json: String) -> Result<DesktopCommand, String> {
    let envelope = decode_wire(&json)?;
    match envelope.kind.as_str() {
        "session.ready" => Ok(DesktopCommand::SessionReady {
            session_id: required(envelope.session_id, "session ID")?,
            route: required(envelope.route, "pipeline route")?,
        }),
        "route.configure" => Ok(DesktopCommand::ConfigureRoute {
            route: required(envelope.route, "pipeline route")?,
        }),
        "audio.start" => Ok(DesktopCommand::StartAudio {
            session_id: required(envelope.session_id, "session ID")?,
            turn_id: required(envelope.turn_id, "turn ID")?,
            revision: required(envelope.revision, "revision")?,
        }),
        "audio.end" => Ok(DesktopCommand::EndAudio {
            session_id: required(envelope.session_id, "session ID")?,
            turn_id: required(envelope.turn_id, "turn ID")?,
            revision: required(envelope.revision, "revision")?,
        }),
        "azookey.request" => Ok(DesktopCommand::RunAzookey {
            session_id: required(envelope.session_id, "session ID")?,
            turn_id: required(envelope.turn_id, "turn ID")?,
            revision: required(envelope.revision, "revision")?,
            text: bounded_required_text(
                required(envelope.text, "AzooKey input")?,
                MAX_TEXT_CHARACTERS,
                "AzooKey input",
            )?,
            is_final: required(envelope.is_final, "final marker")?,
        }),
        "translation.request" => Ok(DesktopCommand::RunTranslation {
            session_id: required(envelope.session_id, "session ID")?,
            turn_id: required(envelope.turn_id, "turn ID")?,
            revision: required(envelope.revision, "revision")?,
            source_text: bounded_required_text(
                required(envelope.source_text, "translation source")?,
                MAX_TEXT_CHARACTERS,
                "translation source",
            )?,
        }),
        "session.stop" => Ok(DesktopCommand::StopSession {
            session_id: required(envelope.session_id, "session ID")?,
        }),
        "translation.enabled" => Ok(DesktopCommand::SetTranslationEnabled {
            enabled: required(envelope.enabled, "translation enabled marker")?,
        }),
        "ping" => Ok(DesktopCommand::Ping { nonce: required(envelope.nonce, "ping nonce")? }),
        message_type => Err(format!("unsupported desktop command: {message_type}")),
    }
}

#[cfg_attr(feature = "flutter", flutter_rust_bridge::frb(sync))]
pub fn encode_stage_result(
    stage: ProcessingStage,
    session_id: String,
    turn_id: u64,
    revision: u64,
    text: String,
    is_final: bool,
) -> Result<String, String> {
    let message_type = match stage {
        ProcessingStage::Asr => "asr.update",
        ProcessingStage::Azookey => "azookey.result",
        ProcessingStage::Translation => "translation.result",
    };
    let session_id = bounded_required_text(session_id, MAX_TEXT_CHARACTERS, "session ID")?;
    let text = bounded_required_text(text, MAX_TEXT_CHARACTERS, "stage result")?;
    encode(WireEnvelope {
        version: PROTOCOL_VERSION,
        kind: message_type.to_string(),
        session_id: Some(session_id),
        turn_id: Some(turn_id),
        revision: Some(revision),
        text: Some(text),
        source_text: None,
        is_final: Some(is_final),
        token: None,
        device_name: None,
        device_id: None,
        route: None,
        capabilities: None,
        nonce: None,
        enabled: None,
    })
}

pub fn initialize_azookey_dictionary(bytes: Vec<u8>) -> Result<(), String> {
    let dictionary_bytes = decode_dictionary_bytes(bytes)?;
    let dictionary = AzooKeyDictionary::from_portable_system_dictionary(dictionary_bytes)
        .map_err(|error| format!("invalid AzooKey dictionary: {error}"))?;
    let mut active = AZOOKEY_DICTIONARY
        .lock()
        .map_err(|_| "AzooKey dictionary lock is unavailable".to_string())?;
    *active = Some(dictionary);
    Ok(())
}

pub fn release_azookey_dictionary() {
    let mut active = AZOOKEY_DICTIONARY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *active = None;
}

pub fn convert_azookey(reading: String) -> Result<AzooKeyOutput, String> {
    let reading = bounded_required_text(reading, MAX_TEXT_CHARACTERS, "AzooKey input")?;
    let active = AZOOKEY_DICTIONARY
        .lock()
        .map_err(|_| "AzooKey dictionary lock is unavailable".to_string())?;
    let dictionary =
        active.as_ref().ok_or_else(|| "AzooKey dictionary is not initialized".to_string())?;
    let text = convert_with_dictionary(&reading, dictionary, ConversionOptions::default())
        .into_iter()
        .next()
        .map(|candidate| candidate.text)
        .ok_or_else(|| "AzooKey produced no conversion candidate".to_string())?;
    Ok(AzooKeyOutput { text })
}

fn decode_wire(json: &str) -> Result<WireEnvelope, String> {
    let envelope: WireEnvelope = serde_json::from_str(json)
        .map_err(|error| format!("invalid companion message: {error}"))?;
    if envelope.version != PROTOCOL_VERSION {
        return Err(format!("unsupported companion protocol version: {}", envelope.version));
    }
    Ok(envelope)
}

fn desktop_envelope(
    message_type: &str,
    session_id: String,
    turn_id: Option<u64>,
    revision: Option<u64>,
) -> WireEnvelope {
    WireEnvelope {
        version: PROTOCOL_VERSION,
        kind: message_type.to_string(),
        session_id: Some(session_id),
        turn_id,
        revision,
        text: None,
        source_text: None,
        is_final: None,
        token: None,
        device_name: None,
        device_id: None,
        route: None,
        capabilities: None,
        nonce: None,
        enabled: None,
    }
}

fn validate_mobile_capabilities(
    capabilities: MobileCapabilities,
) -> Result<MobileCapabilities, String> {
    Ok(MobileCapabilities {
        device_id: bounded_required_text(capabilities.device_id, MAX_TEXT_CHARACTERS, "device ID")?,
        device_name: bounded_required_text(
            capabilities.device_name,
            MAX_TEXT_CHARACTERS,
            "device name",
        )?,
        platform: bounded_required_text(
            capabilities.platform,
            MAX_TEXT_CHARACTERS,
            "mobile platform",
        )?,
        asr_available: capabilities.asr_available,
        azookey_available: capabilities.azookey_available,
        translation_available: capabilities.translation_available,
    })
}

fn encode_route_message(message_type: &str, route: PipelineRoute) -> Result<String, String> {
    let mut envelope = desktop_envelope(message_type, "route".to_string(), None, None);
    envelope.session_id = None;
    envelope.route = Some(route);
    encode(envelope)
}

fn supported_owner(owner: ExecutionDevice, available: bool) -> ExecutionDevice {
    if owner == ExecutionDevice::Mobile && !available {
        ExecutionDevice::Desktop
    } else {
        owner
    }
}

fn encode_desktop_message(
    message_type: &str,
    session_id: String,
    turn_id: Option<u64>,
    revision: Option<u64>,
    text: Option<String>,
    is_final: Option<bool>,
) -> Result<String, String> {
    let session_id = bounded_required_text(session_id, MAX_TEXT_CHARACTERS, "session ID")?;
    let mut envelope = desktop_envelope(message_type, session_id, turn_id, revision);
    envelope.text = text;
    envelope.is_final = is_final;
    encode(envelope)
}

fn decode_dictionary_bytes(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    if !bytes.starts_with(&[0x1f, 0x8b]) {
        return Ok(bytes);
    }
    let mut decoded = Vec::new();
    GzDecoder::new(bytes.as_slice())
        .take(MAX_DICTIONARY_BYTES + 1)
        .read_to_end(&mut decoded)
        .map_err(|error| format!("could not decompress AzooKey dictionary: {error}"))?;
    if decoded.len() as u64 > MAX_DICTIONARY_BYTES {
        return Err(format!(
            "AzooKey dictionary exceeds {MAX_DICTIONARY_BYTES} decompressed bytes"
        ));
    }
    Ok(decoded)
}

fn device_id(device: ExecutionDevice) -> char {
    match device {
        ExecutionDevice::Desktop => 'd',
        ExecutionDevice::Mobile => 'm',
    }
}

fn encode(envelope: WireEnvelope) -> Result<String, String> {
    serde_json::to_string(&envelope)
        .map_err(|error| format!("could not encode companion message: {error}"))
}

fn bounded_required_text(value: String, max_bytes: usize, label: &str) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(format!("{label} is required"));
    }
    if value.len() > max_bytes {
        return Err(format!("{label} exceeds {max_bytes} UTF-8 bytes"));
    }
    Ok(value)
}

fn required<T>(value: Option<T>, label: &str) -> Result<T, String> {
    value.ok_or_else(|| format!("{label} is required"))
}

#[cfg(test)]
mod tests {
    use super::{
        all_pipeline_routes, decode_desktop_command, decode_dictionary_bytes,
        decode_mobile_stage_result, decode_pair_request, decode_session_configuration,
        default_pipeline_route, encode_audio_boundary, encode_pair_request,
        encode_route_configuration, encode_session_configure, encode_session_ready,
        encode_stage_request, encode_stage_result, encode_translation_enabled, pipeline_route_id,
        should_continue_on_mobile, stage_owner, DesktopCommand, ExecutionDevice,
        MobileCapabilities, MobileStageResult, PairRequest, PipelineRoute, ProcessingStage,
        SessionConfiguration,
    };

    #[test]
    fn default_route_runs_every_stage_on_mobile() {
        assert_eq!(
            default_pipeline_route(),
            PipelineRoute {
                asr: ExecutionDevice::Mobile,
                azookey: ExecutionDevice::Mobile,
                translation: ExecutionDevice::Mobile,
            }
        );
    }

    #[test]
    fn exposes_exactly_eight_unique_routes() {
        let routes = all_pipeline_routes();
        assert_eq!(routes.len(), 8);
        assert_eq!(pipeline_route_id(routes[0]), "ddd");
        assert_eq!(pipeline_route_id(routes[1]), "ddm");
        assert_eq!(pipeline_route_id(routes[2]), "dmd");
        assert_eq!(pipeline_route_id(routes[3]), "dmm");
        assert_eq!(pipeline_route_id(routes[4]), "mdd");
        assert_eq!(pipeline_route_id(routes[5]), "mdm");
        assert_eq!(pipeline_route_id(routes[6]), "mmd");
        assert_eq!(pipeline_route_id(routes[7]), "mmm");
    }

    #[test]
    fn resolves_each_stage_owner_without_dart_route_definitions() {
        let route = PipelineRoute {
            asr: ExecutionDevice::Mobile,
            azookey: ExecutionDevice::Desktop,
            translation: ExecutionDevice::Mobile,
        };
        assert_eq!(stage_owner(route, ProcessingStage::Asr), ExecutionDevice::Mobile);
        assert_eq!(stage_owner(route, ProcessingStage::Azookey), ExecutionDevice::Desktop);
        assert_eq!(stage_owner(route, ProcessingStage::Translation), ExecutionDevice::Mobile);
    }

    #[test]
    fn mobile_continuation_is_owned_by_the_rust_route_definition() {
        assert!(should_continue_on_mobile(
            PipelineRoute {
                asr: ExecutionDevice::Mobile,
                azookey: ExecutionDevice::Mobile,
                translation: ExecutionDevice::Mobile,
            },
            ProcessingStage::Asr,
        ));
        assert!(should_continue_on_mobile(
            PipelineRoute {
                asr: ExecutionDevice::Desktop,
                azookey: ExecutionDevice::Mobile,
                translation: ExecutionDevice::Mobile,
            },
            ProcessingStage::Azookey,
        ));
        assert!(!should_continue_on_mobile(
            PipelineRoute {
                asr: ExecutionDevice::Mobile,
                azookey: ExecutionDevice::Desktop,
                translation: ExecutionDevice::Mobile,
            },
            ProcessingStage::Asr,
        ));
        assert!(
            !should_continue_on_mobile(default_pipeline_route(), ProcessingStage::Translation,)
        );
    }

    #[test]
    fn capabilities_force_unavailable_mobile_stages_back_to_desktop() {
        let capabilities = MobileCapabilities {
            device_id: "android-limited-1".to_string(),
            device_name: "Limited Android".to_string(),
            platform: "android".to_string(),
            asr_available: false,
            azookey_available: true,
            translation_available: false,
        };
        assert_eq!(
            capabilities.constrain(default_pipeline_route()),
            PipelineRoute {
                asr: ExecutionDevice::Desktop,
                azookey: ExecutionDevice::Mobile,
                translation: ExecutionDevice::Desktop,
            }
        );
        assert!(!capabilities.supports(ProcessingStage::Asr));
        assert!(capabilities.supports(ProcessingStage::Azookey));
        assert!(!capabilities.supports(ProcessingStage::Translation));
    }

    #[test]
    fn encodes_authenticated_pairing_and_mobile_default_configuration() {
        assert_eq!(
            encode_pair_request(
                "secret".to_string(),
                "ios-vendor-1".to_string(),
                "iPhone".to_string(),
            )
            .expect("valid pair request"),
            r#"{"version":1,"type":"pair.request","token":"secret","device_name":"iPhone","device_id":"ios-vendor-1"}"#
        );
        assert_eq!(
            encode_session_configure(
                "session-1".to_string(),
                default_pipeline_route(),
                MobileCapabilities {
                    device_id: "ios-vendor-1".to_string(),
                    device_name: "iPhone".to_string(),
                    platform: "ios".to_string(),
                    asr_available: true,
                    azookey_available: true,
                    translation_available: true,
                },
            )
            .expect("valid configuration"),
            r#"{"version":1,"type":"session.configure","session_id":"session-1","route":{"asr":"mobile","azookey":"mobile","translation":"mobile"},"capabilities":{"device_id":"ios-vendor-1","device_name":"iPhone","platform":"ios","asr_available":true,"azookey_available":true,"translation_available":true}}"#
        );
    }

    #[test]
    fn desktop_and_mobile_share_authenticated_protocol_types() {
        assert_eq!(
            decode_pair_request(
                r#"{"version":1,"type":"pair.request","token":"secret","device_name":"iPhone","device_id":"ios-vendor-1"}"#
                    .to_string()
            )
            .expect("valid pair request"),
            PairRequest {
                token: "secret".to_string(),
                device_id: "ios-vendor-1".to_string(),
                device_name: "iPhone".to_string(),
            }
        );
        assert_eq!(
            decode_session_configuration(
                r#"{"version":1,"type":"session.configure","session_id":"s","route":{"asr":"mobile","azookey":"desktop","translation":"mobile"},"capabilities":{"device_id":"ios-vendor-1","device_name":"iPhone","platform":"ios","asr_available":true,"azookey_available":true,"translation_available":true}}"#.to_string()
            )
            .expect("valid session configuration"),
            SessionConfiguration {
                session_id: "s".to_string(),
                route: PipelineRoute {
                    asr: ExecutionDevice::Mobile,
                    azookey: ExecutionDevice::Desktop,
                    translation: ExecutionDevice::Mobile,
                },
                capabilities: MobileCapabilities {
                    device_id: "ios-vendor-1".to_string(),
                    device_name: "iPhone".to_string(),
                    platform: "ios".to_string(),
                    asr_available: true,
                    azookey_available: true,
                    translation_available: true,
                },
            }
        );
        assert_eq!(
            encode_session_ready("s".to_string(), default_pipeline_route()).expect("session ready"),
            r#"{"version":1,"type":"session.ready","session_id":"s","route":{"asr":"mobile","azookey":"mobile","translation":"mobile"}}"#
        );
        assert_eq!(
            encode_route_configuration(PipelineRoute {
                asr: ExecutionDevice::Desktop,
                azookey: ExecutionDevice::Mobile,
                translation: ExecutionDevice::Desktop,
            })
            .expect("route configuration"),
            r#"{"version":1,"type":"route.configure","route":{"asr":"desktop","azookey":"mobile","translation":"desktop"}}"#
        );
        assert_eq!(
            encode_translation_enabled("s".to_string(), false).expect("translation control"),
            r#"{"version":1,"type":"translation.enabled","session_id":"s","enabled":false}"#
        );
        assert_eq!(
            decode_desktop_command(
                r#"{"version":1,"type":"translation.enabled","session_id":"s","enabled":false}"#
                    .to_string()
            )
            .expect("translation control"),
            DesktopCommand::SetTranslationEnabled { enabled: false }
        );
        assert_eq!(
            encode_audio_boundary("audio.start".to_string(), "s".to_string(), 2, 3)
                .expect("audio start"),
            r#"{"version":1,"type":"audio.start","session_id":"s","turn_id":2,"revision":3}"#
        );
        assert_eq!(
            encode_stage_request(
                "translation.request".to_string(),
                "s".to_string(),
                2,
                3,
                "今日は晴れ".to_string(),
                true,
            )
            .expect("translation request"),
            r#"{"version":1,"type":"translation.request","session_id":"s","turn_id":2,"revision":3,"source_text":"今日は晴れ"}"#
        );
        assert_eq!(
            decode_mobile_stage_result(
                r#"{"version":1,"type":"asr.update","session_id":"s","turn_id":2,"revision":3,"text":"こんにちは","is_final":false}"#.to_string()
            )
            .expect("ASR result"),
            MobileStageResult {
                message_type: "asr.update".to_string(),
                session_id: "s".to_string(),
                turn_id: 2,
                revision: 3,
                text: "こんにちは".to_string(),
                is_final: false,
            }
        );
    }

    #[test]
    fn decodes_revision_scoped_desktop_stage_requests() {
        assert_eq!(
            decode_desktop_command(
                r#"{"version":1,"type":"audio.start","session_id":"s","turn_id":3,"revision":8}"#
                    .to_string()
            )
            .expect("valid audio start"),
            DesktopCommand::StartAudio { session_id: "s".to_string(), turn_id: 3, revision: 8 }
        );
        assert_eq!(
            decode_desktop_command(
                r#"{"version":1,"type":"azookey.request","session_id":"s","turn_id":3,"revision":9,"text":"きょう","is_final":true}"#.to_string()
            )
            .expect("valid AzooKey request"),
            DesktopCommand::RunAzookey {
                session_id: "s".to_string(),
                turn_id: 3,
                revision: 9,
                text: "きょう".to_string(),
                is_final: true,
            }
        );
        assert_eq!(
            decode_desktop_command(
                r#"{"version":1,"type":"translation.request","session_id":"s","turn_id":3,"revision":10,"source_text":"今日は晴れ"}"#.to_string()
            )
            .expect("valid translation request"),
            DesktopCommand::RunTranslation {
                session_id: "s".to_string(),
                turn_id: 3,
                revision: 10,
                source_text: "今日は晴れ".to_string(),
            }
        );
    }

    #[test]
    fn decodes_raw_dictionary_bytes_and_rejects_broken_gzip() {
        assert_eq!(decode_dictionary_bytes(vec![1, 2, 3]).expect("raw dictionary"), vec![1, 2, 3]);
        assert!(decode_dictionary_bytes(vec![0x1f, 0x8b])
            .expect_err("broken gzip")
            .starts_with("could not decompress AzooKey dictionary:"));
    }

    #[test]
    fn rejects_malformed_messages_missing_fields_and_unsupported_kinds() {
        assert!(decode_desktop_command("not-json".to_string())
            .expect_err("malformed JSON")
            .starts_with("invalid companion message:"));
        assert_eq!(
            decode_desktop_command(
                r#"{"version":1,"type":"audio.start","session_id":"s","turn_id":1}"#.to_string()
            )
            .expect_err("missing revision"),
            "revision is required"
        );
        assert_eq!(
            decode_desktop_command(r#"{"version":1,"type":"unknown"}"#.to_string())
                .expect_err("unsupported command"),
            "unsupported desktop command: unknown"
        );
        assert_eq!(
            decode_mobile_stage_result(
                r#"{"version":1,"type":"audio.start","session_id":"s","turn_id":1,"revision":1,"text":"x","is_final":true}"#.to_string()
            )
            .expect_err("desktop message cannot be a mobile result"),
            "unsupported mobile result: audio.start"
        );
        assert_eq!(
            encode_audio_boundary("audio.pause".to_string(), "s".to_string(), 1, 1)
                .expect_err("unsupported boundary"),
            "unsupported audio boundary: audio.pause"
        );
        assert_eq!(
            encode_stage_request(
                "asr.request".to_string(),
                "s".to_string(),
                1,
                1,
                "text".to_string(),
                false,
            )
            .expect_err("unsupported stage request"),
            "unsupported stage request: asr.request"
        );
    }

    #[test]
    fn enforces_utf8_byte_bounds_at_the_authenticated_boundary() {
        assert_eq!(
            encode_pair_request("界".repeat(43), "android-1".to_string(), "phone".to_string(),)
                .expect_err("129-byte token"),
            "pairing token exceeds 128 UTF-8 bytes"
        );
        assert!(
            encode_pair_request("界".repeat(42), "android-1".to_string(), "phone".to_string(),)
                .is_ok()
        );
    }

    #[test]
    fn validates_protocol_versions_messages_and_text_bounds() {
        assert_eq!(
            decode_desktop_command(r#"{"version":2,"type":"ping","nonce":1}"#.to_string())
                .expect_err("unknown version"),
            "unsupported companion protocol version: 2"
        );
        assert_eq!(
            encode_stage_result(
                ProcessingStage::Translation,
                "s".to_string(),
                1,
                1,
                "text".to_string(),
                false,
            )
            .expect("translation result"),
            r#"{"version":1,"type":"translation.result","session_id":"s","turn_id":1,"revision":1,"text":"text","is_final":false}"#
        );
        assert_eq!(
            encode_pair_request(" ".to_string(), "android-1".to_string(), "phone".to_string(),)
                .expect_err("empty token"),
            "pairing token is required"
        );
    }
}
