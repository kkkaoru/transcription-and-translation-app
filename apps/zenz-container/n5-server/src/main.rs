use std::env;
use std::error::Error;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::Instant;

use caption_bridge_input_lm::marisa::{open_model, MarisaTrie};
use caption_bridge_input_lm::rescore::{AsrConfusionRules, LmScorer, Rescorer};
use caption_bridge_input_lm::tokenizer::ZenzTokenizer;
use caption_bridge_input_lm::NgramParams;
use serde::{Deserialize, Serialize};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const N5_BIND_ADDRESS: &str = "0.0.0.0:8081";
const N5_MODEL_BASE: &str = "/models/input_n5_lm_v1/lm";
const N5_TOKENIZER_DIRECTORY: &str = "/models/input_n5_lm_v1/tokenizer";
const N5_ENABLED_MARKER: &str = "/models/input_n5_lm_v1/.enabled";
const MAX_REQUEST_BYTES: u64 = 65_536;
const HEALTH_PATH: &str = "/health";
const RESCORE_PATH: &str = "/rescore";

type N5Rescorer = Rescorer<LmScorer<MarisaTrie>>;

#[derive(Deserialize)]
struct RescoreRequest {
    text: String,
}

#[derive(Serialize)]
struct RescoreResponse<'a> {
    text: &'a str,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: f64,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    model: &'static str,
}

#[derive(Serialize)]
struct ErrorResponse<'a> {
    error: &'a str,
}

struct LlamaProcess {
    child: Child,
}

impl Drop for LlamaProcess {
    fn drop(&mut self) {
        match self.child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) => {
                if let Err(error) = self.child.kill() {
                    eprintln!("Failed to stop llama-server: {error}");
                }
                if let Err(error) = self.child.wait() {
                    eprintln!("Failed to reap llama-server: {error}");
                }
            }
            Err(error) => eprintln!("Failed to inspect llama-server: {error}"),
        }
    }
}

fn json_header() -> Result<Header, Box<dyn Error + Send + Sync>> {
    Header::from_bytes("content-type", "application/json; charset=utf-8")
        .map_err(|_| "failed to construct content-type header".into())
}

fn json_response<T: Serialize>(
    status: StatusCode,
    value: &T,
) -> Result<Response<std::io::Cursor<Vec<u8>>>, Box<dyn Error + Send + Sync>> {
    let body = serde_json::to_vec(value)?;
    Ok(Response::from_data(body).with_status_code(status).with_header(json_header()?))
}

fn read_rescore_request(request: &mut Request) -> Result<RescoreRequest, &'static str> {
    if request.body_length().unwrap_or(0) > MAX_REQUEST_BYTES as usize {
        return Err("request body is too large");
    }
    let mut body = Vec::new();
    request
        .as_reader()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|_| "failed to read request body")?;
    if body.len() as u64 > MAX_REQUEST_BYTES {
        return Err("request body is too large");
    }
    let parsed: RescoreRequest =
        serde_json::from_slice(&body).map_err(|_| "request body must be JSON with text")?;
    if parsed.text.trim().is_empty() {
        return Err("text must not be empty");
    }
    Ok(parsed)
}

fn respond(request: Request, response: Response<std::io::Cursor<Vec<u8>>>) {
    if let Err(error) = request.respond(response) {
        eprintln!("Failed to send N5 LM response: {error}");
    }
}

fn handle_request(mut request: Request, rescorer: &N5Rescorer) {
    if request.method() == &Method::Get && request.url() == HEALTH_PATH {
        let health = HealthResponse { ok: true, model: "input_n5_lm_v1" };
        match json_response(StatusCode(200), &health) {
            Ok(response) => respond(request, response),
            Err(error) => eprintln!("Failed to serialize N5 LM health response: {error}"),
        }
        return;
    }
    if request.method() != &Method::Post || request.url() != RESCORE_PATH {
        let error = ErrorResponse { error: "POST /rescore is required" };
        match json_response(StatusCode(404), &error) {
            Ok(response) => respond(request, response),
            Err(cause) => eprintln!("Failed to serialize N5 LM route error: {cause}"),
        }
        return;
    }
    let input = match read_rescore_request(&mut request) {
        Ok(input) => input,
        Err(message) => {
            let error = ErrorResponse { error: message };
            match json_response(StatusCode(400), &error) {
                Ok(response) => respond(request, response),
                Err(cause) => eprintln!("Failed to serialize N5 LM input error: {cause}"),
            }
            return;
        }
    };
    let started_at = Instant::now();
    let output = rescorer.best(&input.text);
    let result =
        RescoreResponse { text: &output, elapsed_ms: started_at.elapsed().as_secs_f64() * 1_000.0 };
    match json_response(StatusCode(200), &result) {
        Ok(response) => respond(request, response),
        Err(error) => eprintln!("Failed to serialize N5 LM result: {error}"),
    }
}

fn load_rescorer() -> Result<N5Rescorer, Box<dyn Error + Send + Sync>> {
    let model = open_model(Path::new(N5_MODEL_BASE), NgramParams::default())?;
    let tokenizer = ZenzTokenizer::from_dir(Path::new(N5_TOKENIZER_DIRECTORY))
        .ok_or("failed to load the N5 LM tokenizer")?;
    Ok(Rescorer::with_recommended_weights(
        LmScorer::new(model, tokenizer),
        AsrConfusionRules::default(),
    ))
}

fn start_llama() -> Result<LlamaProcess, Box<dyn Error + Send + Sync>> {
    let mut args = env::args_os();
    let executable = args.next().ok_or("missing entrypoint executable")?;
    let llama_executable = args.next().ok_or("missing llama-server executable")?;
    drop(executable);
    let child = Command::new(llama_executable).args(args).spawn()?;
    Ok(LlamaProcess { child })
}

fn run_n5_server() -> Result<(), Box<dyn Error + Send + Sync>> {
    let rescorer = load_rescorer()?;
    let server = Server::http(N5_BIND_ADDRESS)?;
    for request in server.incoming_requests() {
        handle_request(request, &rescorer);
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    let mut llama = start_llama()?;
    if PathBuf::from(N5_ENABLED_MARKER).exists() {
        run_n5_server()?;
    } else {
        let status = llama.child.wait()?;
        if !status.success() {
            return Err(format!("llama-server exited with status {status}").into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_health_and_error_responses() {
        let health =
            json_response(StatusCode(200), &HealthResponse { ok: true, model: "input_n5_lm_v1" })
                .expect("health response");
        assert_eq!(health.status_code(), StatusCode(200));

        let error = json_response(StatusCode(400), &ErrorResponse { error: "invalid" })
            .expect("error response");
        assert_eq!(error.status_code(), StatusCode(400));
    }

    #[test]
    fn response_uses_millisecond_field_name() {
        let body = serde_json::to_string(&RescoreResponse { text: "かな", elapsed_ms: 1.25 })
            .expect("serialized response");
        assert_eq!(body, r#"{"text":"かな","elapsedMs":1.25}"#);
    }
}
