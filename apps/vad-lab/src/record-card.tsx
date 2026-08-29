// Runs in the browser; built and tested with Bun.
import { useEffect, useState } from "react";
import { MetricsPanel } from "./metrics-panel";
import type { AudioRecord } from "./model";

interface RecordCardProps {
  record: AudioRecord;
  isPlaying: boolean;
  onPlay: (id: string) => void;
}

const formatDate = (value: string): string =>
  new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
const captionsUrl = (transcript: string): string =>
  `data:text/vtt;charset=utf-8,${encodeURIComponent(`WEBVTT\n\n00:00:00.000 --> 23:59:59.999\n${transcript || "Speech"}`)}`;

export function RecordCard({ record, isPlaying, onPlay }: RecordCardProps) {
  const [audioUrl, setAudioUrl] = useState<string>("");

  useEffect(() => {
    const url: string = URL.createObjectURL(record.audioBlob);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [record.audioBlob]);

  return (
    <article className={isPlaying ? "record-card is-playing" : "record-card"}>
      <header className="record-header">
        <div>
          <span className="sequence">#{record.sequence}</span>
          <strong>{record.transcript || `STT: ${record.sttStatus}`}</strong>
          <span className="language-badge">{record.languageCode}</span>
        </div>
        {isPlaying ? <span className="playing-badge">再生中</span> : null}
      </header>

      <div className="audio-row">
        <audio controls preload="metadata" src={audioUrl} aria-label={`音声 ${record.id}`}>
          <track
            default
            kind="captions"
            src={captionsUrl(record.transcript)}
            srcLang={record.languageCode}
            label="Web Speech API transcript"
          />
        </audio>
        <button type="button" className="secondary" onClick={() => onPlay(record.id)}>
          この音声を順次再生
        </button>
      </div>

      <dl className="primary-grid">
        <div>
          <dt>音声ID</dt>
          <dd className="mono">{record.id}</dd>
        </div>
        <div>
          <dt>前の音声ID</dt>
          <dd className="mono">{record.previousAudioId ?? "なし"}</dd>
        </div>
        <div>
          <dt>次の音声ID</dt>
          <dd className="mono">{record.nextAudioId ?? "なし"}</dd>
        </div>
        <div>
          <dt>発話開始</dt>
          <dd>{formatDate(record.speechStartedAt)}</dd>
        </div>
        <div>
          <dt>発話終了</dt>
          <dd>{formatDate(record.speechEndedAt)}</dd>
        </div>
        <div>
          <dt>言語コード</dt>
          <dd>{record.languageCode}</dd>
        </div>
        <div>
          <dt>音声単位STT</dt>
          <dd>{record.transcript || "（結果なし）"}</dd>
        </div>
        <div>
          <dt>STT状態</dt>
          <dd>{record.sttStatus}</dd>
        </div>
        <div>
          <dt>STTエラー</dt>
          <dd>{record.sttError ?? "なし"}</dd>
        </div>
      </dl>

      <details className="record-metrics-details">
        <summary>この音声区切りの全メトリクス</summary>
        <MetricsPanel record={record} />
      </details>
    </article>
  );
}
