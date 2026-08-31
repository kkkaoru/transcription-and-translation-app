@preconcurrency import AVFoundation
@preconcurrency import Flutter
@preconcurrency import Speech
import SwiftUI
import Translation
import UIKit

enum PairingLinkStore {
  static var pending: String?
  static var sink: FlutterEventSink?

  static func emit(_ url: URL) {
    let value = url.absoluteString
    if let sink {
      sink(value)
    } else {
      pending = value
    }
  }
}

final class PairingStreamHandler: NSObject, FlutterStreamHandler {
  func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
    PairingLinkStore.sink = events
    if let pending = PairingLinkStore.pending {
      events(pending)
      PairingLinkStore.pending = nil
    }
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    PairingLinkStore.sink = nil
    return nil
  }
}

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    if let url = launchOptions?[.url] as? URL {
      PairingLinkStore.emit(url)
    }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    PairingLinkStore.emit(url)
    return super.application(app, open: url, options: options)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    guard
      let registrar = engineBridge.pluginRegistry.registrar(
        forPlugin: "KotobaBeaconCompanionProcessing"
      )
    else { return }
    CompanionProcessingPlugin.register(with: registrar)
    FlutterEventChannel(
      name: "kotoba_beacon/pairing",
      binaryMessenger: registrar.messenger()
    ).setStreamHandler(PairingStreamHandler())
  }
}

@MainActor
final class CompanionProcessingPlugin: NSObject, @preconcurrency FlutterStreamHandler {
  private static let methodChannel = "kotoba_beacon/processing"
  private static let eventChannel = "kotoba_beacon/processing_events"

  private var eventSink: FlutterEventSink?
  private var bonjourDiscovery: BonjourCompanionDiscovery?
  private var speechProcessor: SpeechAnalyzerProcessor?
  private var sfSpeechProcessor: SFSpeechRecognizerProcessor?
  private var translationManager = PlatformTranslationManager()
  private weak var presentingViewController: UIViewController?

