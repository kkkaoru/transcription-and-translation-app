@preconcurrency import AVFoundation
@preconcurrency import Flutter
import Speech
import Translation
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, @preconcurrency FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    guard
      let registrar = engineBridge.pluginRegistry.registrar(
        forPlugin: "KotobaBeaconCompanionProcessing"
      )
    else { return }
    CompanionProcessingPlugin.register(with: registrar)
  }
}

@MainActor
final class CompanionProcessingPlugin: NSObject, @preconcurrency FlutterStreamHandler {
  private static let methodChannel = "kotoba_beacon/processing"
  private static let eventChannel = "kotoba_beacon/processing_events"

  private var eventSink: FlutterEventSink?
  private var speechProcessor: SpeechAnalyzerProcessor?
  private var translationSession: TranslationSession?

  static func register(with registrar: FlutterPluginRegistrar) {
    let plugin = CompanionProcessingPlugin()
    let methodChannel = FlutterMethodChannel(
      name: methodChannel,
      binaryMessenger: registrar.messenger()
    )
    methodChannel.setMethodCallHandler(plugin.handle)
    let eventChannel = FlutterEventChannel(
      name: eventChannel,
      binaryMessenger: registrar.messenger()
    )
    eventChannel.setStreamHandler(plugin)
  }

  func onListen(
    withArguments arguments: Any?,
    eventSink events: @escaping FlutterEventSink
  ) -> FlutterError? {
    eventSink = events
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    eventSink = nil
    return nil
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "capabilities":
      reportCapabilities(result: result)
    case "prepareAsr":
      guard
        let values = call.arguments as? [String: Any],
        let locale = values["locale"] as? String
      else {
        result(FlutterError(code: "invalid_arguments", message: "ASR locale is required", details: nil))
        return
      }
      Task { @MainActor in
        do {
          _ = try await SpeechAnalyzerProcessor.prepare(localeIdentifier: locale)
          result(nil)
        } catch {
          result(FlutterError(code: "asr_unavailable", message: error.localizedDescription, details: nil))
        }
      }
    case "prepareTranslation":
      prepareTranslation(call.arguments, result: result)
    case "startAsr":
      startAsr(call.arguments, result: result)
    case "appendPcm":
      guard let data = call.arguments as? FlutterStandardTypedData else {
        result(FlutterError(code: "invalid_audio", message: "PCM16 bytes are required", details: nil))
        return
      }
      do {
        try speechProcessor?.append(data.data)
        result(nil)
      } catch {
        result(FlutterError(code: "audio_conversion_failed", message: error.localizedDescription, details: nil))
      }
    case "finishAsr":
      Task { @MainActor in
        await speechProcessor?.finish()
        result(nil)
      }
    case "translate":
      translate(call.arguments, result: result)
    case "cancel":
      Task { @MainActor in
        await speechProcessor?.cancel()
        speechProcessor = nil
        if #available(iOS 26.0, *) { translationSession?.cancel() }
        translationSession = nil
        result(nil)
      }
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func reportCapabilities(result: @escaping FlutterResult) {
    Task { @MainActor in
      let locale = Locale(identifier: "ja-JP")
      let asrAvailable = await SpeechTranscriber.supportedLocale(equivalentTo: locale) != nil
      let source = Locale.Language(identifier: "ja")
      let target = Locale.Language(identifier: "en")
      let translationStatus = await LanguageAvailability().status(from: source, to: target)
      let translationAvailable = translationStatus != .unsupported
      guard let identifier = UIDevice.current.identifierForVendor?.uuidString else {
        result(
          FlutterError(
            code: "device_identity_unavailable",
            message: "A stable iOS vendor identifier is unavailable",
            details: nil
          )
        )
        return
      }
      result([
        "deviceId": "ios-\(identifier)",
        "deviceName": UIDevice.current.name,
        "platform": "ios",
        "asrAvailable": asrAvailable,
        "translationAvailable": translationAvailable,
      ])
    }
  }

  private func startAsr(_ arguments: Any?, result: @escaping FlutterResult) {
    guard
      let values = arguments as? [String: Any],
      let sessionId = values["sessionId"] as? String,
      let turnId = values["turnId"] as? String,
      let revision = values["revision"] as? String,
      let locale = values["locale"] as? String
    else {
      result(FlutterError(code: "invalid_arguments", message: "ASR session metadata is required", details: nil))
      return
    }
    let metadata = RecognitionMetadata(
      sessionId: sessionId,
      turnId: turnId,
      revision: revision
    )
    let processor = SpeechAnalyzerProcessor { [weak self] event in
      self?.eventSink?(event)
    }
    speechProcessor = processor
    Task { @MainActor in
      do {
        try await processor.start(localeIdentifier: locale, metadata: metadata)
        result(nil)
      } catch {
        self.emitError(stage: "asr", message: error.localizedDescription)
        result(FlutterError(code: "asr_unavailable", message: error.localizedDescription, details: nil))
      }
    }
  }

  private func prepareTranslation(_ arguments: Any?, result: @escaping FlutterResult) {
    guard
      let values = arguments as? [String: Any],
      values["sourceLanguage"] as? String == "ja",
      values["targetLanguage"] as? String == "en"
    else {
      result(FlutterError(code: "invalid_arguments", message: "Japanese-to-English languages are required", details: nil))
      return
    }
    Task { @MainActor in
      do {
        let session = installedTranslationSession()
        try await session.prepareTranslation()
        result(nil)
      } catch {
        result(
          FlutterError(
            code: "translation_model_unavailable",
            message: "Install the Japanese and English Translation models: \(error.localizedDescription)",
            details: nil
          )
        )
      }
    }
  }

  private func translate(_ arguments: Any?, result: @escaping FlutterResult) {
    guard
      let values = arguments as? [String: Any],
      let text = values["text"] as? String,
      !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      values["sourceLanguage"] as? String == "ja",
      values["targetLanguage"] as? String == "en"
    else {
      result(FlutterError(code: "invalid_arguments", message: "Japanese-to-English text is required", details: nil))
      return
    }
    Task { @MainActor in
      do {
        let session = installedTranslationSession()
        try await session.prepareTranslation()
        let response = try await session.translate(text)
        result(response.targetText)
      } catch {
        result(
          FlutterError(
            code: "translation_model_unavailable",
            message: "Install the Japanese and English Translation models: \(error.localizedDescription)",
            details: nil
          )
        )
      }
    }
  }

  private func installedTranslationSession() -> TranslationSession {
    if let translationSession { return translationSession }
    let session = TranslationSession(
      installedSource: Locale.Language(identifier: "ja"),
      target: Locale.Language(identifier: "en")
    )
    translationSession = session
    return session
  }

  private func emitError(stage: String, message: String) {
    eventSink?(["type": "error", "stage": stage, "message": message])
  }
}

private struct RecognitionMetadata: Sendable {
  let sessionId: String
  let turnId: String
  let revision: String
}

private enum SpeechAnalyzerFailure: LocalizedError {
  case permissionDenied
  case unsupportedLocale
  case modelUnavailable
  case audioFormatUnavailable
  case audioBufferCreationFailed
  case audioConversionFailed

