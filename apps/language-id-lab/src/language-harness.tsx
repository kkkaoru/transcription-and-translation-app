// Runs with Bun during build and test.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isUiLocale, messagesFor, preferredUiLocale, type UiLocale } from "./i18n";
import {
  frameForElapsed,
  HARNESS_SCENARIOS,
  type HarnessScenario,
  type LanguageCode,
  type PosteriorDistribution,
  posteriorData,
  scenarioById,
} from "./scenarios";

type CaptureStatus = "idle" | "requesting" | "live" | "error";

interface PosteriorPanelProps {
  title: string;
  eyebrow: string;
  distribution: PosteriorDistribution;
  statusLabel: string;
}

interface LanguageBadgeProps {
  language: LanguageCode;
  label: string;
  compact: boolean;
}

interface MetricProps {
  label: string;
  value: string;
  detail: string;
}

const SIMULATION_INTERVAL_MS: number = 200;
const LOCALE_STORAGE_KEY: string = "kotoba-language-id-lab-locale";

const LanguageBadge = ({ language, label, compact }: LanguageBadgeProps) => (
  <span className={`language-badge language-${language}${compact ? " compact" : ""}`}>
    <span className="language-code">{language}</span>
    <span>{label}</span>
  </span>
);

const PosteriorPanel = ({ title, eyebrow, distribution, statusLabel }: PosteriorPanelProps) => (
  <article className="posterior-card panel">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h3>{title}</h3>
      </div>
      <span className="live-dot">{statusLabel}</span>
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
  const [locale, setLocale] = useState<UiLocale>("en");
  const [scenarioId, setScenarioId] = useState<string>(HARNESS_SCENARIOS[0]?.id ?? "ja-ambiguous");
  const [simulationRunning, setSimulationRunning] = useState<boolean>(false);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>("idle");
  const [captureError, setCaptureError] = useState<string>("");
  const [devices, setDevices] = useState<readonly MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const streamRef = useRef<MediaStream | null>(null);
  const simulationStartedAtRef = useRef<number>(Date.now());
  const messages = useMemo(() => messagesFor(locale), [locale]);
  const scenario = useMemo(() => scenarioById(scenarioId), [scenarioId]);
  const frame = useMemo(() => frameForElapsed(scenario, elapsedMs), [elapsedMs, scenario]);
  const scenarioCopy = messages.scenarios[scenario.id] ?? scenario;

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
      setCaptureError(messages.microphoneUnavailable);
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
      setCaptureError(error instanceof Error ? error.message : messages.microphoneFailed);
    }
  }, [messages, refreshDevices, selectedDeviceId]);

  useEffect(() => {
    let preferred = preferredUiLocale(navigator.language);
    try {
      const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
      if (isUiLocale(stored)) preferred = stored;
    } catch {
      // Browser privacy settings can disable persistent storage.
    }
    setLocale(preferred);
    document.documentElement.lang = preferred;
  }, []);

  useEffect(() => {
    void refreshDevices();
    return stopCapture;
  }, [refreshDevices, stopCapture]);

  useEffect(() => {
    if (!simulationRunning) return;
    const duration = scenarioDuration(scenario);
    const timer = window.setInterval(() => {
      const nextElapsedMs = Math.min(Date.now() - simulationStartedAtRef.current, duration);
      setElapsedMs(nextElapsedMs);
      if (nextElapsedMs >= duration) setSimulationRunning(false);
    }, SIMULATION_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [scenario, simulationRunning]);

  const selectLocale = (nextLocale: UiLocale) => {
    setLocale(nextLocale);
    document.documentElement.lang = nextLocale;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // The in-memory selection still works when storage is unavailable.
    }
  };

  const selectScenario = (nextScenarioId: string) => {
    setScenarioId(nextScenarioId);
    setElapsedMs(0);
    setSimulationRunning(false);
  };

  const toggleSimulation = () => {
    const duration = scenarioDuration(scenario);
    const restarting = elapsedMs >= duration;
    const nextElapsedMs = restarting ? 0 : elapsedMs;
    if (restarting) setElapsedMs(0);
    simulationStartedAtRef.current = Date.now() - nextElapsedMs;
    setSimulationRunning((running) => !running);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Kotoba Beacon Language ID Lab">
          <span className="brand-mark" aria-hidden="true">
            KB
          </span>
          <span>
            <strong>Kotoba Beacon</strong>
            <small>{messages.brandSubtitle}</small>
          </span>
        </a>
        <div className="topbar-status">
          <span className="edge-status">
            <span aria-hidden="true">◆</span> {messages.edgeStatus}
          </span>
          <span className="mode-pill">{messages.syntheticEvidence}</span>
          <fieldset className="language-switcher">
            <legend>{messages.localeSwitcherLabel}</legend>
            <button
              type="button"
              className={locale === "ja" ? "active" : ""}
              aria-pressed={locale === "ja"}
              onClick={() => selectLocale("ja")}
            >
              日本語
            </button>
            <button
              type="button"
              className={locale === "en" ? "active" : ""}
              aria-pressed={locale === "en"}
              onClick={() => selectLocale("en")}
            >
              English
            </button>
          </fieldset>
        </div>
      </header>

      <section className="hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">{messages.heroEyebrow}</p>
          <h1>
            {messages.heroTitleFirst}
            <br />
            {messages.heroTitleSecond}
          </h1>
          <p className="hero-description">{messages.heroDescription}</p>
        </div>
        <div className="stable-card panel">
          <div className="stable-header">
            <span>{messages.stableHeading}</span>
            <span className="pulse">
              <i /> {simulationRunning ? messages.syntheticRunning : messages.syntheticPaused}
            </span>
          </div>
          <div className="stable-language">
            <LanguageBadge
              language={frame.stableLanguage}
              label={messages.languageNames[frame.stableLanguage]}
              compact={false}
            />
            <strong>{Math.round(frame.hmm[frame.stableLanguage] * 100)}%</strong>
          </div>
          <div className="candidate-row">
            <span>{messages.switchCandidate}</span>
            {frame.candidateLanguage ? (
              <LanguageBadge
                language={frame.candidateLanguage}
                label={messages.languageNames[frame.candidateLanguage]}
                compact={true}
              />
            ) : (
              <span className="candidate-clear">{messages.noActiveCandidate}</span>
            )}
            <span className="llr">
              {messages.llrLabel} {frame.candidateEvidence.toFixed(2)}
            </span>
          </div>
        </div>
      </section>

      <section className="control-strip panel">
        <div className="control-group microphone-control">
          <label htmlFor="microphone">{messages.microphoneInput}</label>
          <select
            id="microphone"
            value={selectedDeviceId}
            onChange={(event) => setSelectedDeviceId(event.currentTarget.value)}
            disabled={captureStatus === "live"}
          >
            <option value="">{messages.defaultMicrophone}</option>
            {devices.map((device, index) => (
              <option key={device.deviceId || `microphone-${index}`} value={device.deviceId}>
                {device.label || messages.microphoneName(index + 1)}
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
            ? messages.requestingMicrophone
            : captureStatus === "live"
              ? messages.stopMicrophone
              : messages.enableMicrophone}
        </button>
        <div className="privacy-note">
          <strong>{messages.privateByDefault}</strong>
          <span>{messages.audioNotUploaded}</span>
        </div>
        {captureError ? <p className="control-error">{captureError}</p> : null}
      </section>

      <section className="scenario-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{messages.scenariosEyebrow}</p>
            <h2>{messages.scenariosHeading}</h2>
          </div>
          <button className="secondary-button" type="button" onClick={toggleSimulation}>
            {simulationRunning
              ? messages.pauseRun
              : elapsedMs >= scenarioDuration(scenario)
                ? messages.runAgain
                : elapsedMs > 0
                  ? messages.resumeRun
                  : messages.runScenario}
          </button>
        </div>
        <div className="scenario-tabs" role="tablist" aria-label={messages.scenarioTabsLabel}>
          {HARNESS_SCENARIOS.map((item) => {
            const copy = messages.scenarios[item.id] ?? item;
            return (
              <button
                type="button"
                role="tab"
                aria-selected={item.id === scenario.id}
                className={item.id === scenario.id ? "scenario-tab active" : "scenario-tab"}
                key={item.id}
                onClick={() => selectScenario(item.id)}
              >
                <span>{copy.label}</span>
                <small>{copy.expected}</small>
              </button>
            );
          })}
        </div>
        <div className="scenario-summary">
          <p>{scenarioCopy.description}</p>
          <span>
            {messages.sampledSeconds(
              (Math.min(elapsedMs, scenarioDuration(scenario)) / 1_000).toFixed(1),
            )}
          </span>
        </div>
      </section>

      <section className="transcript-panel panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">{messages.syntheticTranscript}</p>
            <h2>{frame.transcript}</h2>
          </div>
          <span className="revision">{messages.revision(Math.floor(frame.atMs / 500) + 1)}</span>
        </div>
        <ul className="timeline" aria-label={messages.timelineLabel}>
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
          title={messages.rawAcoustic}
          eyebrow={messages.modelPosterior}
          distribution={frame.acoustic}
          statusLabel={messages.fixtureStatus}
        />
        <PosteriorPanel
          title={messages.fusedEvidence}
          eyebrow={messages.fusedEvidenceEyebrow}
          distribution={frame.fused}
          statusLabel={messages.fixtureStatus}
        />
        <PosteriorPanel
          title={messages.onlineHmm}
          eyebrow={messages.realtimeTracker}
          distribution={frame.hmm}
          statusLabel={messages.fixtureStatus}
        />
      </section>

      <section className="diagnostics panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">{messages.diagnosticsEyebrow}</p>
            <h2>{messages.diagnosticsHeading}</h2>
          </div>
          <span className="source-truth">{messages.rustSourceOfTruth}</span>
        </div>
        <div className="metrics-grid">
          <Metric
            label={messages.observationQuality}
            value={`${Math.round(frame.quality * 100)}%`}
            detail={messages.calibratedInput}
          />
          <Metric
            label={messages.speechCoverage}
            value={`${Math.round(frame.speechCoverage * 100)}%`}
            detail={messages.voicedContext}
          />
          <Metric
            label={messages.trackerUpdate}
            value={`${frame.latencyMs} ms`}
            detail={messages.simulatedEndToEnd}
          />
          <Metric label={messages.pendingQueue} value="1 / 16" detail={messages.boundedTicks} />
          <Metric label={messages.backpressure} value="0" detail={messages.explicitEvents} />
          <Metric
            label={messages.transport}
            value={messages.ready}
            detail={messages.cloudflareWorker}
          />
        </div>
      </section>

      <footer>
        <span>{messages.footerProduct}</span>
        <span>{messages.footerMilestone}</span>
      </footer>
    </main>
  );
}
