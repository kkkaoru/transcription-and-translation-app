// Runs in the browser; built and tested with Bun.

import { useRegisterSW } from "virtual:pwa-register/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureControls } from "./capture-controls";
import {
  audioWorkletAvailable,
  DEFAULT_MICROPHONE_CONFIGURATION,
  DEFAULT_VAD_CONFIGURATION,
} from "./capture-settings";
import type {
  AudioRecord,
  MicrophoneConfiguration,
  RealtimeDiagnosticSample,
  SortDirection,
  VadConfiguration,
} from "./model";
import { DEFAULT_LANGUAGE_CODE, LANGUAGE_OPTIONS } from "./model";
import { RealtimeDiagnostics } from "./realtime-diagnostics";
import { RecordCard } from "./record-card";
import { SourceLinks } from "./source-links";
import { AudioSpeechRecognizer } from "./speech";
import { clearAudioRecords, listAudioRecords } from "./storage";
import { VadRecorder } from "./vad-recorder";

interface StorageEstimateView {
  usage: number | null;
}

type RecorderStatus = "idle" | "starting" | "listening" | "stopping" | "error";

const EMPTY_STORAGE_ESTIMATE: StorageEstimateView = { usage: null };
const MAX_REALTIME_SAMPLES: number = 240;
const QUERY_KEY: readonly string[] = ["vad-audio-records"] satisfies readonly string[];
const STATUS_LABELS: Readonly<Record<RecorderStatus, string>> = {
  idle: "停止中",
  starting: "VADを初期化中",
  listening: "マイク監視中",
  stopping: "停止処理中",
  error: "エラー",
};
const compareRecordSequence = (left: AudioRecord, right: AudioRecord): number =>
  left.sequence - right.sequence;
const upsertRecord = (
  records: readonly AudioRecord[] | undefined,
  record: AudioRecord,
): AudioRecord[] =>
  [...(records ?? []).filter((item) => item.id !== record.id), record].sort(compareRecordSequence);
const formatStorage = (value: number | null): string =>
  value === null ? "取得不可" : `${(value / 1_048_576).toFixed(2)} MiB`;
const recognitionCodeFor = (languageCode: string): string =>
  LANGUAGE_OPTIONS.find((option) => option.code === languageCode)?.recognitionCode ?? "ja-JP";