  var errorDescription: String? {
    switch self {
    case .permissionDenied: "Speech recognition permission was denied"
    case .unsupportedLocale: "SpeechAnalyzer does not support the requested locale"
    case .modelUnavailable: "The SpeechAnalyzer language model could not be installed"
    case .audioFormatUnavailable: "SpeechAnalyzer did not provide a compatible PCM format"
    case .audioBufferCreationFailed: "Could not create a PCM input buffer"
    case .audioConversionFailed: "Could not convert PCM16 audio for SpeechAnalyzer"
    }
  }
}

@available(iOS 26.0, *)
@MainActor
private final class SpeechAnalyzerProcessor {
  typealias EventHandler = @MainActor ([String: Any]) -> Void

  private let eventHandler: EventHandler
  private var analyzer: SpeechAnalyzer?
  private var transcriber: SpeechTranscriber?
  private var inputContinuation: AsyncStream<AnalyzerInput>.Continuation?
  private var resultTask: Task<Void, Never>?
  private var converter: PcmBufferConverter?
  private var metadata: RecognitionMetadata?

  init(eventHandler: @escaping EventHandler) {
    self.eventHandler = eventHandler
  }

  func start(localeIdentifier: String, metadata: RecognitionMetadata) async throws {
    await cancel()
    let transcriber = try await Self.prepare(localeIdentifier: localeIdentifier)
    guard
      let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
        compatibleWith: [transcriber]
      )
    else { throw SpeechAnalyzerFailure.audioFormatUnavailable }
    guard
      let sourceFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
      )
    else { throw SpeechAnalyzerFailure.audioFormatUnavailable }

    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let (sequence, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    self.analyzer = analyzer
    self.transcriber = transcriber
    self.inputContinuation = continuation
    self.converter = try PcmBufferConverter(source: sourceFormat, target: analyzerFormat)
    self.metadata = metadata
    resultTask = Task { @MainActor [weak self] in
      do {
        for try await response in transcriber.results {
          guard let self, let metadata = self.metadata else { return }
          self.eventHandler([
            "type": "asr",
            "sessionId": metadata.sessionId,
            "turnId": metadata.turnId,
            "revision": metadata.revision,
            "text": String(response.text.characters),
            "isFinal": response.isFinal,
          ])
        }
      } catch {
        self?.eventHandler([
          "type": "error",
          "stage": "asr",
          "message": error.localizedDescription,
        ])
      }
    }
    try await analyzer.start(inputSequence: sequence)
  }

