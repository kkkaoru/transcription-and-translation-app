package com.kotobabeacon.companion

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.provider.Settings
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.audio.AudioSource
import com.google.mlkit.genai.speechrecognition.SpeechRecognition
import com.google.mlkit.genai.speechrecognition.SpeechRecognizer
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerOptions
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerResponse
import com.google.mlkit.genai.speechrecognition.speechRecognizerOptions
import com.google.mlkit.genai.speechrecognition.speechRecognizerRequest
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.FileOutputStream
import java.io.IOException
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : FlutterActivity(), EventChannel.StreamHandler {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var eventSink: EventChannel.EventSink? = null
    private var pairingSink: EventChannel.EventSink? = null
    private var pendingPairingLink: String? = null
    private var recognizer: SpeechRecognizer? = null
    private var recognitionJob: Job? = null
    private var pipe: Array<ParcelFileDescriptor>? = null
    private var pipeOutput: FileOutputStream? = null
    private var session: RecognitionSession? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        capturePairingLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        capturePairingLink(intent)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, METHOD_CHANNEL)
            .setMethodCallHandler(::handleMethodCall)
        EventChannel(flutterEngine.dartExecutor.binaryMessenger, EVENT_CHANNEL)
            .setStreamHandler(this)
        EventChannel(flutterEngine.dartExecutor.binaryMessenger, PAIRING_EVENT_CHANNEL)
            .setStreamHandler(
                object : EventChannel.StreamHandler {
                    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                        pairingSink = events
                        pendingPairingLink?.let { link ->
                            events?.success(link)
                            pendingPairingLink = null
                        }
                    }

                    override fun onCancel(arguments: Any?) {
                        pairingSink = null
                    }
                },
            )
    }

    override fun onDestroy() {
        cancelProcessing()
        scope.cancel()
        super.onDestroy()
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
        eventSink = events
    }

    override fun onCancel(arguments: Any?) {
        eventSink = null
    }

    private fun handleMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "capabilities" -> reportCapabilities(result)
            "prepareAsr" -> prepareAsr(call, result)
            "startAsr" -> startAsr(call, result)
            "appendPcm" -> appendPcm(call, result)
            "finishAsr" -> {
                finishAsr()
                result.success(null)
            }
            "prepareTranslation", "translate" -> result.error(
                "translation_unavailable",
                "Android platform translation is unavailable; select Mobile Rust QuickMT",
                null,
            )
            "releaseTranslation" -> result.success(null)
            "openSystemCamera" -> openSystemCamera(result)
            "cancel" -> {
                cancelProcessing()
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    private fun reportCapabilities(result: MethodChannel.Result) {
        scope.launch {
            val capabilityRecognizer = SpeechRecognition.getClient(
                speechRecognizerOptions {
                    locale = Locale.JAPAN
                    preferredMode = SpeechRecognizerOptions.Mode.MODE_BASIC
                }
            )
            val asrAvailable = try {
                capabilityRecognizer.checkStatus() in setOf(
                    FeatureStatus.AVAILABLE,
                    FeatureStatus.DOWNLOADABLE,
                )
            } catch (_: Exception) {
                false
            } finally {
                capabilityRecognizer.close()
            }
            val deviceId = Settings.Secure.getString(
                contentResolver,
                Settings.Secure.ANDROID_ID,
            )
            if (deviceId.isNullOrBlank()) {
                result.error(
                    "device_identity_unavailable",
                    "A stable Android device identifier is unavailable",
                    null,
                )
                return@launch
            }
            result.success(
                mapOf(
                    "deviceId" to "android-$deviceId",
                    "deviceName" to "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
                    "platform" to "android",
                    "asrAvailable" to asrAvailable,
                    "translationAvailable" to false,
                )
            )
        }
    }

    private fun prepareAsr(call: MethodCall, result: MethodChannel.Result) {
        val localeTag = call.argument<String>("locale")
        if (localeTag.isNullOrBlank()) {
            result.error("invalid_arguments", "ASR locale is required", null)
            return
        }
        scope.launch {
            val preparationRecognizer = SpeechRecognition.getClient(
                speechRecognizerOptions {
                    locale = Locale.forLanguageTag(localeTag)
                    preferredMode = SpeechRecognizerOptions.Mode.MODE_BASIC
                }
            )
            try {
                ensureSpeechModel(preparationRecognizer)
                result.success(null)
            } catch (error: Exception) {
                result.error("asr_unavailable", error.message, null)
            } finally {
                preparationRecognizer.close()
            }
        }
    }

    private fun startAsr(call: MethodCall, result: MethodChannel.Result) {
        val arguments = call.arguments as? Map<*, *>
        val sessionId = arguments?.get("sessionId") as? String
        val turnId = arguments?.get("turnId") as? String
        val revision = arguments?.get("revision") as? String
        val localeTag = arguments?.get("locale") as? String
        if (sessionId == null || turnId == null || revision == null || localeTag == null) {
            result.error("invalid_arguments", "ASR session metadata is required", null)
            return
        }
        cancelAsr()
        val activeRecognizer = SpeechRecognition.getClient(
            speechRecognizerOptions {
                locale = Locale.forLanguageTag(localeTag)
                preferredMode = SpeechRecognizerOptions.Mode.MODE_BASIC
            }
        )
        recognizer = activeRecognizer
        session = RecognitionSession(sessionId, turnId, revision)
        scope.launch {
            try {
                ensureSpeechModel(activeRecognizer)
                val descriptors = ParcelFileDescriptor.createPipe()
                pipe = descriptors
                pipeOutput = FileOutputStream(descriptors[1].fileDescriptor)
                recognitionJob = scope.launch {
                    val request = speechRecognizerRequest {
                        audioSource = AudioSource.fromPfd(descriptors[0])
                    }
                    activeRecognizer.startRecognition(request).collect(::emitRecognitionResponse)
                }
                result.success(null)
            } catch (error: Exception) {
                emitError("asr", error.message ?: "ML Kit speech recognition failed")
                result.error("asr_unavailable", error.message, null)
                cancelAsr()
            }
        }
    }

    private suspend fun ensureSpeechModel(activeRecognizer: SpeechRecognizer) {
        when (val status = activeRecognizer.checkStatus()) {
            FeatureStatus.AVAILABLE -> return
            FeatureStatus.DOWNLOADABLE -> {
                var completed = false
                activeRecognizer.download().collect { download ->
                    when (download) {
                        is DownloadStatus.DownloadCompleted -> completed = true
                        is DownloadStatus.DownloadFailed -> throw download.e
                        else -> Unit
                    }
                }
                if (!completed) throw IllegalStateException("ML Kit speech model download did not complete")
            }
            else -> throw IllegalStateException("ML Kit speech recognition unavailable: $status")
        }
    }

    private fun appendPcm(call: MethodCall, result: MethodChannel.Result) {
        val bytes = call.arguments as? ByteArray
        val output = pipeOutput
        if (bytes == null || output == null) {
            result.error("asr_not_ready", "ML Kit ASR audio pipe is not ready", null)
            return
        }
        scope.launch(Dispatchers.IO) {
            try {
                output.write(bytes)
                withContext(Dispatchers.Main.immediate) { result.success(null) }
            } catch (error: IOException) {
                withContext(Dispatchers.Main.immediate) {
                    result.error("audio_write_failed", error.message, null)
                }
            }
        }
    }

    private fun finishAsr() {
        try {
            pipeOutput?.close()
        } catch (_: IOException) {
            // Closing is best-effort; the recognizer also observes stopRecognition below.
        }
        pipeOutput = null
        scope.launch { recognizer?.stopRecognition() }
    }

    private fun emitRecognitionResponse(response: SpeechRecognizerResponse) {
        val activeSession = session ?: return
        when (response) {
            is SpeechRecognizerResponse.PartialTextResponse ->
                emitAsr(activeSession, response.text, false)
            is SpeechRecognizerResponse.FinalTextResponse ->
                emitAsr(activeSession, response.text, true)
            is SpeechRecognizerResponse.ErrorResponse ->
                emitError("asr", response.e.message ?: "ML Kit ASR error ${response.e.errorCode}")
            is SpeechRecognizerResponse.CompletedResponse -> finishAsr()
        }
    }

    private fun emitAsr(activeSession: RecognitionSession, text: String, isFinal: Boolean) {
        eventSink?.success(
            mapOf(
                "type" to "asr",
                "sessionId" to activeSession.sessionId,
                "turnId" to activeSession.turnId,
                "revision" to activeSession.revision,
                "text" to text,
                "isFinal" to isFinal,
            )
        )
    }

    private fun cancelProcessing() {
        cancelAsr()
    }

    private fun cancelAsr() {
        recognitionJob?.cancel()
        recognitionJob = null
        try {
            pipeOutput?.close()
            pipe?.forEach(ParcelFileDescriptor::close)
        } catch (_: IOException) {
            // Resource cleanup remains best-effort during cancellation.
        }
        pipeOutput = null
        pipe = null
        recognizer?.close()
        recognizer = null
        session = null
    }

    private fun emitError(stage: String, message: String) {
        eventSink?.success(mapOf("type" to "error", "stage" to stage, "message" to message))
    }

    private fun openSystemCamera(result: MethodChannel.Result) {
        val camera = Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA)
        if (camera.resolveActivity(packageManager) == null) {
            result.error(
                "camera_unavailable",
                "The system camera app is unavailable",
                null,
            )
            return
        }
        startActivity(camera)
        result.success(null)
    }

    private fun capturePairingLink(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "kotobabeacon") return
        val link = uri.toString()
        val sink = pairingSink
        if (sink == null) {
            pendingPairingLink = link
            return
        }
        sink.success(link)
    }

    private data class RecognitionSession(
        val sessionId: String,
        val turnId: String,
        val revision: String,
    )

    companion object {
        private const val METHOD_CHANNEL = "kotoba_beacon/processing"
        private const val EVENT_CHANNEL = "kotoba_beacon/processing_events"
        private const val PAIRING_EVENT_CHANNEL = "kotoba_beacon/pairing"
    }
}
