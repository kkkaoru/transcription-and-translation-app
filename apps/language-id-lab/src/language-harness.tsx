// Runs with Bun during build and test.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComputeTier } from "./container-backend";
import {
  displayLanguageName,
  isUiLocale,
  messagesFor,
  preferredUiLocale,
  type UiLocale,
  type UiMessages,
} from "./i18n";
import {
  type EcapaPattern,
  inferLanguage,
  type LanguageInference,
  type LanguageProbability,
  releaseLanguageContainer,
  warmLanguageContainer,
} from "./language-api";
import { MicrophoneCapture } from "./microphone-capture";
import { type ContainerPrice, type ContainerUsage, fetchContainerUsage } from "./usage-api";

type CaptureStatus = "idle" | "requesting" | "live" | "processing" | "error";

interface PosteriorPanelProps {
  title: string;
  values: readonly LanguageProbability[];
  locale: UiLocale;
}

interface DiagnosticMetricProps {
  label: string;
  value: string;
  detail: string;
}

interface CostRange {
  low: number;
  high: number;
}

const LOCALE_STORAGE_KEY: string = "kotoba-language-id-lab-locale";
const USAGE_REFRESH_MS: number = 60_000;
const SESSION_CLOCK_MS: number = 1_000;
const FALLBACK_PRICES: readonly ContainerPrice[] = [
  {
    tier: "basic",
    vcpu: 0.25,
    memoryGib: 1,
    diskGb: 4,
    provisionedHourlyUsd: 0.010008,
    maximumHourlyUsd: 0.028008,
  },
  {
    tier: "standard",
    vcpu: 0.5,
    memoryGib: 4,
    diskGb: 8,
    provisionedHourlyUsd: 0.038016,
    maximumHourlyUsd: 0.074016,
  },
];

const PosteriorPanel = ({ title, values, locale }: PosteriorPanelProps) => (
  <article className="posterior-card panel">
    <div className="panel-heading">
      <h3>{title}</h3>
    </div>
    <div className="posterior-list">
      {values.map((value) => (
        <div className="posterior-row" key={value.language}>
          <div className="posterior-label">
            <span>
              {displayLanguageName(value.language, locale)} <small>{value.language}</small>
            </span>
            <strong>{(value.probability * 100).toFixed(1)}%</strong>
          </div>
          <progress max={1} value={value.probability} aria-label={`${value.language} posterior`} />
        </div>
      ))}
    </div>
  </article>
);

const DiagnosticMetric = ({ label, value, detail }: DiagnosticMetricProps) => (
  <div className="diagnostic-metric">
    <span>{label}</span>
    <strong>{value}</strong>
    <small>{detail}</small>
  </div>
);

const selectedPrice = (prices: readonly ContainerPrice[], tier: ComputeTier): ContainerPrice =>
  prices.find((price) => price.tier === tier) ??
  FALLBACK_PRICES.find((price) => price.tier === tier) ??
  FALLBACK_PRICES[0];

const sessionCostRange = (options: { elapsedMs: number; price: ContainerPrice }): CostRange => {
  const elapsedHours: number = options.elapsedMs / 3_600_000;
  return {
    low: elapsedHours * options.price.provisionedHourlyUsd,
    high: elapsedHours * options.price.maximumHourlyUsd,
  };
};

const captureStatusLabel = (status: CaptureStatus, messages: UiMessages): string => {
  if (status === "processing") return messages.processing;
  if (status === "live") return messages.listening;
  return messages.waitingForSpeech;
};

const initialLocale = (): UiLocale =>
  typeof navigator === "undefined" ? "en" : preferredUiLocale(navigator.language);