  func append(_ pcm16: Data) throws {
    guard !pcm16.isEmpty, pcm16.count.isMultiple(of: 2), let converter else { return }
    let buffer = try converter.convert(pcm16)
    inputContinuation?.yield(AnalyzerInput(buffer: buffer))
  }

  func finish() async {
    inputContinuation?.finish()
    inputContinuation = nil
    try? await analyzer?.finalizeAndFinishThroughEndOfInput()
  }

  func cancel() async {
    inputContinuation?.finish()
    inputContinuation = nil
    await analyzer?.cancelAndFinishNow()
    resultTask?.cancel()
    resultTask = nil
    analyzer = nil
    transcriber = nil
    converter = nil
    metadata = nil
  }

  static func prepare(localeIdentifier: String) async throws -> SpeechTranscriber {
    guard await requestSpeechPermission() else {
      throw SpeechAnalyzerFailure.permissionDenied
    }
    let requestedLocale = Locale(identifier: localeIdentifier)
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requestedLocale) else {
      throw SpeechAnalyzerFailure.unsupportedLocale
    }
    let transcriber = SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [.volatileResults],
      attributeOptions: []
    )
    try await ensureModelInstalled(transcriber, locale: locale)
    return transcriber
  }

  private static func requestSpeechPermission() async -> Bool {
    if SFSpeechRecognizer.authorizationStatus() == .authorized { return true }
    return await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { status in
        continuation.resume(returning: status == .authorized)
      }
    }
  }

  private static func ensureModelInstalled(
    _ transcriber: SpeechTranscriber,
    locale: Locale
  ) async throws {
    let identifier = locale.identifier(.bcp47)
    let installedLocales = await SpeechTranscriber.installedLocales
    if installedLocales.contains(where: { $0.identifier(.bcp47) == identifier }) {
      return
    }
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await request.downloadAndInstall()
    }
    let updatedLocales = await SpeechTranscriber.installedLocales
    guard updatedLocales.contains(where: {
      $0.identifier(.bcp47) == identifier
    }) else { throw SpeechAnalyzerFailure.modelUnavailable }
  }
}

@available(iOS 26.0, *)
private final class PcmBufferConverter {
  private let sourceFormat: AVAudioFormat
  private let targetFormat: AVAudioFormat
  private let converter: AVAudioConverter

  init(source: AVAudioFormat, target: AVAudioFormat) throws {
    guard let converter = AVAudioConverter(from: source, to: target) else {
      throw SpeechAnalyzerFailure.audioConversionFailed
    }
    converter.primeMethod = .none
    self.sourceFormat = source
    self.targetFormat = target
    self.converter = converter
  }

  func convert(_ bytes: Data) throws -> AVAudioPCMBuffer {
    let frameCount = AVAudioFrameCount(bytes.count / MemoryLayout<Int16>.size)
    guard
      let source = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: frameCount),
      let samples = source.int16ChannelData?.pointee
    else { throw SpeechAnalyzerFailure.audioBufferCreationFailed }
    source.frameLength = frameCount
    _ = bytes.copyBytes(
      to: UnsafeMutableBufferPointer(start: samples, count: Int(frameCount))
    )

    let ratio = targetFormat.sampleRate / sourceFormat.sampleRate
    let outputCapacity = AVAudioFrameCount((Double(frameCount) * ratio).rounded(.up))
    guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outputCapacity) else {
      throw SpeechAnalyzerFailure.audioBufferCreationFailed
    }
    var conversionError: NSError?
    let provider = PcmInputProvider(source)
    let status = converter.convert(to: output, error: &conversionError) { _, state in
      guard let input = provider.take() else {
        state.pointee = .noDataNow
        return nil
      }
      state.pointee = .haveData
      return input
    }
    guard status != .error else { throw conversionError ?? SpeechAnalyzerFailure.audioConversionFailed }
    return output
  }
}

@available(iOS 26.0, *)
private final class PcmInputProvider: @unchecked Sendable {
  // AVAudioConverter may invoke its input block from another thread. The lock
  // owns the single non-Sendable AVAudioPCMBuffer and transfers it exactly once.
  private let lock = NSLock()
  private var buffer: AVAudioPCMBuffer?

  init(_ buffer: AVAudioPCMBuffer) {
    self.buffer = buffer
  }

  func take() -> AVAudioPCMBuffer? {
    lock.lock()
    defer { lock.unlock() }
    defer { buffer = nil }
    return buffer
  }
}