  static func register(with registrar: FlutterPluginRegistrar) {
    let plugin = CompanionProcessingPlugin()
    plugin.presentingViewController = registrar.viewController
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
    case "openSystemCamera":
      openSystemCamera(result: result)
    case "discoverCompanion":
      discoverCompanion(call.arguments, result: result)
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
      let provider = values["provider"] as? String ?? "platformSpeechAnalyzer"
      Task { @MainActor in
        do {
          if provider == "platformSFSpeechRecognizer" {
            try await SFSpeechRecognizerProcessor.prepare(localeIdentifier: locale)
          } else {
            _ = try await SpeechAnalyzerProcessor.prepareModel(localeIdentifier: locale)
          }
          result(nil)
        } catch {
          result(FlutterError(code: "asr_unavailable", message: error.localizedDescription, details: nil))
        }
      }
    case "startAsr":
      startAsr(call.arguments, result: result)
    case "appendPcm":
      guard let data = call.arguments as? FlutterStandardTypedData else {
        result(FlutterError(code: "invalid_audio", message: "PCM16 bytes are required", details: nil))
        return
      }
      do {
        if let sfSpeechProcessor {
          try sfSpeechProcessor.append(data.data)
        } else {
          try speechProcessor?.append(data.data)
        }
        result(nil)
      } catch {
        result(FlutterError(code: "audio_conversion_failed", message: error.localizedDescription, details: nil))
      }
    case "finishAsr":
      Task { @MainActor in
        await speechProcessor?.finish()
        sfSpeechProcessor?.finish()
        result(nil)
      }
    case "prepareTranslation":
      prepareTranslation(call.arguments, result: result)
    case "translate":
      translate(call.arguments, result: result)
    case "releaseTranslation":
      translationManager.release()
      result(nil)
    case "cancel":
      Task { @MainActor in
        await speechProcessor?.cancel()
        speechProcessor = nil
        sfSpeechProcessor?.cancel()
        sfSpeechProcessor = nil
        translationManager.release()
        result(nil)
      }
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func openSystemCamera(result: @escaping FlutterResult) {
    guard let url = URL(string: "camera://") else {
      result(
        FlutterError(
          code: "camera_unavailable",
          message: "The system camera app is unavailable",
          details: nil
        )
      )
      return
    }
    UIApplication.shared.open(url, options: [:]) { success in
      if success {
        result(nil)
        return
      }
      result(
        FlutterError(
          code: "camera_unavailable",
          message: "The system camera app could not be opened",
          details: nil
        )
      )
    }
  }

  private func discoverCompanion(_ arguments: Any?, result: @escaping FlutterResult) {
    let values = arguments as? [String: Any]
    let requestedMilliseconds = values?["timeoutMillis"] as? Int ?? 3_000
    let timeout = Double(min(max(requestedMilliseconds, 500), 10_000)) / 1_000
    bonjourDiscovery?.cancel()
    let discovery = BonjourCompanionDiscovery(timeout: timeout) { [weak self] value in
      self?.bonjourDiscovery = nil
      result(value)
    }
    bonjourDiscovery = discovery
    discovery.start()
  }

  private func reportCapabilities(result: @escaping FlutterResult) {
    Task { @MainActor in
      // The deployment target guarantees SpeechAnalyzer API availability.
      // Locale/model validation is deferred to startAsr to avoid prompting
      // for Speech permission during capability-only pairing.
      let speechTranscriberAvailable = SpeechTranscriber.isAvailable
      let sfSpeechRecognizerAvailable =
        SFSpeechRecognizer(locale: Locale(identifier: "ja-JP"))?.supportsOnDeviceRecognition == true
      let asrAvailable = speechTranscriberAvailable || sfSpeechRecognizerAvailable
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
        "speechTranscriberAvailable": speechTranscriberAvailable,
        "sfSpeechRecognizerAvailable": sfSpeechRecognizerAvailable,
        "translationAvailable": true,
      ])
    }
  }

  private func prepareTranslation(_ arguments: Any?, result: @escaping FlutterResult) {
    guard
      let values = arguments as? [String: Any],
      values["sourceLanguage"] as? String == "ja",
      values["targetLanguage"] as? String == "en",
      let provider = values["provider"] as? String,
      let presentingViewController
    else {
      result(FlutterError(code: "invalid_arguments", message: "Japanese-to-English translation provider is required", details: nil))
      return
    }
    Task { @MainActor in
      do {
        try await translationManager.prepare(
          provider: provider,
          presentingViewController: presentingViewController
        )
        result(nil)
      } catch {
        result(FlutterError(code: "translation_unavailable", message: error.localizedDescription, details: nil))
      }
    }
  }

  private func translate(_ arguments: Any?, result: @escaping FlutterResult) {
    guard
      let values = arguments as? [String: Any],
      let text = values["text"] as? String,
      !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
      result(FlutterError(code: "invalid_arguments", message: "Translation text is required", details: nil))
      return
    }
    Task { @MainActor in
      do {
        result(try await translationManager.translate(text))
      } catch {
        result(FlutterError(code: "translation_failed", message: error.localizedDescription, details: nil))
      }
    }
  }

  private func startAsr(_ arguments: Any?, result: @escaping FlutterResult) {
    guard
      let values = arguments as? [String: Any],
      let sessionId = values["sessionId"] as? String,
      let turnId = values["turnId"] as? String,
      let revision = values["revision"] as? String,
      let locale = values["locale"] as? String,
      let provider = values["provider"] as? String
    else {
      result(FlutterError(code: "invalid_arguments", message: "ASR session metadata is required", details: nil))
      return
    }
    let metadata = RecognitionMetadata(
      sessionId: sessionId,
      turnId: turnId,
      revision: revision
    )
    if provider == "platformSFSpeechRecognizer" {
      let processor = SFSpeechRecognizerProcessor { [weak self] event in
        self?.eventSink?(event)
      }
      sfSpeechProcessor = processor
      Task { @MainActor in
        do {
          try await processor.start(localeIdentifier: locale, metadata: metadata)
          result(nil)
        } catch {
          self.emitError(stage: "asr", message: error.localizedDescription)
          result(FlutterError(code: "asr_unavailable", message: error.localizedDescription, details: nil))
        }
      }
      return
    }
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

  private func emitError(stage: String, message: String) {
    eventSink?(["type": "error", "stage": stage, "message": message])
  }
}

