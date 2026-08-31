// Runs with Bun during build and test.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  frameForElapsed,
  HARNESS_SCENARIOS,
  type HarnessScenario,
  type LanguageCode,
  languageLabel,
  type PosteriorDistribution,
  posteriorData,
  scenarioById,
} from "./scenarios";

type CaptureStatus = "idle" | "requesting" | "live" | "error";

interface PosteriorPanelProps {
  title: string;
  eyebrow: string;
  distribution: PosteriorDistribution;
}

interface LanguageBadgeProps {
  language: LanguageCode;
  compact: boolean;
}

interface MetricProps {
  label: string;
  value: string;
  detail: string;
}

const SIMULATION_INTERVAL_MS: number = 200;
const EMPTY_DEVICE_LABEL: string = "Default microphone";

const LanguageBadge = ({ language, compact }: LanguageBadgeProps) => (
  <span className={`language-badge language-${language}${compact ? " compact" : ""}`}>
    <span className="language-code">{language}</span>
    <span>{languageLabel(language)}</span>
  </span>
);

const PosteriorPanel = ({ title, eyebrow, distribution }: PosteriorPanelProps) => (
  <article className="posterior-card panel">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h3>{title}</h3>
      </div>
      <span className="live-dot">live</span>
    </div>
    <div className="posterior-list">
      {posteriorData(distribution).map((datum) => (
        <div className="posterior-row" key={datum.language}>
          <div className="posterior-label">
            <span>{datum.language}</span>
            <strong>{Math.round(datum.probability * 100)}%</strong>
          </div>
          <progress max={1} value={datum.probability} aria-label={`${datum.language} posterior`} />
        </div>
      ))}
    </div>
  </article>
);

const Metric = ({ label, value, detail }: MetricProps) => (
  <div className="metric">
    <span>{label}</span>
    <strong>{value}</strong>
    <small>{detail}</small>
  </div>
);

const scenarioDuration = (scenario: HarnessScenario): number => scenario.frames.at(-1)?.atMs ?? 0;

