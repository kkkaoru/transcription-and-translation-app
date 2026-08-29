// Runs in the browser; built and tested with Bun.
import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { AudioRecord, SortDirection, SttStatus } from "./model";

export interface LegacyAudioRecord extends Omit<AudioRecord, "schemaVersion"> {
  schemaVersion?: 1 | 2;
}

interface VadLabDatabase extends DBSchema {
  recordings: {
    key: string;
    value: AudioRecord;
    indexes: {
      "by-sequence": number;
      "by-started-at": string;
    };
  };
}

export interface NewAudioRecord {
  id: string;
  speechStartedAt: string;
  speechEndedAt: string;
  languageCode: string;
  transcript: string;
  sttSupported: boolean;
  sttStatus: SttStatus;
  sttError: string | null;
  sttProcessingMs: number | null;
  sttConfidence: number | null;
  vadTiming: AudioRecord["vadTiming"];
  mainThreadLoad: AudioRecord["mainThreadLoad"];
  engineInitialization: AudioRecord["engineInitialization"];
  captureConfiguration: AudioRecord["captureConfiguration"];
  vadMemory: AudioRecord["vadMemory"];
  vadProbabilities: AudioRecord["vadProbabilities"];
  audioQuality: AudioRecord["audioQuality"];
  environment: string;
  audioBlob: Blob;
}

const DATABASE_NAME: string = "caption-bridge-vad-lab";
const DATABASE_VERSION: number = 1;
const STORE_NAME = "recordings";
const compareSequenceAscending = (left: AudioRecord, right: AudioRecord): number =>
  left.sequence - right.sequence;
export interface AudioTranscriptUpdate {
  id: string;
  transcript: string;
  status: SttStatus;
  error: string | null;
  processingMs: number | null;
  confidence: number | null;
}

const compareSequenceDescending = (left: AudioRecord, right: AudioRecord): number =>
  right.sequence - left.sequence;
const LEGACY_AUDIO_QUALITY_DEFAULTS = {
  peakDbfs: null,
  rmsDbfs: null,
  meanAmplitude: 0,
  standardDeviation: 0,
  minimumAmplitude: 0,
  maximumAmplitude: 0,
  crestFactor: null,
};
const LEGACY_MEMORY_DEFAULTS = {
  startBreakdownJson: "[]",
  endBreakdownJson: "[]",
  workerAttributedBytes: null,
  wasmAttributedBytes: null,
  workerWasmAttributedBytes: null,
};
const LEGACY_TIMING_DEFAULTS = {
  callbackAverageMs: 0,
  callbackMaximumMs: 0,
  frameIntervalAverageMs: 0,
  frameIntervalP50Ms: 0,
  frameIntervalP95Ms: 0,
  frameIntervalMaximumMs: 0,
  frameIntervalJitterMs: 0,
  framesPerSecond: 0,
  realTimeFactor: 0,
  delayedFrameCount: 0,
};
const LEGACY_MAIN_THREAD_LOAD: AudioRecord["mainThreadLoad"] = {
  longTaskSupported: false,
  longTaskCount: 0,
  longTaskTotalMs: 0,
  longTaskMaximumMs: 0,
  eventLoopLagAverageMs: 0,
  eventLoopLagMaximumMs: 0,
  eventLoopSampleCount: 0,
};
const LEGACY_ENGINE_INITIALIZATION: AudioRecord["engineInitialization"] = {
  initializationMs: 0,
  memoryBeforeBytes: null,
  memoryAfterBytes: null,
  measuredPageDeltaBytes: null,
  memoryMethod: "unavailable",
  memoryBeforeBreakdownJson: "[]",
  memoryAfterBreakdownJson: "[]",
  exactSileroWasmMemoryAvailable: false,
};
const LEGACY_CAPTURE_CONFIGURATION: AudioRecord["captureConfiguration"] = {
  requestedMicrophone: {
    deviceId: "",
    deviceLabel: "Browser default",
    groupId: "",
    echoCancellation: "default",
    noiseSuppression: "default",
    autoGainControl: "default",
    voiceIsolation: "default",
    suppressLocalAudioPlayback: "default",
    restrictOwnAudio: "default",
    channelCount: null,
    sampleRate: null,
    sampleSize: null,
    latency: null,
    volume: null,
  },
  vad: {
    positiveSpeechThreshold: 0,
    negativeSpeechThreshold: 0,
    redemptionMs: 0,
    preSpeechPadMs: 0,
    minSpeechMs: 0,
    processorPreference: "auto",
  },
  processorUsed: "ScriptProcessor",
  audioWorkletAvailable: false,
  requestedConstraintsJson: "{}",
  supportedConstraintsJson: "{}",
  actualSettingsJson: "{}",
  capabilitiesJson: "{}",
};