@MainActor
private final class BonjourCompanionDiscovery: NSObject,
  @preconcurrency NetServiceBrowserDelegate, @preconcurrency NetServiceDelegate
{
  private static let serviceType = "_kotobabeacon._tcp."

  private let timeout: TimeInterval
  private let completion: (Any?) -> Void
  private let browser = NetServiceBrowser()
  private var service: NetService?
  private var timeoutTimer: Timer?
  private var completed = false

  init(timeout: TimeInterval, completion: @escaping (Any?) -> Void) {
    self.timeout = timeout
    self.completion = completion
  }

  func start() {
    browser.delegate = self
    timeoutTimer = Timer.scheduledTimer(
      withTimeInterval: timeout,
      repeats: false
    ) { [weak self] _ in
      Task { @MainActor in
        self?.finish(
          FlutterError(
            code: "discovery_timeout",
            message: "Kotoba Beacon Native was not found on the local network",
            details: nil
          )
        )
      }
    }
    browser.searchForServices(ofType: Self.serviceType, inDomain: "local.")
  }

  func cancel() {
    guard !completed else { return }
    completed = true
    cleanup()
  }

  func netServiceBrowser(
    _ browser: NetServiceBrowser,
    didFind service: NetService,
    moreComing: Bool
  ) {
    guard self.service == nil else { return }
    self.service = service
    service.delegate = self
    service.resolve(withTimeout: timeout)
  }

  func netServiceDidResolveAddress(_ sender: NetService) {
    guard let data = sender.txtRecordData() else { return }
    let record = NetService.dictionary(fromTXTRecord: data)
    guard
      let endpointData = record["endpoint"],
      let tokenData = record["token"],
      let endpoint = String(data: endpointData, encoding: .utf8),
      let token = String(data: tokenData, encoding: .utf8)
    else { return }
    finish(["endpoint": endpoint, "token": token])
  }

  func netService(
    _ sender: NetService,
    didNotResolve errorDict: [String: NSNumber]
  ) {
    service = nil
  }

  private func finish(_ value: Any?) {
    guard !completed else { return }
    completed = true
    cleanup()
    completion(value)
  }

  private func cleanup() {
    timeoutTimer?.invalidate()
    timeoutTimer = nil
    service?.stop()
    service = nil
    browser.stop()
    browser.delegate = nil
  }
}

@MainActor
private final class PlatformTranslationManager {
  private var host: UIHostingController<TranslationSessionHost>?
  private var session: TranslationSession?
  private var preparationCompleted = false

  func prepare(
    provider: String,
    presentingViewController: UIViewController
  ) async throws {
    guard #available(iOS 26.4, *) else {
      throw PlatformTranslationFailure.unsupportedProvider
    }
    try await prepareWithStrategy(
      provider: provider,
      presentingViewController: presentingViewController
    )
  }

  @available(iOS 26.4, *)
  private func prepareWithStrategy(
    provider: String,
    presentingViewController: UIViewController
  ) async throws {
    release()
    let strategy: TranslationSession.Strategy
    switch provider {
    case "platformTranslationSession":
      strategy = .lowLatency
    case "platformTranslationSessionHighFidelity":
      strategy = .highFidelity
    default:
      throw PlatformTranslationFailure.unsupportedProvider
    }
    let configuration = TranslationSession.Configuration(
      source: Locale.Language(identifier: "ja"),
      target: Locale.Language(identifier: "en"),
      preferredStrategy: strategy
    )
    try await withCheckedThrowingContinuation { continuation in
      let rootView = TranslationSessionHost(configuration: configuration) { [weak self] session in
        guard let self, !self.preparationCompleted else { return }
        do {
          try await session.prepareTranslation()
          self.session = session
          self.preparationCompleted = true
          continuation.resume()
        } catch {
          self.preparationCompleted = true
          continuation.resume(throwing: error)
        }
      }
      let host = UIHostingController(rootView: rootView)
      self.host = host
      presentingViewController.addChild(host)
      presentingViewController.view.addSubview(host.view)
      host.view.frame = CGRect(x: -2, y: -2, width: 1, height: 1)
      host.view.alpha = 0.01
      host.didMove(toParent: presentingViewController)
    }
  }

  func translate(_ text: String) async throws -> String {
    guard let session else { throw PlatformTranslationFailure.notPrepared }
    let response = try await session.translate(text)
    return response.targetText
  }

  func release() {
    session?.cancel()
    session = nil
    preparationCompleted = false
    host?.willMove(toParent: nil)
    host?.view.removeFromSuperview()
    host?.removeFromParent()
    host = nil
  }
}

private struct TranslationSessionHost: View {
  let configuration: TranslationSession.Configuration
  let onSession: @MainActor (TranslationSession) async -> Void

  var body: some View {
    Color.clear.translationTask(configuration) { session in
      await onSession(session)
    }
  }
}

private enum PlatformTranslationFailure: LocalizedError {
  case unsupportedProvider
  case notPrepared

  var errorDescription: String? {
    switch self {
    case .unsupportedProvider: "The selected TranslationSession strategy is unsupported"
    case .notPrepared: "TranslationSession is not prepared"
    }
  }
}

private struct RecognitionMetadata: Sendable {
  let sessionId: String
  let turnId: String
  let revision: String
}

private enum SpeechAnalyzerFailure: LocalizedError {
  case unsupportedLocale
  case modelUnavailable
  case audioFormatUnavailable
  case audioBufferCreationFailed
  case audioConversionFailed