export function LanguageHarness() {
  const [locale, setLocale] = useState<UiLocale>(initialLocale);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>("idle");
  const [captureError, setCaptureError] = useState<string>("");
  const [devices, setDevices] = useState<readonly MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [tier, setTier] = useState<ComputeTier>("basic");
  const [pattern, setPattern] = useState<EcapaPattern>("rolling-context");
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [speechProbability, setSpeechProbability] = useState<number>(0);
  const [inference, setInference] = useState<LanguageInference | null>(null);
  const [usage, setUsage] = useState<ContainerUsage | null>(null);
  const [usageError, setUsageError] = useState<string>("");
  const [containerStartedAt, setContainerStartedAt] = useState<number | null>(null);
  const [sessionElapsedMs, setSessionElapsedMs] = useState<number>(0);
  const captureRef = useRef<MicrophoneCapture | null>(null);
  const sessionIdRef = useRef<string>(crypto.randomUUID());
  const tierRef = useRef<ComputeTier>(tier);
  const patternRef = useRef<EcapaPattern>(pattern);
  const containerActiveRef = useRef<boolean>(false);
  const messages = useMemo(() => messagesFor(locale), [locale]);
  const prices: readonly ContainerPrice[] = usage?.prices ?? FALLBACK_PRICES;
  const price: ContainerPrice = selectedPrice(prices, tier);
  const costRange: CostRange = sessionCostRange({ elapsedMs: sessionElapsedMs, price });

  tierRef.current = tier;
  patternRef.current = pattern;

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices) return;
    const available: MediaDeviceInfo[] = await navigator.mediaDevices.enumerateDevices();
    setDevices(available.filter((device) => device.kind === "audioinput"));
  }, []);

  const refreshUsage = useCallback(async () => {
    try {
      const nextUsage: ContainerUsage = await fetchContainerUsage();
      setUsage(nextUsage);
      setUsageError(nextUsage.available ? "" : nextUsage.detail);
    } catch (error) {
      setUsageError(error instanceof Error ? error.message : "Container usage request failed");
    }
  }, []);

  const stopCapture = useCallback(async () => {
    const capture: MicrophoneCapture | null = captureRef.current;
    captureRef.current = null;
    await capture?.stop();
    if (containerActiveRef.current) {
      containerActiveRef.current = false;
      await releaseLanguageContainer({
        tier: tierRef.current,
        sessionId: sessionIdRef.current,
      }).catch((error: unknown) =>
        setCaptureError(error instanceof Error ? error.message : "Container release failed"),
      );
    }
    setContainerStartedAt(null);
    setSessionElapsedMs(0);
    setCaptureStatus("idle");
  }, []);

  const handleSpeechEnd = useCallback(
    async (samples: Float32Array, capturedAtMs: number): Promise<void> => {
      setCaptureStatus("processing");
      const result: LanguageInference = await inferLanguage({
        samples,
        capturedAtMs,
        tier: tierRef.current,
        pattern: patternRef.current,
        sessionId: sessionIdRef.current,
      });
      setInference(result);
      setCaptureStatus("live");
      await refreshUsage();
    },
    [refreshUsage],
  );

  const startCapture = useCallback(async () => {
    if (!navigator.mediaDevices) {
      setCaptureStatus("error");
      setCaptureError(messages.microphoneUnavailable);
      return;
    }
    setCaptureStatus("requesting");
    setCaptureError("");
    const capture = new MicrophoneCapture({
      deviceId: selectedDeviceId,
      events: {
        onLevel: setAudioLevel,
        onSpeechProbability: setSpeechProbability,
        onSpeechStart: () => setCaptureStatus("live"),
        onSpeechEnd: handleSpeechEnd,
        onError: (message) => {
          setCaptureError(message);
          setCaptureStatus("live");
        },
      },
    });
    try {
      await capture.start();
      captureRef.current = capture;
      await warmLanguageContainer({ tier, sessionId: sessionIdRef.current });
      containerActiveRef.current = true;
      setContainerStartedAt(Date.now());
      setCaptureStatus("live");
      await refreshDevices();
    } catch (error) {
      await capture.stop();
      setCaptureStatus("error");
      setCaptureError(error instanceof Error ? error.message : messages.microphoneFailed);
    }
  }, [handleSpeechEnd, messages, refreshDevices, selectedDeviceId, tier]);

  const selectLocale = (nextLocale: UiLocale) => {
    setLocale(nextLocale);
    document.documentElement.lang = nextLocale;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // The in-memory selection still works when storage is unavailable.
    }
  };

  useEffect(() => {
    const preferred: UiLocale = (() => {
      try {
        const stored: string | null = window.localStorage.getItem(LOCALE_STORAGE_KEY);
        return isUiLocale(stored) ? stored : preferredUiLocale(navigator.language);
      } catch {
        return preferredUiLocale(navigator.language);
      }
    })();
    setLocale(preferred);
    document.documentElement.lang = preferred;
  }, []);

  useEffect(() => {
    void refreshDevices();
    void refreshUsage();
    const usageTimer: number = window.setInterval(() => void refreshUsage(), USAGE_REFRESH_MS);
    return () => window.clearInterval(usageTimer);
  }, [refreshDevices, refreshUsage]);

  useEffect(() => {
    if (containerStartedAt === null) return;
    const timer: number = window.setInterval(
      () => setSessionElapsedMs(Date.now() - containerStartedAt),
      SESSION_CLOCK_MS,
    );
    return () => window.clearInterval(timer);
  }, [containerStartedAt]);

  useEffect(() => {
    const releaseOnExit = () => {
      if (!containerActiveRef.current) return;
      containerActiveRef.current = false;
      void releaseLanguageContainer({
        tier: tierRef.current,
        sessionId: sessionIdRef.current,
      });
    };
    window.addEventListener("pagehide", releaseOnExit);
    return () => {
      window.removeEventListener("pagehide", releaseOnExit);
      void stopCapture();
    };
  }, [stopCapture]);

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
          <span className="edge-status">◆ {messages.edgeStatus}</span>
          <span className="mode-pill">{messages.liveInference}</span>
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
          <h1>{messages.heroTitle}</h1>
          <p className="hero-description">{messages.heroDescription}</p>
        </div>
        <article className="stable-card panel">
          <div className="stable-header">
            <span>{messages.stableHeading}</span>
            <span className={`pulse status-${captureStatus}`}>
              <i /> {captureStatusLabel(captureStatus, messages)}
            </span>
          </div>
          <div className="stable-language">
            <span className="language-badge">
              <span className="language-code">{inference?.stableLanguage ?? "—"}</span>
              <span>{displayLanguageName(inference?.stableLanguage ?? "unknown", locale)}</span>
            </span>
            <strong>{((inference?.stableConfidence ?? 0) * 100).toFixed(1)}%</strong>
          </div>
          <div className="candidate-row">
            <span>{messages.sprtCandidate}</span>
            <strong>
              {inference?.sprt.candidateLanguage
                ? displayLanguageName(inference.sprt.candidateLanguage, locale)
                : messages.noCandidate}
            </strong>
            <span className="llr">
              LLR {(inference?.sprt.llr ?? 0).toFixed(2)} / {inference?.sprt.acceptLlr ?? 3}
            </span>
          </div>
        </article>
      </section>

      <section className="capture-panel panel">
        <div className="capture-controls">
          <label>
            <span>{messages.microphoneInput}</span>
            <select
              value={selectedDeviceId}
              onChange={(event) => setSelectedDeviceId(event.currentTarget.value)}
              disabled={captureStatus !== "idle" && captureStatus !== "error"}
            >
              <option value="">{messages.defaultMicrophone}</option>
              {devices.map((device, index) => (
                <option key={device.deviceId || `microphone-${index}`} value={device.deviceId}>
                  {device.label || messages.microphoneName(index + 1)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{messages.computeTier}</span>
            <select
              value={tier}
              onChange={(event) =>
                setTier(event.currentTarget.value === "standard" ? "standard" : "basic")
              }
              disabled={captureStatus !== "idle" && captureStatus !== "error"}
            >
              <option value="basic">{messages.basic}</option>
              <option value="standard">{messages.standard}</option>
            </select>
          </label>
          <label>
            <span>{messages.ecapaPattern}</span>
            <select
              value={pattern}
              onChange={(event) =>
                setPattern(
                  event.currentTarget.value === "utterance" ? "utterance" : "rolling-context",
                )
              }
            >
              <option value="rolling-context">{messages.rollingPattern}</option>
              <option value="utterance">{messages.utterancePattern}</option>
            </select>
          </label>
          <button
            className={`primary-button capture-${captureStatus}`}
            type="button"
            onClick={() =>
              void (captureStatus === "live" || captureStatus === "processing"
                ? stopCapture()
                : startCapture())
            }
            disabled={captureStatus === "requesting"}
          >
            {captureStatus === "requesting"
              ? messages.requestingMicrophone
              : captureStatus === "live" || captureStatus === "processing"
                ? messages.stopMicrophone
                : messages.enableMicrophone}
          </button>
        </div>
        <div className="meter-grid">
          <label>
            <span>{messages.inputLevel}</span>
            <meter min={0} max={1} value={audioLevel} />
            <strong>{Math.round(audioLevel * 100)}%</strong>
          </label>
          <label>
            <span>{messages.speechProbability}</span>
            <meter min={0} max={1} value={speechProbability} />
            <strong>{Math.round(speechProbability * 100)}%</strong>
          </label>
          <p>
            <strong>{messages.actualAudioNotice}</strong>
            <span>{messages.privacyNotice}</span>
          </p>
        </div>
        <p className="pattern-detail">
          {pattern === "utterance" ? messages.utteranceDetail : messages.rollingDetail}
        </p>
        {captureError ? <p className="control-error">{captureError}</p> : null}
      </section>

      <section className="latest-strip panel">
        <div>
          <span>{messages.currentInference}</span>
          <strong>{messages.seconds((inference?.speechSeconds ?? 0).toFixed(2))}</strong>
        </div>
        <div>
          <span>{messages.observationQuality}</span>
          <strong>{((inference?.quality ?? 0) * 100).toFixed(1)}%</strong>
        </div>
        <div>
          <span>{messages.inferenceLatency}</span>
          <strong>{messages.milliseconds((inference?.inferenceMs ?? 0).toFixed(1))}</strong>
        </div>
        <div>
          <span>{messages.modelCoverage}</span>
          <strong>{inference?.model ?? "speechbrain/lang-id-voxlingua107-ecapa"}</strong>
        </div>
      </section>

      <section className="posterior-grid">
        <PosteriorPanel
          title={messages.rawPosterior}
          values={inference?.rawLanguages ?? []}
          locale={locale}
        />
        <PosteriorPanel
          title={messages.hsmmPosterior}
          values={inference?.hsmm.posterior ?? []}
          locale={locale}
        />
      </section>

      <section className="diagnostics-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Rust source of truth</p>
            <h2>{messages.diagnostics}</h2>
          </div>
        </div>
        <div className="diagnostic-grid">
          <article className="diagnostic-card panel">
            <h3>{messages.hsmm}</h3>
            <DiagnosticMetric
              label={messages.hsmmDuration}
              value={`${inference?.hsmm.durationTicks ?? 0} ticks`}
              detail="explicit-duration state"
            />
            <DiagnosticMetric
              label={messages.hsmmHazard}
              value={(inference?.hsmm.transitionHazard ?? 0).toFixed(3)}
              detail="P(transition | duration)"
            />
          </article>
          <article className="diagnostic-card panel">
            <h3>{messages.sprt}</h3>
            <DiagnosticMetric
              label={messages.sprtLlr}
              value={(inference?.sprt.llr ?? 0).toFixed(2)}
              detail={messages.sprtCandidate}
            />
            <DiagnosticMetric
              label={messages.sprtBounds}
              value={`${inference?.sprt.rejectLlr ?? -1.5} / ${inference?.sprt.acceptLlr ?? 3}`}
              detail="two-sided sequential test"
            />
          </article>
          <article className="diagnostic-card panel">
            <h3>{messages.hysteresis}</h3>
            <DiagnosticMetric
              label={messages.stablePosterior}
              value={`${((inference?.hysteresis.stablePosterior ?? 0) * 100).toFixed(1)}%`}
              detail={messages.confidence}
            />
            <DiagnosticMetric
              label={`${messages.retainThreshold} / ${messages.enterThreshold}`}
              value={`${((inference?.hysteresis.retainPosterior ?? 0.42) * 100).toFixed(0)} / ${((inference?.hysteresis.enterPosterior ?? 0.72) * 100).toFixed(0)}%`}
              detail="separate retain and enter boundaries"
            />
          </article>
        </div>
      </section>

      <section className="cost-section panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">containersUsageAdaptiveGroups</p>
            <h2>{messages.containerCost}</h2>
          </div>
          <button className="secondary-button" type="button" onClick={() => void refreshUsage()}>
            {messages.refreshUsage}
          </button>
        </div>
        <div className="cost-grid">
          <div className="cost-primary">
            <span>{messages.actualUsage}</span>
            <strong>
              {usage?.available
                ? messages.dollars(usage.estimatedOverageUsd.toFixed(6))
                : messages.usageUnavailable}
            </strong>
            <small>{usage?.detail ?? usageError}</small>
          </div>
          <DiagnosticMetric
            label={messages.grossResourceCost}
            value={messages.dollars((usage?.grossResourceUsd ?? 0).toFixed(6))}
            detail={`${usage?.periodStart ?? "—"} — ${usage?.periodEnd ?? "—"}`}
          />
          <DiagnosticMetric
            label={messages.currentSessionRange}
            value={`${messages.dollars(costRange.low.toFixed(6))}–${messages.dollars(costRange.high.toFixed(6))}`}
            detail={messages.idleShutdown}
          />
        </div>
        <div className="price-table">
          {prices.map((item) => (
            <div className={item.tier === tier ? "price-row active" : "price-row"} key={item.tier}>
              <strong>{item.tier === "basic" ? messages.basic : messages.standard}</strong>
              <span>
                {String(item.vcpu)} vCPU · {String(item.memoryGib)} GiB · {String(item.diskGb)} GB
              </span>
              <span>
                {messages.perHour(item.provisionedHourlyUsd.toFixed(6))} {messages.provisioned}
              </span>
              <span>
                {messages.perHour(item.maximumHourlyUsd.toFixed(6))} {messages.maximumCpu}
              </span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
