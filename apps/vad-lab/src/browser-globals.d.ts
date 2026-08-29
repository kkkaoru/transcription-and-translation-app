// Runs in the browser; typechecked with Bun.
interface BrowserMemoryInfo {
  readonly jsHeapSizeLimit: number;
  readonly totalJSHeapSize: number;
  readonly usedJSHeapSize: number;
}

interface UserAgentSpecificMemoryAttribution {
  readonly url?: string;
  readonly scope?: string;
}

interface UserAgentSpecificMemoryBreakdown {
  readonly bytes: number;
  readonly attribution?: readonly UserAgentSpecificMemoryAttribution[];
  readonly types?: readonly string[];
}

interface UserAgentSpecificMemoryResult {
  readonly bytes: number;
  readonly breakdown?: readonly UserAgentSpecificMemoryBreakdown[];
}

interface Performance {
  readonly memory?: BrowserMemoryInfo;
  measureUserAgentSpecificMemory?: () => Promise<UserAgentSpecificMemoryResult>;
}

interface Navigator {
  readonly deviceMemory?: number;
}

interface MediaTrackConstraintSet {
  latency?: ConstrainDouble;
  volume?: ConstrainDouble;
  restrictOwnAudio?: ConstrainBoolean;
  suppressLocalAudioPlayback?: ConstrainBoolean;
  voiceIsolation?: ConstrainBoolean;
}

interface MediaTrackSupportedConstraints {
  restrictOwnAudio?: boolean;
  suppressLocalAudioPlayback?: boolean;
  voiceIsolation?: boolean;
}

interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  item(index: number): SpeechRecognitionResultLike;
}

interface SpeechRecognitionResultEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(audioTrack?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructorLike {
  new (): SpeechRecognitionLike;
}

interface Window {
  readonly SpeechRecognition?: SpeechRecognitionConstructorLike;
  readonly webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
}