export function App() {
  const queryClient = useQueryClient();
  const [languageCode, setLanguageCode] = useState<string>(DEFAULT_LANGUAGE_CODE);
  const [microphoneConfiguration, setMicrophoneConfiguration] = useState<MicrophoneConfiguration>(
    DEFAULT_MICROPHONE_CONFIGURATION,
  );
  const [vadConfiguration, setVadConfiguration] =
    useState<VadConfiguration>(DEFAULT_VAD_CONFIGURATION);
  const [microphoneDevices, setMicrophoneDevices] = useState<MediaDeviceInfo[]>([]);
  const [diagnosticSamples, setDiagnosticSamples] = useState<RealtimeDiagnosticSample[]>([]);
  const languageRef = useRef<string>(DEFAULT_LANGUAGE_CODE);
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [activeAudioId, setActiveAudioId] = useState<string | null>(null);
  const [liveTranscript, setLiveTranscript] = useState<string>("");
  const [speechProbability, setSpeechProbability] = useState<number>(0);
  const [autoPlay, setAutoPlay] = useState<boolean>(true);
  const autoPlayRef = useRef<boolean>(true);
  const [playbackQueue, setPlaybackQueue] = useState<string[]>([]);
  const [playbackGeneration, setPlaybackGeneration] = useState<number>(0);
  const [storageEstimate, setStorageEstimate] =
    useState<StorageEstimateView>(EMPTY_STORAGE_ESTIMATE);
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW();

  const recordsQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => listAudioRecords("asc"),
  });
  const chronologicalRecords: AudioRecord[] = recordsQuery.data ?? [];
  const displayedRecords: AudioRecord[] = useMemo(
    () =>
      sortDirection === "asc"
        ? [...chronologicalRecords].sort(compareRecordSequence)
        : [...chronologicalRecords].sort(compareRecordSequence).reverse(),
    [chronologicalRecords, sortDirection],
  );
  const recordsById: Map<string, AudioRecord> = useMemo(
    () => new Map(chronologicalRecords.map((record) => [record.id, record])),
    [chronologicalRecords],
  );
  const recordsByIdRef = useRef<Map<string, AudioRecord>>(recordsById);
  recordsByIdRef.current = recordsById;
  const playingAudioId: string | null = playbackQueue[0] ?? null;
  const playbackKey: string = `${playbackGeneration}:${playingAudioId ?? ""}`;
  const totalAudioBytes: number = chronologicalRecords.reduce(
    (total, record) => total + record.audioBlob.size,
    0,
  );

  const speechRecognizer = useMemo(() => new AudioSpeechRecognizer(), []);

  const refreshStorageEstimate = useCallback((): void => {
    void navigator.storage.estimate().then((estimate) =>
      setStorageEstimate({
        usage: estimate.usage ?? null,
      }),
    );
  }, []);

  const handleSaved = useCallback(
    (record: AudioRecord): void => {
      queryClient.setQueryData<AudioRecord[]>(QUERY_KEY, (records) =>
        upsertRecord(records, record),
      );
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      setLiveTranscript(
        record.sttStatus === "processing"
          ? `音声 ${record.id} のSTT処理中`
          : (record.sttError ?? "Web Speech APIは利用できません"),
      );
      setPlaybackQueue((queue) => (autoPlayRef.current ? [...queue, record.id] : queue));
      refreshStorageEstimate();
    },
    [queryClient, refreshStorageEstimate],
  );

  const handleDiagnosticSample = useCallback((sample: RealtimeDiagnosticSample): void => {
    setDiagnosticSamples((samples) => [...samples.slice(-(MAX_REALTIME_SAMPLES - 1)), sample]);
  }, []);

  const handleTranscribed = useCallback(
    (record: AudioRecord): void => {
      setLiveTranscript(record.transcript || record.sttError || "STT結果なし");
      queryClient.setQueryData<AudioRecord[]>(QUERY_KEY, (records) =>
        upsertRecord(records, record),
      );
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    [queryClient],
  );

  const recorder = useMemo(
    () =>
      new VadRecorder({
        getLanguageCode: () => languageRef.current,
        recognitionLanguageFor: recognitionCodeFor,
        microphoneConfiguration,
        vadConfiguration,
        speechRecognizer,
        onActiveAudioChange: setActiveAudioId,
        onSaved: handleSaved,
        onTranscribed: handleTranscribed,
        onError: setError,
        onProbability: setSpeechProbability,
        onDiagnosticSample: handleDiagnosticSample,
      }),
    [
      handleDiagnosticSample,
      handleSaved,
      handleTranscribed,
      microphoneConfiguration,
      speechRecognizer,
      vadConfiguration,
    ],
  );

  useEffect(() => {
    languageRef.current = languageCode;
  }, [languageCode]);

  useEffect(() => {
    autoPlayRef.current = autoPlay;
  }, [autoPlay]);

  useEffect(() => {
    const updateDevices = (): void => {
      void navigator.mediaDevices
        .enumerateDevices()
        .then((devices) =>
          setMicrophoneDevices(devices.filter((device) => device.kind === "audioinput")),
        );
    };
    updateDevices();
    navigator.mediaDevices.addEventListener("devicechange", updateDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", updateDevices);
  }, []);

  useEffect(() => {
    const updateOnline = (): void => setIsOnline(navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  useEffect(refreshStorageEstimate, [refreshStorageEstimate]);

  useEffect(() => {
    const requestedAudioId: string = playbackKey.slice(playbackKey.indexOf(":") + 1);
    if (requestedAudioId === "") {
      return;
    }
    const record: AudioRecord | undefined = recordsByIdRef.current.get(requestedAudioId);
    if (record === undefined) {
      setPlaybackQueue((queue) => queue.slice(1));
      return;
    }
    const url: string = URL.createObjectURL(record.audioBlob);
    const audio: HTMLAudioElement = new Audio(url);
    audio.onended = () => setPlaybackQueue((queue) => queue.slice(1));
    audio.onerror = () => {
      setError(`音声 ${record.id} を再生できませんでした`);
      setPlaybackQueue((queue) => queue.slice(1));
    };
    void audio.play().catch((playError: unknown) => {
      setError(playError instanceof Error ? playError.message : "自動再生に失敗しました");
      setPlaybackQueue((queue) => queue.slice(1));
    });
    return () => {
      audio.pause();
      URL.revokeObjectURL(url);
    };
  }, [playbackKey]);

  useEffect(
    () => () => {
      void recorder.destroy();
    },
    [recorder],
  );

  const startRecording = async (): Promise<void> => {
    setStatus("starting");
    setError(null);
    try {
      await recorder.start();
      setStatus("listening");
      setDiagnosticSamples([]);
      void navigator.mediaDevices
        .enumerateDevices()
        .then((devices) =>
          setMicrophoneDevices(devices.filter((device) => device.kind === "audioinput")),
        );
    } catch (startError: unknown) {
      setError(startError instanceof Error ? startError.message : "VADを開始できませんでした");
      setStatus("error");
    }
  };

  const stopRecording = async (): Promise<void> => {
    setStatus("stopping");
    await recorder.pause();
    setStatus("idle");
    setActiveAudioId(null);
  };

  const deleteAll = async (): Promise<void> => {
    if (!window.confirm("IndexedDBに保存したすべての音声と計測値を削除しますか？")) {
      return;
    }
    setPlaybackQueue([]);
    await clearAudioRecords();
    await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    refreshStorageEstimate();
  };

  const startPlayback = (ids: string[]): void => {
    setPlaybackQueue(ids);
    setPlaybackGeneration((generation) => generation + 1);
  };

  const playAllChronologically = (): void =>
    startPlayback([...chronologicalRecords].sort(compareRecordSequence).map((record) => record.id));

  return (
    <main>
      <header className="hero">
        <div>
          <p className="eyebrow">LOCAL-FIRST VOICE ACTIVITY DETECTION</p>
          <h1>VAD Lab</h1>
          <p className="hero-copy">
            音声・STT・計測値はこのブラウザのIndexedDBだけに保存され、アプリのサーバーには送信されません。
          </p>
        </div>
        <div className="connection-status">
          <span className={isOnline ? "dot online" : "dot"} />
          {isOnline ? "オンライン" : "オフライン"}
        </div>
      </header>

      {needRefresh ? (
        <section className="update-banner" aria-live="polite">
          <span>新しいバージョンを利用できます。</span>
          <button type="button" onClick={() => void updateServiceWorker(true)}>
            更新する
          </button>
          <button type="button" className="text-button" onClick={() => setNeedRefresh(false)}>
            後で
          </button>
        </section>
      ) : null}
      {offlineReady ? (
        <section className="offline-banner" aria-live="polite">
          オフライン利用の準備ができました。
          <button type="button" className="text-button" onClick={() => setOfflineReady(false)}>
            閉じる
          </button>
        </section>
      ) : null}

      <section className="control-panel">
        <div className="control-heading">
          <div>
            <span className={`status-pill ${status}`}>{STATUS_LABELS[status]}</span>
            <h2>{activeAudioId === null ? "発話待機中" : "音声を生成中"}</h2>
            <p className="mono active-id">{activeAudioId ?? "—"}</p>
          </div>
          <div className="probability">
            <span>{(speechProbability * 100).toFixed(1)}%</span>
            <meter
              aria-label="現在の発話確率"
              min={0}
              max={100}
              value={Math.min(100, speechProbability * 100)}
            />
          </div>
        </div>

        <div className="controls">
          <label>
            発話言語
            <select
              value={languageCode}
              onChange={(event) => setLanguageCode(event.currentTarget.value)}
              disabled={status === "starting" || status === "stopping"}
            >
              {LANGUAGE_OPTIONS.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {status === "listening" ? (
            <button type="button" className="danger" onClick={() => void stopRecording()}>
              VADを停止
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              onClick={() => void startRecording()}
              disabled={status === "starting" || status === "stopping"}
            >
              マイクとVADを開始
            </button>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={autoPlay}
              onChange={(event) => setAutoPlay(event.currentTarget.checked)}
            />
            新しい音声を自動順次再生
          </label>
        </div>
        <CaptureControls
          microphone={microphoneConfiguration}
          vad={vadConfiguration}
          devices={microphoneDevices}
          disabled={status !== "idle" && status !== "error"}
          onMicrophoneChange={setMicrophoneConfiguration}
          onVadChange={setVadConfiguration}
        />
        <p className="live-transcript">
          音声ごとのWeb Speech API: {liveTranscript || "VAD区間の確定待ち"}
        </p>
        <p className="hint">
          Web Speech
          APIはブラウザによって提供元のオンライン音声認識を使う場合があります。完全オフライン時もVAD・保存・再生は動作しますが、STTは利用できない場合があります。自動再生音が再びVADに入らないよう、品質調査ではヘッドフォンを推奨します。
        </p>
        {error === null ? null : (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="summary-grid">
        <div>
          <span>保存音声</span>
          <strong>{chronologicalRecords.length}</strong>
        </div>
        <div>
          <span>音声データ合計</span>
          <strong>{formatStorage(totalAudioBytes)}</strong>
        </div>
        <div>
          <span>このoriginのStorage使用量（推定）</span>
          <strong>{formatStorage(storageEstimate.usage)}</strong>
        </div>
      </section>
      <p className="storage-explanation">
        Storage使用量は <code>navigator.storage.estimate()</code>
        が動的に返す、このorigin全体の概算値です。VAD音声だけの容量は「音声データ合計」に表示します。
      </p>

      <RealtimeDiagnostics
        samples={diagnosticSamples}
        audioWorkletAvailable={audioWorkletAvailable()}
      />

      <section className="records-section">
        <header className="records-toolbar">
          <div>
            <p className="eyebrow">INDEXEDDB RECORDINGS</p>
            <h2>音声記録</h2>
          </div>
          <div className="toolbar-actions">
            <label>
              表示順
              <select
                value={sortDirection}
                onChange={(event) =>
                  setSortDirection(event.currentTarget.value === "desc" ? "desc" : "asc")
                }
              >
                <option value="asc">ASC（古い順）</option>
                <option value="desc">DESC（新しい順）</option>
              </select>
            </label>
            <button
              type="button"
              className="secondary"
              onClick={playAllChronologically}
              disabled={chronologicalRecords.length === 0}
            >
              時系列順にすべて再生
            </button>
            <button
              type="button"
              className="danger-outline"
              onClick={() => void deleteAll()}
              disabled={chronologicalRecords.length === 0}
            >
              すべて削除
            </button>
          </div>
        </header>

        {playingAudioId === null ? null : (
          <p className="now-playing">
            再生中の音声ID: <span className="mono">{playingAudioId}</span>
          </p>
        )}
        {recordsQuery.isLoading ? <p className="empty-state">IndexedDBを読み込み中…</p> : null}
        {recordsQuery.isError ? (
          <p className="error-message">音声記録を読み込めませんでした。</p>
        ) : null}
        {!recordsQuery.isLoading && chronologicalRecords.length === 0 ? (
          <p className="empty-state">まだ音声はありません。VADを開始して発話してください。</p>
        ) : null}
        <div className="record-list">
          {displayedRecords.map((record) => (
            <RecordCard
              key={record.id}
              record={record}
              isPlaying={record.id === playingAudioId}
              onPlay={(id) => startPlayback([id])}
            />
          ))}
        </div>
      </section>

      <SourceLinks />
    </main>
  );
}