  var errorDescription: String? {
    switch self {
    case .unsupportedLocale: "SpeechAnalyzer does not support the requested locale"
    case .modelUnavailable: "The SpeechAnalyzer language model could not be installed"
    case .audioFormatUnavailable: "SpeechAnalyzer did not provide a compatible PCM format"
    case .audioBufferCreationFailed: "Could not create a PCM input buffer"
    case .audioConversionFailed: "Could not convert PCM16 audio for SpeechAnalyzer"
    }
  }
}

@MainActor
private final class SFSpeechRecognizerProcessor {
  typealias EventHandler = @MainActor ([String: Any]) -> Void

  private let eventHandler: EventHandler
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var metadata: RecognitionMetadata?

  init(eventHandler: @escaping EventHandler) {
    self.eventHandler = eventHandler
  }

  func start(localeIdentifier: String, metadata: RecognitionMetadata) async throws {
    cancel()
    let recognizer = try await Self.prepare(localeIdentifier: localeIdentifier)
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = true
    self.recognizer = recognizer
    self.request = request
    self.metadata = metadata
    task = recognizer.recognitionTask(with: request) { [weak self] response, error in
      Task { @MainActor in
        guard let self, let metadata = self.metadata else { return }
        if let response {
          self.eventHandler([
            "type": "asr",
            "sessionId": metadata.sessionId,
            "turnId": metadata.turnId,
            "revision": metadata.revision,
            "text": response.bestTranscription.formattedString,
            "isFinal": response.isFinal,
          ])
        }
        if let error {
          self.eventHandler([
            "type": "error",
            "stage": "asr",
            "message": error.localizedDescription,
          ])
        }
      }
    }
  }

  func append(_ pcm16: Data) throws {
    guard let request else { return }
    request.append(try Self.makePcm16Buffer(pcm16))
  }

  func finish() {
    request?.endAudio()
  }

  func cancel() {
    request?.endAudio()
    task?.cancel()
    task = nil
    request = nil
    recognizer = nil
    metadata = nil
  }

  static func prepare(localeIdentifier: String) async throws -> SFSpeechRecognizer {
    let status = await authorizationStatus()
    guard status == .authorized else { throw SFSpeechFailure.permissionDenied }
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else {
      throw SFSpeechFailure.unsupportedLocale
    }
    guard recognizer.supportsOnDeviceRecognition else {
      throw SFSpeechFailure.onDeviceRecognitionUnavailable
    }
    return recognizer
  }

  private static func authorizationStatus() async -> SFSpeechRecognizerAuthorizationStatus {
    let current = SFSpeechRecognizer.authorizationStatus()
    if current != .notDetermined { return current }
    return await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { status in
        continuation.resume(returning: status)
      }
    }
  }

  private static func makePcm16Buffer(_ bytes: Data) throws -> AVAudioPCMBuffer {
    guard !bytes.isEmpty, bytes.count.isMultiple(of: 2),
      let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
      )
    else { throw SFSpeechFailure.invalidAudio }
    let frameCount = AVAudioFrameCount(bytes.count / MemoryLayout<Int16>.size)
    guard
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount),
      let samples = buffer.int16ChannelData?.pointee
    else { throw SFSpeechFailure.invalidAudio }
    buffer.frameLength = frameCount
    _ = bytes.copyBytes(
      to: UnsafeMutableBufferPointer(start: samples, count: Int(frameCount))
    )
    return buffer
  }
}

private enum SFSpeechFailure: LocalizedError {
  case permissionDenied
  case unsupportedLocale
  case onDeviceRecognitionUnavailable
  case invalidAudio

  var errorDescription: String? {
    switch self {
    case .permissionDenied: "SFSpeechRecognizer permission was denied"
    case .unsupportedLocale: "SFSpeechRecognizer does not support Japanese"
    case .onDeviceRecognitionUnavailable: "On-device SFSpeechRecognizer is unavailable"
    case .invalidAudio: "SFSpeechRecognizer requires PCM16 16 kHz mono audio"
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
    let transcriber = try await Self.prepareModel(localeIdentifier: localeIdentifier)
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

  static func prepareModel(localeIdentifier: String) async throws -> SpeechTranscriber {
    let requestedLocale = Locale(identifier: localeIdentifier)
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requestedLocale) else {
      throw SpeechAnalyzerFailure.unsupportedLocale
    }
    guard SpeechTranscriber.isAvailable else {
      throw SpeechAnalyzerFailure.modelUnavailable
    }
    let transcriber = SpeechTranscriber(
      locale: locale,
      preset: .progressiveTranscription
    )
    try await ensureModelInstalled(transcriber, locale: locale)
    return transcriber
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