export const normalizeRecord = (record: AudioRecord | LegacyAudioRecord): AudioRecord => {
  if (record.schemaVersion === 3) {
    return record;
  }
  return {
    ...record,
    schemaVersion: 3,
    sttStatus: record.sttStatus ?? (record.sttSupported ? "completed" : "unsupported"),
    sttProcessingMs: record.sttProcessingMs ?? null,
    sttConfidence: record.sttConfidence ?? null,
    audioQuality: Object.assign({}, LEGACY_AUDIO_QUALITY_DEFAULTS, record.audioQuality),
    vadMemory: Object.assign({}, LEGACY_MEMORY_DEFAULTS, record.vadMemory),
    vadTiming: Object.assign({}, LEGACY_TIMING_DEFAULTS, record.vadTiming),
    mainThreadLoad: record.mainThreadLoad ?? LEGACY_MAIN_THREAD_LOAD,
    engineInitialization: record.engineInitialization ?? LEGACY_ENGINE_INITIALIZATION,
    captureConfiguration: record.captureConfiguration ?? LEGACY_CAPTURE_CONFIGURATION,
  };
};

const database: Promise<IDBPDatabase<VadLabDatabase>> = openDB<VadLabDatabase>(
  DATABASE_NAME,
  DATABASE_VERSION,
  {
    upgrade: (db) => {
      const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("by-sequence", "sequence", { unique: true });
      store.createIndex("by-started-at", "speechStartedAt");
    },
  },
);

export const addAudioRecord = async (input: NewAudioRecord): Promise<AudioRecord> => {
  const db: IDBPDatabase<VadLabDatabase> = await database;
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const cursor = await store.index("by-sequence").openCursor(null, "prev");
  const previous: AudioRecord | null = cursor?.value ?? null;
  const record: AudioRecord = {
    ...input,
    schemaVersion: 3,
    previousAudioId: previous?.id ?? null,
    nextAudioId: null,
    sequence: (previous?.sequence ?? 0) + 1,
  };
  await store.add(record);
  await (previous === null
    ? Promise.resolve()
    : store.put({ ...previous, nextAudioId: record.id }));
  await transaction.done;
  return record;
};

export const listAudioRecords = async (
  direction: SortDirection = "asc",
): Promise<AudioRecord[]> => {
  const db: IDBPDatabase<VadLabDatabase> = await database;
  const records: AudioRecord[] = (await db.getAll(STORE_NAME)).map(normalizeRecord);
  return records.sort(direction === "asc" ? compareSequenceAscending : compareSequenceDescending);
};

export const clearAudioRecords = async (): Promise<void> => {
  const db: IDBPDatabase<VadLabDatabase> = await database;
  await db.clear(STORE_NAME);
};

export const updateAudioTranscript = async ({
  id,
  transcript,
  status,
  error,
  processingMs,
  confidence,
}: AudioTranscriptUpdate): Promise<AudioRecord | null> => {
  const db: IDBPDatabase<VadLabDatabase> = await database;
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const record: AudioRecord | undefined = await store.get(id);
  const updated: AudioRecord | null =
    record === undefined
      ? null
      : {
          ...normalizeRecord(record),
          transcript,
          sttStatus: status,
          sttError: error,
          sttProcessingMs: processingMs,
          sttConfidence: confidence,
        };
  await (updated === null ? Promise.resolve() : store.put(updated));
  await transaction.done;
  return updated;
};