export function LanguageHarness() {
  const [scenarioId, setScenarioId] = useState<string>(HARNESS_SCENARIOS[0]?.id ?? "ja-ambiguous");
  const [simulationRunning, setSimulationRunning] = useState<boolean>(true);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>("idle");
  const [captureError, setCaptureError] = useState<string>("");
  const [devices, setDevices] = useState<readonly MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const streamRef = useRef<MediaStream | null>(null);
  const simulationStartedAtRef = useRef<number>(Date.now());
  const scenario = useMemo(() => scenarioById(scenarioId), [scenarioId]);
  const frame = useMemo(() => frameForElapsed(scenario, elapsedMs), [elapsedMs, scenario]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices) return;
    const available = await navigator.mediaDevices.enumerateDevices();
    setDevices(available.filter((device) => device.kind === "audioinput"));
  }, []);

  const stopCapture = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    streamRef.current = null;
    setCaptureStatus("idle");
  }, []);

  const startCapture = useCallback(async () => {
    if (!navigator.mediaDevices) {
      setCaptureStatus("error");
      setCaptureError("This browser does not expose microphone capture.");
      return;
    }
    setCaptureStatus("requesting");
    setCaptureError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio:
          selectedDeviceId === ""
            ? true
            : { deviceId: { exact: selectedDeviceId }, channelCount: 1 },
        video: false,
      });
      streamRef.current = stream;
      setCaptureStatus("live");
      await refreshDevices();
    } catch (error) {
      setCaptureStatus("error");
      setCaptureError(error instanceof Error ? error.message : "Microphone access failed.");
    }
  }, [refreshDevices, selectedDeviceId]);

  useEffect(() => {
    void refreshDevices();
    return stopCapture;
  }, [refreshDevices, stopCapture]);

  useEffect(() => {
    if (!simulationRunning) return;
    simulationStartedAtRef.current = Date.now() - elapsedMs;
    const timer = window.setInterval(
      () => setElapsedMs(Date.now() - simulationStartedAtRef.current),
      SIMULATION_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [elapsedMs, simulationRunning]);

  const selectScenario = (nextScenarioId: string) => {
    setScenarioId(nextScenarioId);
    setElapsedMs(0);
    simulationStartedAtRef.current = Date.now();
    setSimulationRunning(true);
  };

  const toggleSimulation = () => {
    simulationStartedAtRef.current = Date.now() - elapsedMs;
    setSimulationRunning((running) => !running);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Kotoba Beacon Language Lab home">
          <span className="brand-mark" aria-hidden="true">
            KB
          </span>
          <span>
            <strong>Kotoba Beacon</strong>
            <small>Language Harness</small>
          </span>
        </a>
        <div className="topbar-status">
          <span className="edge-status">
            <span aria-hidden="true">◆</span> Cloudflare edge
          </span>
          <span className="mode-pill">Synthetic evidence</span>
        </div>
      </header>

      <section className="hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">Realtime multilingual state</p>
          <h1>
            Track the language.
            <br />
            Keep the context.
          </h1>
          <p className="hero-description">
            A live observability surface for the Rust language harness. Inspect stable state,
            switching evidence, posterior layers, and transport health without turning a borrowed
            word into a false language switch.
          </p>
        </div>
        <div className="stable-card panel">
          <div className="stable-header">
            <span>Current stable language</span>
            <span className="pulse">
              <i /> tracking
            </span>
          </div>
          <div className="stable-language">
            <LanguageBadge language={frame.stableLanguage} compact={false} />
            <strong>{Math.round(frame.hmm[frame.stableLanguage] * 100)}%</strong>
          </div>
          <div className="candidate-row">
            <span>Switch candidate</span>
            {frame.candidateLanguage ? (
              <LanguageBadge language={frame.candidateLanguage} compact={true} />
            ) : (
              <span className="candidate-clear">No active candidate</span>
            )}
            <span className="llr">LLR {frame.candidateEvidence.toFixed(2)}</span>
          </div>
        </div>
      </section>

      <section className="control-strip panel">
        <div className="control-group microphone-control">
          <label htmlFor="microphone">Microphone input</label>
          <select
            id="microphone"
            value={selectedDeviceId}
            onChange={(event) => setSelectedDeviceId(event.currentTarget.value)}
            disabled={captureStatus === "live"}
          >
            <option value="">{EMPTY_DEVICE_LABEL}</option>
            {devices.map((device, index) => (
              <option key={device.deviceId || `microphone-${index}`} value={device.deviceId}>
                {device.label || `Microphone ${index + 1}`}
              </option>
            ))}
          </select>
        </div>
        <button
          className={`primary-button capture-${captureStatus}`}
          type="button"
          onClick={captureStatus === "live" ? stopCapture : () => void startCapture()}
          disabled={captureStatus === "requesting"}
        >
          <span aria-hidden="true">{captureStatus === "live" ? "■" : "●"}</span>
          {captureStatus === "requesting"
            ? "Requesting…"
            : captureStatus === "live"
              ? "Stop microphone"
              : "Enable microphone"}
        </button>
        <div className="privacy-note">
          <strong>Private by default</strong>
          <span>Audio is not uploaded in this UI milestone.</span>
        </div>
        {captureError ? <p className="control-error">{captureError}</p> : null}
      </section>

      <section className="scenario-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Verification scenarios</p>
            <h2>Exercise the state surface</h2>
          </div>
          <button className="secondary-button" type="button" onClick={toggleSimulation}>
            {simulationRunning ? "Pause run" : "Resume run"}
          </button>
        </div>
        <div className="scenario-tabs" role="tablist" aria-label="Harness scenarios">
          {HARNESS_SCENARIOS.map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={item.id === scenario.id}
              className={item.id === scenario.id ? "scenario-tab active" : "scenario-tab"}
              key={item.id}
              onClick={() => selectScenario(item.id)}
            >
              <span>{item.label}</span>
              <small>{item.expected}</small>
            </button>
          ))}
        </div>
        <div className="scenario-summary">
          <p>{scenario.description}</p>
          <span>
            {(Math.min(elapsedMs, scenarioDuration(scenario)) / 1_000).toFixed(1)}s sampled
          </span>
        </div>
      </section>

      <section className="transcript-panel panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Live transcript</p>
            <h2>{frame.transcript}</h2>
          </div>
          <span className="revision">revision {Math.floor(frame.atMs / 500) + 1}</span>
        </div>
        <ul className="timeline" aria-label="Language switch timeline">
          {scenario.frames.map((item) => (
            <li
              className={`timeline-segment language-${item.stableLanguage}${item.atMs === frame.atMs ? " current" : ""}`}
              key={item.atMs}
            >
              <span>{item.stableLanguage}</span>
              <small>{(item.atMs / 1_000).toFixed(1)}s</small>
            </li>
          ))}
        </ul>
      </section>

      <section className="posterior-grid">
        <PosteriorPanel
          title="Raw acoustic"
          eyebrow="Model posterior"
          distribution={frame.acoustic}
        />
        <PosteriorPanel
          title="Fused evidence"
          eyebrow="Acoustic + optional Nova"
          distribution={frame.fused}
        />
        <PosteriorPanel title="Online HMM" eyebrow="Realtime tracker" distribution={frame.hmm} />
      </section>

      <section className="diagnostics panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Runtime diagnostics</p>
            <h2>Bounded, observable, privacy-safe</h2>
          </div>
          <span className="source-truth">Rust source of truth</span>
        </div>
        <div className="metrics-grid">
          <Metric
            label="Observation quality"
            value={`${Math.round(frame.quality * 100)}%`}
            detail="calibrated input"
          />
          <Metric
            label="Speech coverage"
            value={`${Math.round(frame.speechCoverage * 100)}%`}
            detail="voiced context"
          />
          <Metric
            label="Tracker update"
            value={`${frame.latencyMs} ms`}
            detail="simulated end-to-end"
          />
          <Metric label="Pending queue" value="1 / 16" detail="bounded ticks" />
          <Metric label="Backpressure" value="0" detail="explicit events" />
          <Metric label="Transport" value="Ready" detail="Cloudflare Worker" />
        </div>
      </section>

      <footer>
        <span>Kotoba Beacon · Language ID Lab</span>
        <span>UI milestone · inference bridge pending</span>
      </footer>
    </main>
  );
}
