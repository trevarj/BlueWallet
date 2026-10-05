package io.bluewallet.bluewallet

import android.app.Application
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle
import android.text.InputType
import android.text.method.PasswordTransformationMethod
import android.widget.Button
import android.widget.EditText
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.view.WindowManager
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.common.LifecycleState
import com.wizardsardine.bhwi.HidChannel
import com.wizardsardine.bhwi.HwiSession
import com.wizardsardine.bhwi.SerialStream
import com.wizardsardine.bhwi.TransportException
import java.io.Closeable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import uniffi.bhwi_ffi.AddressFormat
import uniffi.bhwi_ffi.HwiException
import uniffi.bhwi_ffi.HwiResponse
import uniffi.bhwi_ffi.HostPassphraseHandle
import uniffi.bhwi_ffi.MultisigAddressFormat
import uniffi.bhwi_ffi.Network
import uniffi.bhwi_ffi.WalletPolicy
import uniffi.bhwi_ffi.WalletRegistration
import uniffi.bhwi_ffi.buildSinglesigDescriptor

private const val BHWI_UNAVAILABLE = "BHWI_UNAVAILABLE"
private const val BHWI_BUSY = "BHWI_BUSY"
private const val BHWI_INVALID_INPUT = "BHWI_INVALID_INPUT"
private const val BHWI_PERMISSION_DENIED = "BHWI_PERMISSION_DENIED"
private const val BHWI_USER_REFUSED = "BHWI_USER_REFUSED"
private const val BHWI_AUTH_REFUSED = "BHWI_AUTH_REFUSED"
private const val BHWI_CANCELLED = "BHWI_CANCELLED"
private const val BHWI_DISCONNECTED = "BHWI_DISCONNECTED"
private const val BHWI_TIMEOUT = "BHWI_TIMEOUT"
private const val BHWI_UNSUPPORTED = "BHWI_UNSUPPORTED"
private const val BHWI_DEVICE_ERROR = "BHWI_DEVICE_ERROR"
private const val BHWI_INTERNAL = "BHWI_INTERNAL"
private const val CONFIRMATION_TIMEOUT_MS = 300_000L
private const val TRANSITION_RESUME_GRACE_MS = 1_000L
private val FINGERPRINT_PATTERN = Regex("^[0-9a-fA-F]{8}$")

internal enum class PassphraseMode { STANDARD, HOST, ON_DEVICE }

internal fun passphraseModes(family: BhwiFamily, info: HwiResponse.Info): List<PassphraseMode> {
    val modes = mutableListOf(PassphraseMode.STANDARD)
    if (info.needsPassphraseSent == true) modes += PassphraseMode.HOST
    if (family == BhwiFamily.TREZOR && info.onDevicePassphraseEntry == true) modes += PassphraseMode.ON_DEVICE
    return modes
}

internal interface BhwiSessionApi {
    suspend fun unlock(network: Network): HwiResponse
    suspend fun getInfo(): HwiResponse.Info
    suspend fun fingerprint(): String
    suspend fun xpub(path: String): String
    suspend fun register(name: String, descriptor: String): WalletRegistration
    suspend fun displaySinglesig(path: String, format: AddressFormat): String
    suspend fun displayDescriptor(index: UInt, change: Boolean, policy: WalletPolicy): String
    suspend fun displayMultisig(threshold: UByte, format: MultisigAddressFormat, keys: List<String>): String
    suspend fun signPsbt(psbt: String, policy: WalletPolicy?): String
    suspend fun signMessage(path: String, message: String): String
    fun supportsHostPin(info: HwiResponse.Info): Boolean
    suspend fun promptPin(): Boolean
    suspend fun sendPin(positions: String): Boolean
    fun configurePassphrase(mode: PassphraseMode, text: String? = null)
    fun disconnect()
}

private class RealBhwiSession(private val session: HwiSession) : BhwiSessionApi {
    override suspend fun unlock(network: Network) = session.unlock(network)
    override suspend fun getInfo() = session.getInfo()
    override suspend fun fingerprint() = session.getMasterFingerprint()
    override suspend fun xpub(path: String) = session.getExtendedPubkey(path, false)
    override suspend fun register(name: String, descriptor: String) = session.registerWallet(name, descriptor)
    override suspend fun displaySinglesig(path: String, format: AddressFormat) = session.displayAddress(path, true, format)
    override suspend fun displayDescriptor(index: UInt, change: Boolean, policy: WalletPolicy) =
        session.displayDescriptorAddress(index, change, true, policy)
    override suspend fun displayMultisig(threshold: UByte, format: MultisigAddressFormat, keys: List<String>) =
        session.displayMultisigAddress(threshold, true, format, keys)
    override suspend fun signPsbt(psbt: String, policy: WalletPolicy?) = session.signPsbt(psbt, policy)
    override suspend fun signMessage(path: String, message: String) = session.signMessage(message.toByteArray(Charsets.UTF_8), path)
    override fun supportsHostPin(info: HwiResponse.Info) = session.supportsHostPin(info)
    override suspend fun promptPin() = session.promptPin()
    override suspend fun sendPin(positions: String) = session.sendPin(positions)
    override fun configurePassphrase(mode: PassphraseMode, text: String?) {
        when (mode) {
            PassphraseMode.STANDARD -> session.configurePassphrase(null, false)
            PassphraseMode.ON_DEVICE -> session.configurePassphrase(null, true)
            PassphraseMode.HOST -> {
                val handle = HostPassphraseHandle(text ?: throw BhwiFailure(BHWI_INVALID_INPUT))
                var adopted = false
                try {
                    handle.validate()
                    session.configurePassphrase(handle, false)
                    adopted = true
                } finally {
                    if (!adopted) {
                        runCatching { handle.clear() }
                        runCatching { handle.close() }
                    }
                }
            }
        }
    }
    override fun disconnect() = session.disconnect()
}

internal interface BhwiFfiFactory {
    fun ledgerUsb(channel: HidChannel): BhwiSessionApi
    fun ledgerBle(channel: com.wizardsardine.bhwi.BleChannel): BhwiSessionApi
    fun coldcardUsb(channel: HidChannel): BhwiSessionApi
    fun bitboxUsb(channel: HidChannel, network: Network, onPairingCode: (String) -> Unit): BhwiSessionApi
    fun jadeUsb(stream: SerialStream, network: Network): BhwiSessionApi
    fun jadeBle(stream: SerialStream, network: Network): BhwiSessionApi
    fun trezorUsb(channel: HidChannel, network: Network): BhwiSessionApi
    fun keepkeyUsb(channel: HidChannel, network: Network): BhwiSessionApi
    fun specterUsb(stream: SerialStream, network: Network): BhwiSessionApi
    fun singlesigDescriptor(xpub: String, fingerprint: String, path: String, format: AddressFormat, network: Network): String
}

private object RealBhwiFfiFactory : BhwiFfiFactory {
    override fun ledgerUsb(channel: HidChannel) = RealBhwiSession(HwiSession.ledgerUsb(channel))
    override fun ledgerBle(channel: com.wizardsardine.bhwi.BleChannel) = RealBhwiSession(HwiSession.ledgerBle(channel))
    override fun coldcardUsb(channel: HidChannel) = RealBhwiSession(HwiSession.coldcardUsb(channel))
    override fun bitboxUsb(channel: HidChannel, network: Network, onPairingCode: (String) -> Unit) =
        RealBhwiSession(HwiSession.bitboxUsb(channel, network, onPairingCode, noiseConfig = null))
    override fun jadeUsb(stream: SerialStream, network: Network) =
        RealBhwiSession(HwiSession.jadeUsb(stream, BhwiPinServerHttp(), network))
    override fun jadeBle(stream: SerialStream, network: Network) =
        RealBhwiSession(HwiSession.jadeBle(stream, BhwiPinServerHttp(), network))
    override fun trezorUsb(channel: HidChannel, network: Network) = RealBhwiSession(HwiSession.trezorUsb(channel, network))
    override fun keepkeyUsb(channel: HidChannel, network: Network) = RealBhwiSession(HwiSession.keepkeyUsb(channel, network))
    override fun specterUsb(stream: SerialStream, network: Network) = RealBhwiSession(HwiSession.specterUsb(stream, network))
    override fun singlesigDescriptor(xpub: String, fingerprint: String, path: String, format: AddressFormat, network: Network) =
        buildSinglesigDescriptor(xpub, fingerprint, path, format, network)
}

internal class BhwiFailure(val code: String) : RuntimeException()

internal fun bhwiErrorCode(error: Throwable): String = when (error) {
    is BhwiFailure -> error.code
    is HwiException.UserRefused -> BHWI_USER_REFUSED
    is HwiException.AuthRefused -> BHWI_AUTH_REFUSED
    is HwiException.InvalidInput -> BHWI_INVALID_INPUT
    is HwiException.BadState -> BHWI_DISCONNECTED
    is HwiException.Device -> BHWI_DEVICE_ERROR
    is HwiException.Internal -> BHWI_INTERNAL
    is TransportException.Timeout, is TimeoutCancellationException -> BHWI_TIMEOUT
    is TransportException.Cancelled, is CancellationException -> BHWI_CANCELLED
    is TransportException.Disconnected -> BHWI_DISCONNECTED
    is PinServerPolicyException -> BHWI_UNSUPPORTED
    is TransportException.Io -> BHWI_DEVICE_ERROR
    is SecurityException -> BHWI_PERMISSION_DENIED
    is IllegalArgumentException -> BHWI_INVALID_INPUT
    else -> BHWI_INTERNAL
}

internal fun bhwiNetwork(profile: String): Network = when (profile) {
    "bitcoin" -> Network.BITCOIN
    "testnet" -> Network.TESTNET
    else -> throw IllegalStateException("Invalid immutable Bitcoin network profile")
}

internal fun supportsBhwiFormat(family: BhwiFamily, format: String, model: String? = null): Boolean = when (family) {
    BhwiFamily.LEDGER -> true
    BhwiFamily.BITBOX02 -> when (format) {
        "nested-segwit", "native-segwit", "multisig-wrapped", "multisig-native" -> true
        else -> false
    }
    BhwiFamily.JADE -> when (format) {
        "legacy", "nested-segwit", "native-segwit", "multisig-wrapped", "multisig-native" -> true
        else -> false
    }
    BhwiFamily.COLDCARD -> format != "taproot"
    BhwiFamily.KEEPKEY -> format != "taproot"
    BhwiFamily.TREZOR -> format != "taproot" || model == "T"
    BhwiFamily.SPECTER -> format != "taproot"
}

internal fun supportsDescriptorDisplay(family: BhwiFamily, descriptor: String): Boolean {
    val policy = descriptor.trim().substringBefore('#')
    if (family == BhwiFamily.LEDGER) return true
    if (family == BhwiFamily.SPECTER) return !policy.startsWith("tr(")
    if (family != BhwiFamily.BITBOX02 && family != BhwiFamily.JADE) return false
    if (policy.startsWith("tr(")) return false
    if (policy.startsWith("sh(multi(") || policy.startsWith("sh(sortedmulti(")) return false
    if (family == BhwiFamily.BITBOX02 && policy.startsWith("pkh(")) return false
    return true
}

internal fun supportsRegistration(family: BhwiFamily): Boolean =
    family != BhwiFamily.TREZOR && family != BhwiFamily.KEEPKEY

internal fun supportsRawMultisigDisplay(family: BhwiFamily): Boolean = family != BhwiFamily.SPECTER

internal suspend fun runHostPinFlow(
    promptPin: suspend () -> Boolean,
    readPositions: () -> String,
    sendPin: suspend (String) -> Boolean,
) {
    if (!promptPin()) throw BhwiFailure(BHWI_AUTH_REFUSED)
    val positions = readPositions()
    if (positions.isEmpty() || positions.any { it !in '1'..'9' }) throw BhwiFailure(BHWI_INVALID_INPUT)
    if (!sendPin(positions)) throw BhwiFailure(BHWI_AUTH_REFUSED)
}

internal class PinPositionBuffer(private val maximumLength: Int = 9) {
    private val positions = StringBuilder()
    val size: Int get() = positions.length
    val isEmpty: Boolean get() = positions.isEmpty()

    fun add(position: Int): Boolean {
        if (position !in 1..9 || positions.length >= maximumLength) return false
        positions.append(('0'.code + position).toChar())
        return true
    }

    fun backspace() {
        if (positions.isNotEmpty()) positions.setLength(positions.length - 1)
    }

    fun take(): String {
        val value = positions.toString()
        clear()
        return value
    }

    fun clear() {
        positions.setLength(0)
    }
}

internal fun closeBhwiResources(resources: List<Closeable>) {
    resources.asReversed().forEach { runCatching { it.close() } }
}

internal interface OwnerPrompt {
    fun cancel()
}

internal data class BhwiOwner(
    val id: String,
    val candidates: LinkedHashMap<String, BhwiCandidate> = linkedMapOf(),
    val resources: MutableList<Closeable> = mutableListOf(),
    var operation: Job? = null,
    var session: BhwiSessionApi? = null,
    var family: BhwiFamily? = null,
    var fingerprint: String? = null,
    var model: String? = null,
    var prompt: OwnerPrompt? = null,
    var closing: Boolean = false,
    var dropped: Boolean = false,
)

internal fun adoptBhwiSessionState(
    state: BhwiOwner?,
    ownerId: String,
    family: BhwiFamily,
    session: BhwiSessionApi,
): BhwiSessionApi {
    try {
        if (state?.id != ownerId || state.closing || state.dropped) throw BhwiFailure(BHWI_CANCELLED)
        if (state.session != null) throw BhwiFailure(BHWI_BUSY)
        state.session = session
        state.family = family
        return session
    } catch (error: Throwable) {
        runCatching { session.disconnect() }
        throw error
    }
}

internal class PairingPrompt(
    private val owner: String,
    private val ownerCheck: (String) -> Boolean,
    private val deadlineNanos: Long = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(CONFIRMATION_TIMEOUT_MS),
    private val nanoTime: () -> Long = System::nanoTime,
) : OwnerPrompt {
    private val settled = AtomicBoolean(false)
    private val latch = CountDownLatch(1)
    @Volatile private var accepted = false
    @Volatile private var dialog: AlertDialog? = null

    fun show(activity: Activity, title: String, message: String, positiveLabel: String) {
        UiThreadUtil.runOnUiThread {
            if (settled.get() || !ownerCheck(owner) || activity.isFinishing || activity.isDestroyed) {
                cancel()
                return@runOnUiThread
            }
            val current = AlertDialog.Builder(activity)
                .setTitle(title)
                .setMessage(message)
                .setCancelable(false)
                .setPositiveButton(positiveLabel) { _, _ -> complete(true) }
                .setNegativeButton(android.R.string.cancel) { _, _ -> complete(false) }
                .create()
            if (settled.get() || !ownerCheck(owner)) {
                current.dismiss()
                return@runOnUiThread
            }
            current.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            dialog = current
            current.show()
        }
    }

    fun await() {
        val remaining = deadlineNanos - nanoTime()
        if (remaining <= 0 || !latch.await(remaining, TimeUnit.NANOSECONDS)) {
            cancel()
            throw BhwiFailure(BHWI_TIMEOUT)
        }
        if (!ownerCheck(owner)) throw BhwiFailure(BHWI_CANCELLED)
        if (!accepted) throw BhwiFailure(BHWI_USER_REFUSED)
    }

    override fun cancel() {
        complete(false)
    }

    private fun complete(value: Boolean) {
        if (!settled.compareAndSet(false, true)) return
        accepted = value
        val current = dialog
        dialog = null
        if (current != null) UiThreadUtil.runOnUiThread { current.dismiss() }
        latch.countDown()
    }
}

internal class BlockingValuePrompt<T : Any>(
    private val owner: String,
    private val ownerCheck: (String) -> Boolean,
    private val deadlineNanos: Long,
    private val nanoTime: () -> Long = System::nanoTime,
) : OwnerPrompt {
    private val settled = AtomicBoolean(false)
    private val latch = CountDownLatch(1)
    @Volatile private var value: T? = null
    @Volatile private var failureCode: String? = null
    @Volatile private var dialog: AlertDialog? = null

    fun show(
        activity: Activity,
        build: (complete: (T) -> Unit, refuse: () -> Unit) -> AlertDialog,
    ) {
        UiThreadUtil.runOnUiThread {
            if (settled.get() || !ownerCheck(owner) || activity.isFinishing || activity.isDestroyed) {
                cancel()
                return@runOnUiThread
            }
            val current = build(::complete) { fail(BHWI_USER_REFUSED) }
            if (settled.get() || !ownerCheck(owner)) {
                current.dismiss()
                return@runOnUiThread
            }
            current.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            dialog = current
            current.show()
        }
    }

    fun await(): T {
        val remaining = deadlineNanos - nanoTime()
        if (remaining <= 0 || !latch.await(remaining, TimeUnit.NANOSECONDS)) fail(BHWI_TIMEOUT)
        if (!ownerCheck(owner)) {
            value = null
            cancel()
            throw BhwiFailure(BHWI_CANCELLED)
        }
        failureCode?.let { throw BhwiFailure(it) }
        val answer = value ?: throw BhwiFailure(BHWI_INTERNAL)
        value = null
        return answer
    }

    override fun cancel() {
        fail(BHWI_CANCELLED)
    }

    private fun complete(answer: T) {
        if (!settled.compareAndSet(false, true)) return
        value = answer
        finish()
    }

    private fun fail(code: String) {
        if (!settled.compareAndSet(false, true)) return
        failureCode = code
        finish()
    }

    private fun finish() {
        val current = dialog
        dialog = null
        if (current != null) UiThreadUtil.runOnUiThread { current.dismiss() }
        latch.countDown()
    }
}

internal fun ownsBhwiState(state: BhwiOwner?, ownerId: String, invalidated: Boolean): Boolean =
    !invalidated && state?.id == ownerId && !state.closing && !state.dropped

@ReactModule(name = BhwiModule.NAME)
class BhwiModule internal constructor(
    context: ReactApplicationContext,
    private val ffi: BhwiFfiFactory,
) : NativeBhwiSpec(context), LifecycleEventListener {
    constructor(context: ReactApplicationContext) : this(context, RealBhwiFfiFactory)

    private val lock = Any()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val platformTransitions = AtomicInteger()
    private val application = context.applicationContext as Application
    @Volatile private var owner: BhwiOwner? = null
    @Volatile private var invalidated = false
    @Volatile private var hostResumed = context.lifecycleState == LifecycleState.RESUMED
    @Volatile private var resumedActivity: Activity? = if (hostResumed) context.currentActivity else null
    @Volatile private var transitionActivity: Activity? = null
    private val network = bhwiNetwork(BuildConfig.BITCOIN_NETWORK)
    private val activityCallbacks = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
        override fun onActivityStarted(activity: Activity) = Unit
        override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit

        override fun onActivityResumed(activity: Activity) {
            if (activity === reactApplicationContext.currentActivity || activity === transitionActivity) {
                resumedActivity = activity
                hostResumed = true
            }
        }

        override fun onActivityPaused(activity: Activity) {
            if (activity === resumedActivity) {
                hostResumed = false
                if (platformTransitions.get() == 0) owner?.id?.let(::forceDisconnect)
            }
        }

        override fun onActivityStopped(activity: Activity) {
            if (activity === resumedActivity || activity === transitionActivity) {
                hostResumed = false
                owner?.id?.let(::forceDisconnect)
            }
        }

        override fun onActivityDestroyed(activity: Activity) {
            if (activity === resumedActivity || activity === transitionActivity) {
                hostResumed = false
                owner?.id?.let(::forceDisconnect)
            }
        }
    }

    init {
        context.addLifecycleEventListener(this)
        application.registerActivityLifecycleCallbacks(activityCallbacks)
    }

    override fun getName() = NAME

    override fun discover(sessionId: String, transport: String, promise: Promise) {
        if (transport != "usb" && transport != "ble") {
            reject(promise, BhwiFailure(BHWI_INVALID_INPUT))
            return
        }
        launchOwned(sessionId, promise, claim = true) { state ->
            val candidates: List<BhwiCandidate> = if (transport == "usb") {
                val discovered = BhwiUsb.discover(reactApplicationContext)
                val selectedSerial = discovered.serialAdapters.mapNotNull { adapter ->
                    if (confirmSerialFamily(state.id, adapter)) {
                        UsbBhwiCandidate(adapter.device, adapter.proposedFamily, serial = true)
                    } else {
                        null
                    }
                }
                discovered.wallets + selectedSerial
            } else {
                requireBlePermissions()
                checkOwner(state.id)
                if (!BhwiBle.enabled(reactApplicationContext)) throw BhwiFailure(BHWI_UNAVAILABLE)
                BhwiBle.discover(reactApplicationContext) { owns(state.id) }
            }
            checkOwner(state.id)
            synchronized(lock) {
                requireOwnerLocked(state.id)
                state.candidates.entries.removeAll { it.value.transport == transport }
                candidates.forEach { state.candidates[it.id] = it }
            }
            deviceArray(candidates)
        }
    }

    override fun connect(sessionId: String, deviceId: String, promise: Promise) {
        launchOwned(sessionId, promise) { state ->
            val candidate = synchronized(lock) { requireOwnerLocked(state.id).candidates[deviceId] }
                ?: throw BhwiFailure(BHWI_INVALID_INPUT)
            if (state.session != null || state.dropped) throw BhwiFailure(BHWI_BUSY)
            val deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(CONFIRMATION_TIMEOUT_MS)
            try {
                withTimeout(CONFIRMATION_TIMEOUT_MS) {
                    val session = when (candidate) {
                        is UsbBhwiCandidate -> openUsb(state, candidate, deadlineNanos)
                        is BleBhwiCandidate -> openBle(state, candidate)
                    }
                    val unlock = deviceCall(state.id) { session.unlock(network) }
                    val info = if (candidate.family == BhwiFamily.SPECTER) {
                        null
                    } else {
                        (unlock as? HwiResponse.Info) ?: deviceCall(state.id) { session.getInfo() }
                    }
                    if (candidate.family == BhwiFamily.TREZOR || candidate.family == BhwiFamily.KEEPKEY) {
                        configureTrezorAccess(state.id, candidate.family, session, requireNotNull(info), deadlineNanos)
                    }
                    val fingerprint = (unlock as? HwiResponse.Fingerprint)?.hex
                        ?: deviceCall(state.id) { session.fingerprint() }
                    checkOwner(state.id)
                    synchronized(lock) {
                        val current = requireOwnerLocked(state.id)
                        current.fingerprint = fingerprint.lowercase()
                        current.model = info?.firmware
                    }
                    deviceInfo(candidate.family, fingerprint.lowercase(), info?.version, info?.firmware)
                }
            } catch (error: Throwable) {
                retireTransport(state.id)
                throw error
            }
        }
    }

    override fun getAccount(sessionId: String, path: String, format: String, promise: Promise) {
        launchOwned(sessionId, promise) { state ->
            val accountFormat = parseAccountFormat(format)
            val session = connectedSession(state.id)
            val family = requireNotNull(state.family)
            val fingerprint = requireNotNull(state.fingerprint)
            requireAccountFormat(family, accountFormat, state.model)
            val xpub = deviceCall(state.id) { session.xpub(path) }
            val descriptor = accountFormat.singlesig?.let {
                checkOwner(state.id)
                ffi.singlesigDescriptor(xpub, fingerprint, path, it, network).also { checkOwner(state.id) }
            }
            Arguments.createMap().apply {
                putString("family", family.wireName)
                putString("fingerprint", fingerprint)
                putString("path", path)
                putString("xpub", xpub)
                putString("format", accountFormat.wireName)
                putString("descriptor", descriptor)
            }
        }
    }

    override fun registerWallet(sessionId: String, name: String, descriptor: String, promise: Promise) {
        launchOwned(sessionId, promise) { state ->
            val family = connectedFamily(state.id)
            if (!supportsRegistration(family)) throw BhwiFailure(BHWI_UNSUPPORTED)
            when (val registration = deviceCall(state.id) { connectedSession(state.id).register(name, descriptor) }) {
                is WalletRegistration.Complete -> Arguments.createMap().apply {
                    putString("status", "complete")
                    putString("hmacHex", registration.hmac?.toHex())
                }
                WalletRegistration.PendingUserConfirmation -> Arguments.createMap().apply {
                    putString("status", "pending")
                    putNull("hmacHex")
                }
            }
        }
    }

    override fun displaySinglesigAddress(sessionId: String, path: String, format: String, promise: Promise) {
        launchOwned(sessionId, promise) { state ->
            val accountFormat = parseAccountFormat(format)
            requireAccountFormat(connectedFamily(state.id), accountFormat, connectedModel(state.id))
            val parsed = accountFormat.singlesig ?: throw BhwiFailure(BHWI_INVALID_INPUT)
            deviceCall(state.id) { connectedSession(state.id).displaySinglesig(path, parsed) }
        }
    }

    override fun displayDescriptorAddress(sessionId: String, policy: ReadableMap, change: Boolean, index: Double, promise: Promise) {
        launchOwned(sessionId, promise) { state ->
            if (index < 0 || index > Int.MAX_VALUE || index % 1.0 != 0.0) throw BhwiFailure(BHWI_INVALID_INPUT)
            val parsed = parsePolicy(policy)
            requireDescriptorDisplay(connectedFamily(state.id), parsed.descriptor)
            deviceCall(state.id) { connectedSession(state.id).displayDescriptor(index.toInt().toUInt(), change, parsed) }
        }
    }

    override fun displayMultisigAddress(
        sessionId: String,
        threshold: Double,
        format: String,
        keys: ReadableArray,
        promise: Promise,
    ) {
        launchOwned(sessionId, promise) { state ->
            if (!supportsRawMultisigDisplay(connectedFamily(state.id))) throw BhwiFailure(BHWI_UNSUPPORTED)
            if (threshold < 1 || threshold > 255 || threshold % 1.0 != 0.0) throw BhwiFailure(BHWI_INVALID_INPUT)
            val parsedKeys = (0 until keys.size()).map {
                if (keys.getType(it) != ReadableType.String) throw BhwiFailure(BHWI_INVALID_INPUT)
                keys.getString(it) ?: throw BhwiFailure(BHWI_INVALID_INPUT)
            }
            if (parsedKeys.isEmpty() || parsedKeys.size > 15 || threshold.toInt() > parsedKeys.size) {
                throw BhwiFailure(BHWI_INVALID_INPUT)
            }
            val accountFormat = parseAccountFormat(format)
            requireAccountFormat(connectedFamily(state.id), accountFormat, connectedModel(state.id))
            val multisig = accountFormat.multisig ?: throw BhwiFailure(BHWI_INVALID_INPUT)
            deviceCall(state.id) {
                connectedSession(state.id).displayMultisig(threshold.toInt().toUByte(), multisig, parsedKeys)
            }
        }
    }

    override fun signPsbt(sessionId: String, psbtBase64: String, policy: ReadableMap?, promise: Promise) {
        launchOwned(sessionId, promise) { state ->
            deviceCall(state.id) { connectedSession(state.id).signPsbt(psbtBase64, policy?.let(::parsePolicy)) }
        }
    }

    override fun signMessage(sessionId: String, path: String, message: String, promise: Promise) {
        launchOwned(sessionId, promise) { state ->
            deviceCall(state.id) { connectedSession(state.id).signMessage(path, message) }
        }
    }

    override fun disconnect(sessionId: String, promise: Promise) {
        if (!validOwnerId(sessionId)) {
            reject(promise, BhwiFailure(BHWI_INVALID_INPUT))
            return
        }
        var admissionError: BhwiFailure? = null
        val state = synchronized(lock) {
            val current = owner
            when {
                current == null -> null
                current.id != sessionId -> {
                    admissionError = BhwiFailure(BHWI_BUSY)
                    null
                }
                current.closing -> {
                    admissionError = BhwiFailure(BHWI_BUSY)
                    null
                }
                else -> current.apply { closing = true }
            }
        }
        admissionError?.let {
            reject(promise, it)
            return
        }
        if (state == null) {
            promise.resolve(null)
            return
        }
        val running = state.operation
        state.prompt?.cancel()
        running?.cancel(CancellationException("owned disconnect"))
        closeBhwiResources(state.resources)
        scope.launch {
            try {
                running?.join()
                runCatching { state.session?.disconnect() }
                closeBhwiResources(state.resources)
                synchronized(lock) {
                    if (owner === state) owner = null
                }
                promise.resolve(null)
            } catch (error: Throwable) {
                reject(promise, error)
            }
        }
    }

    private fun <T> launchOwned(sessionId: String, promise: Promise, claim: Boolean = false, block: suspend (BhwiOwner) -> T) {
        if (invalidated || !hostResumed || !validOwnerId(sessionId)) {
            val code = if (invalidated || !hostResumed) BHWI_UNAVAILABLE else BHWI_INVALID_INPUT
            reject(promise, BhwiFailure(code))
            return
        }
        lateinit var state: BhwiOwner
        lateinit var job: Job
        try {
            synchronized(lock) {
                val current = owner
                state = when {
                    current == null && claim -> BhwiOwner(sessionId).also { owner = it }
                    current == null -> throw BhwiFailure(BHWI_DISCONNECTED)
                    current.id != sessionId -> throw BhwiFailure(BHWI_BUSY)
                    current.closing || current.dropped -> throw BhwiFailure(BHWI_DISCONNECTED)
                    else -> current
                }
                if (state.operation != null) throw BhwiFailure(BHWI_BUSY)
                job = scope.launch(start = kotlinx.coroutines.CoroutineStart.LAZY) {
                    try {
                        checkOwner(state.id)
                        val result = block(state)
                        synchronized(lock) {
                            if (invalidated) throw BhwiFailure(BHWI_CANCELLED)
                            requireOwnerLocked(state.id)
                            promise.resolve(result)
                        }
                    } catch (error: Throwable) {
                        reject(promise, error)
                    } finally {
                        synchronized(lock) {
                            if (owner === state && state.operation === coroutineContext[Job]) state.operation = null
                        }
                    }
                }
                state.operation = job
            }
            job.start()
        } catch (error: Throwable) {
            reject(promise, error)
        }
    }

    private suspend fun openUsb(state: BhwiOwner, candidate: UsbBhwiCandidate, deadlineNanos: Long): BhwiSessionApi {
        val manager = BhwiUsb.manager(reactApplicationContext)
        val device = BhwiUsb.currentDevice(manager, candidate) ?: throw TransportException.Disconnected()
        val granted = withPlatformTransition(state.id) {
            BhwiUsb.requestPermission(reactApplicationContext, manager, state.id, device) { owns(state.id) }
        }
        if (!granted) throw BhwiFailure(BHWI_PERMISSION_DENIED)
        checkOwner(state.id)
        val connection = manager.openDevice(device) ?: throw TransportException.Io("USB device could not be opened")
        adoptResource(state.id, Closeable { connection.close() })
        try {
            val session = if (candidate.serial) {
                val stream = UsbWalletSerialStream.open(
                    BhwiUsb.serialPort(manager, device),
                    connection,
                    candidate.family,
                ) { owns(state.id) }
                adoptResource(state.id, stream)
                val created = when (candidate.family) {
                    BhwiFamily.JADE -> ffi.jadeUsb(stream, network)
                    BhwiFamily.SPECTER -> ffi.specterUsb(stream, network)
                    else -> throw BhwiFailure(BHWI_UNSUPPORTED)
                }
                adoptSession(state.id, candidate.family, created)
            } else {
                val iface = BhwiUsb.selectHidInterface(connection, device, candidate.family) { owns(state.id) }
                val channel = UsbHidChannel(
                    connection,
                    iface,
                    { BhwiUsb.currentDevice(manager, candidate) != null },
                    { owns(state.id) },
                )
                adoptResource(state.id, channel)
                if (requiresStalePacketDrain(candidate.family)) {
                    channel.drainStalePackets()
                }
                val created = when (candidate.family) {
                    BhwiFamily.LEDGER -> ffi.ledgerUsb(channel)
                    BhwiFamily.COLDCARD -> ffi.coldcardUsb(channel)
                    BhwiFamily.BITBOX02 -> ffi.bitboxUsb(channel, network) { code ->
                        showPairing(state.id, code, deadlineNanos)
                    }
                    BhwiFamily.TREZOR -> ffi.trezorUsb(channel, network)
                    BhwiFamily.KEEPKEY -> ffi.keepkeyUsb(channel, network)
                    else -> throw BhwiFailure(BHWI_UNSUPPORTED)
                }
                adoptSession(state.id, candidate.family, created)
            }
            adoptResource(
                state.id,
                BhwiUsb.watchDetach(reactApplicationContext, device) { deviceDropped(state.id) },
            )
            return session
        } catch (error: Throwable) {
            runCatching { connection.close() }
            throw error
        }
    }

    private suspend fun openBle(state: BhwiOwner, candidate: BleBhwiCandidate): BhwiSessionApi {
        if (candidate.family != BhwiFamily.JADE && candidate.family != BhwiFamily.LEDGER) {
            throw BhwiFailure(BHWI_UNSUPPORTED)
        }
        requireBlePermissions()
        checkOwner(state.id)
        val link = GattLink.connect(
            reactApplicationContext,
            candidate,
            isOwner = { owns(state.id) },
            onCreated = { adoptResource(state.id, it) },
        )
        link.onDisconnected = { deviceDropped(state.id) }
        val session = if (candidate.family == BhwiFamily.JADE) {
            val stream = JadeBleStream(link)
            adoptResource(state.id, stream)
            ffi.jadeBle(stream, network)
        } else {
            val channel = LedgerBleChannel(link)
            adoptResource(state.id, channel)
            ffi.ledgerBle(channel)
        }
        return adoptSession(state.id, candidate.family, session)
    }

    private fun requireBlePermissions() {
        if (BhwiBle.requiredPermissions().any {
                ContextCompat.checkSelfPermission(reactApplicationContext, it) != PackageManager.PERMISSION_GRANTED
            }
        ) {
            throw BhwiFailure(BHWI_PERMISSION_DENIED)
        }
    }

    private suspend fun <T> withPlatformTransition(ownerId: String, block: suspend () -> T): T {
        checkOwner(ownerId)
        val activity = foregroundActivity() ?: throw BhwiFailure(BHWI_UNAVAILABLE)
        transitionActivity = activity
        platformTransitions.incrementAndGet()
        try {
            val result = block()
            checkOwner(ownerId)
            val resumed = withTimeoutOrNull(TRANSITION_RESUME_GRACE_MS) {
                while (owns(ownerId) && (!hostResumed || resumedActivity !== activity)) delay(25)
                hostResumed && resumedActivity === activity
            } == true
            if (!resumed) {
                forceDisconnect(ownerId)
                throw BhwiFailure(BHWI_CANCELLED)
            }
            checkOwner(ownerId)
            return result
        } finally {
            val remaining = platformTransitions.decrementAndGet()
            if (remaining == 0 && (!hostResumed || resumedActivity !== activity)) forceDisconnect(ownerId)
            if (transitionActivity === activity) transitionActivity = null
        }
    }

    private fun foregroundActivity(): Activity? {
        if (!hostResumed) return null
        return reactApplicationContext.currentActivity?.takeUnless { it.isFinishing || it.isDestroyed }
    }

    private fun confirmSerialFamily(ownerId: String, adapter: UnclassifiedUsbSerialCandidate): Boolean {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(CONFIRMATION_TIMEOUT_MS)
        val family = adapter.proposedFamily.displayName
        return try {
            awaitConfirmation(
                ownerId,
                deadline,
                "Use adapter for $family?",
                "Treat ${adapter.name} as a $family hardware wallet. Its identity will be verified before use.",
                "Use as $family",
            )
            true
        } catch (error: BhwiFailure) {
            if (error.code == BHWI_USER_REFUSED) false else throw error
        }
    }

    private fun showPairing(ownerId: String, code: String, deadlineNanos: Long) {
        awaitConfirmation(ownerId, deadlineNanos, "Verify BitBox02 pairing", code, "Codes match")
    }

    private fun awaitConfirmation(
        ownerId: String,
        deadlineNanos: Long,
        title: String,
        message: String,
        positiveLabel: String,
    ) {
        checkOwner(ownerId)
        val activity = foregroundActivity() ?: throw BhwiFailure(BHWI_UNAVAILABLE)
        val prompt = PairingPrompt(ownerId, ::owns, deadlineNanos)
        synchronized(lock) {
            val state = requireOwnerLocked(ownerId)
            if (state.prompt != null) throw BhwiFailure(BHWI_BUSY)
            state.prompt = prompt
        }
        try {
            prompt.show(activity, title, message, positiveLabel)
            prompt.await()
            checkOwner(ownerId)
            if (!hostResumed || resumedActivity !== activity || foregroundActivity() !== activity) {
                throw BhwiFailure(BHWI_CANCELLED)
            }
        } finally {
            prompt.cancel()
            synchronized(lock) {
                val state = owner
                if (state?.id == ownerId && state.prompt === prompt) state.prompt = null
            }
        }
    }

    private suspend fun configureTrezorAccess(
        ownerId: String,
        family: BhwiFamily,
        session: BhwiSessionApi,
        info: HwiResponse.Info,
        deadlineNanos: Long,
    ) {
        if (family == BhwiFamily.TREZOR && info.firmware != null && info.firmware != "1" && info.firmware != "T") {
            throw BhwiFailure(BHWI_UNSUPPORTED)
        }
        if (info.initialized == false) throw BhwiFailure(BHWI_UNSUPPORTED)
        checkOwner(ownerId)
        val supportsHostPin = session.supportsHostPin(info)
        val modes = passphraseModes(family, info)
        val mode = promptPassphraseMode(ownerId, modes, deadlineNanos)
        val passphrase = if (mode == PassphraseMode.HOST) promptHostPassphrase(ownerId, deadlineNanos) else null
        checkOwner(ownerId)
        session.configurePassphrase(mode, passphrase)
        checkOwner(ownerId)

        if (info.needsPinSent == true && supportsHostPin) {
            runHostPinFlow(
                promptPin = { deviceCall(ownerId) { session.promptPin() } },
                readPositions = { promptPinPositions(ownerId, deadlineNanos) },
                sendPin = { positions -> deviceCall(ownerId) { session.sendPin(positions) } },
            )
        }
    }

    private fun promptPassphraseMode(
        ownerId: String,
        modes: List<PassphraseMode>,
        deadlineNanos: Long,
    ): PassphraseMode = awaitValuePrompt(ownerId, deadlineNanos) { activity, complete, refuse ->
        val labels = modes.map {
            when (it) {
                PassphraseMode.STANDARD -> "Standard wallet (no passphrase)"
                PassphraseMode.HOST -> "Enter passphrase on this phone"
                PassphraseMode.ON_DEVICE -> "Enter passphrase on device"
            }
        }.toTypedArray()
        AlertDialog.Builder(activity)
            .setTitle("Choose wallet")
            .setItems(labels) { dialog, which ->
                complete(modes[which])
                dialog.dismiss()
            }
            .setNegativeButton(android.R.string.cancel) { _, _ -> refuse() }
            .setCancelable(false)
            .create()
    }

    private fun promptHostPassphrase(ownerId: String, deadlineNanos: Long): String =
        awaitValuePrompt(ownerId, deadlineNanos) { activity, complete, refuse ->
            val input = EditText(activity).apply {
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                transformationMethod = PasswordTransformationMethod.getInstance()
                isSingleLine = true
            }
            AlertDialog.Builder(activity)
                .setTitle("Enter wallet passphrase")
                .setView(input)
                .setPositiveButton("Continue") { _, _ ->
                    val answer = input.text.toString()
                    input.text.clear()
                    complete(answer)
                }
                .setNegativeButton(android.R.string.cancel) { _, _ -> refuse() }
                .setCancelable(false)
                .create()
                .also { dialog -> dialog.setOnDismissListener { input.text.clear() } }
        }

    private fun promptPinPositions(ownerId: String, deadlineNanos: Long): String =
        awaitValuePrompt(ownerId, deadlineNanos) { activity, complete, refuse ->
            val positions = PinPositionBuffer()
            val count = TextView(activity).apply { text = "No positions entered" }
            val grid = GridLayout(activity).apply { columnCount = 3 }
            repeat(9) { index ->
                grid.addView(Button(activity).apply {
                    text = ""
                    contentDescription = "PIN position ${index + 1}"
                    setOnClickListener {
                        positions.add(index + 1)
                        count.text = "${positions.size} positions entered"
                    }
                })
            }
            val backspace = Button(activity).apply {
                text = "Backspace"
                setOnClickListener {
                    positions.backspace()
                    count.text = if (positions.isEmpty) "No positions entered" else "${positions.size} positions entered"
                }
            }
            val layout = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                addView(TextView(activity).apply { text = "Enter the positions shown on your hardware wallet." })
                addView(grid)
                addView(count)
                addView(backspace)
            }
            AlertDialog.Builder(activity)
                .setTitle("Enter PIN positions")
                .setView(layout)
                .setPositiveButton("Continue", null)
                .setNegativeButton(android.R.string.cancel) { _, _ ->
                    positions.clear()
                    refuse()
                }
                .setCancelable(false)
                .create()
                .also { dialog ->
                    dialog.setOnDismissListener { positions.clear() }
                    dialog.setOnShowListener {
                        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                            if (positions.isEmpty) return@setOnClickListener
                            val answer = positions.take()
                            complete(answer)
                            dialog.dismiss()
                        }
                    }
                }
        }

    private fun <T : Any> awaitValuePrompt(
        ownerId: String,
        deadlineNanos: Long,
        build: (
            activity: Activity,
            complete: (T) -> Unit,
            refuse: () -> Unit,
        ) -> AlertDialog,
    ): T {
        checkOwner(ownerId)
        val activity = foregroundActivity() ?: throw BhwiFailure(BHWI_UNAVAILABLE)
        val prompt = BlockingValuePrompt<T>(ownerId, ::owns, deadlineNanos)
        synchronized(lock) {
            val state = requireOwnerLocked(ownerId)
            if (state.prompt != null) throw BhwiFailure(BHWI_BUSY)
            state.prompt = prompt
        }
        try {
            prompt.show(activity) { complete, refuse -> build(activity, complete, refuse) }
            val answer = prompt.await()
            checkOwner(ownerId)
            if (!hostResumed || resumedActivity !== activity || foregroundActivity() !== activity) {
                throw BhwiFailure(BHWI_CANCELLED)
            }
            return answer
        } finally {
            prompt.cancel()
            synchronized(lock) {
                val state = owner
                if (state?.id == ownerId && state.prompt === prompt) state.prompt = null
            }
        }
    }

    private suspend fun <T> deviceCall(ownerId: String, block: suspend () -> T): T {
        checkOwner(ownerId)
        return try {
            withTimeout(CONFIRMATION_TIMEOUT_MS) {
                block().also { checkOwner(ownerId) }
            }
        } catch (error: TimeoutCancellationException) {
            retireTransport(ownerId)
            throw TransportException.Timeout()
        } catch (error: TransportException) {
            retireTransport(ownerId)
            throw error
        } catch (error: PinServerPolicyException) {
            retireTransport(ownerId)
            throw error
        }
    }

    private fun connectedSession(ownerId: String): BhwiSessionApi = synchronized(lock) {
        val state = requireOwnerLocked(ownerId)
        if (state.dropped) throw BhwiFailure(BHWI_DISCONNECTED)
        state.session ?: throw BhwiFailure(BHWI_DISCONNECTED)
    }

    private fun connectedFamily(ownerId: String): BhwiFamily = synchronized(lock) {
        requireOwnerLocked(ownerId).family ?: throw BhwiFailure(BHWI_DISCONNECTED)
    }

    private fun connectedModel(ownerId: String): String? = synchronized(lock) {
        requireOwnerLocked(ownerId).model
    }

    private fun adoptSession(ownerId: String, family: BhwiFamily, session: BhwiSessionApi): BhwiSessionApi =
        synchronized(lock) { adoptBhwiSessionState(owner, ownerId, family, session) }

    private fun adoptResource(ownerId: String, resource: Closeable) {
        try {
            synchronized(lock) { requireOwnerLocked(ownerId).resources += resource }
        } catch (error: Throwable) {
            resource.close()
            throw error
        }
    }

    private fun retireTransport(ownerId: String) {
        val state = synchronized(lock) {
            val current = owner
            if (current?.id != ownerId || current.dropped) return
            current.dropped = true
            current.prompt?.cancel()
            current
        }
        closeBhwiResources(state.resources)
        runCatching { state.session?.disconnect() }
    }

    private fun deviceDropped(ownerId: String) {
        val state = synchronized(lock) {
            val current = owner
            if (current?.id != ownerId || current.dropped) return
            current.dropped = true
            current.prompt?.cancel()
            current
        }
        val running = state.operation
        running?.cancel(CancellationException("device dropped"))
        closeBhwiResources(state.resources)
        scope.launch {
            running?.join()
            runCatching { state.session?.disconnect() }
        }
    }

    private fun checkOwner(ownerId: String) {
        if (!owns(ownerId)) throw BhwiFailure(BHWI_CANCELLED)
    }

    private fun owns(ownerId: String): Boolean = ownsBhwiState(owner, ownerId, invalidated)

    private fun requireOwnerLocked(ownerId: String): BhwiOwner {
        val state = owner
        if (state?.id != ownerId || state.closing || state.dropped) throw BhwiFailure(BHWI_CANCELLED)
        return state
    }

    private fun forceDisconnect(ownerId: String) {
        val state = synchronized(lock) {
            val current = owner
            if (current?.id != ownerId || current.closing) return
            current.closing = true
            current
        }
        state.prompt?.cancel()
        state.operation?.cancel(CancellationException("owner abandoned"))
        closeBhwiResources(state.resources)
        scope.launch {
            state.operation?.join()
            runCatching { state.session?.disconnect() }
            closeBhwiResources(state.resources)
            synchronized(lock) { if (owner === state) owner = null }
        }
    }

    override fun onHostResume() {
        val activity = reactApplicationContext.currentActivity
        resumedActivity = activity
        hostResumed = activity != null && !activity.isFinishing && !activity.isDestroyed
    }

    override fun onHostPause() {
        hostResumed = false
        if (platformTransitions.get() == 0) owner?.id?.let(::forceDisconnect)
    }

    override fun onHostDestroy() {
        hostResumed = false
        owner?.id?.let(::forceDisconnect)
    }

    override fun invalidate() {
        invalidated = true
        reactApplicationContext.removeLifecycleEventListener(this)
        application.unregisterActivityLifecycleCallbacks(activityCallbacks)
        val current = owner
        current?.id?.let(::forceDisconnect)
        if (current?.operation == null) {
            runCatching { current?.session?.disconnect() }
        } else {
            current.operation?.invokeOnCompletion {
                runCatching { current.session?.disconnect() }
                closeBhwiResources(current.resources)
            }
        }
        scope.cancel()
        super.invalidate()
    }

    private fun parsePolicy(policy: ReadableMap): WalletPolicy {
        val name = policy.requiredString("name")
        val descriptor = policy.requiredString("descriptor")
        val hmac = if (!policy.hasKey("ledgerHmacHex") || policy.isNull("ledgerHmacHex")) null else {
            if (policy.getType("ledgerHmacHex") != ReadableType.String) throw BhwiFailure(BHWI_INVALID_INPUT)
            val value = policy.getString("ledgerHmacHex") ?: throw BhwiFailure(BHWI_INVALID_INPUT)
            if (value.length != 64 || value.any { it.digitToIntOrNull(16) == null }) throw BhwiFailure(BHWI_INVALID_INPUT)
            ByteArray(32) { index ->
                ((value[index * 2].digitToInt(16) shl 4) or value[index * 2 + 1].digitToInt(16)).toByte()
            }
        }
        return WalletPolicy(name, descriptor, hmac)
    }

    private fun ReadableMap.requiredString(key: String): String {
        if (!hasKey(key) || isNull(key) || getType(key) != ReadableType.String) {
            throw BhwiFailure(BHWI_INVALID_INPUT)
        }
        return getString(key) ?: throw BhwiFailure(BHWI_INVALID_INPUT)
    }

    private fun requireAccountFormat(family: BhwiFamily, format: AccountFormat, model: String? = null) {
        if (!supportsBhwiFormat(family, format.wireName, model)) throw BhwiFailure(BHWI_UNSUPPORTED)
    }

    private fun requireDescriptorDisplay(family: BhwiFamily, descriptor: String) {
        if (!supportsDescriptorDisplay(family, descriptor)) throw BhwiFailure(BHWI_UNSUPPORTED)
    }

    private data class AccountFormat(
        val wireName: String,
        val singlesig: AddressFormat? = null,
        val multisig: MultisigAddressFormat? = null,
    )

    private fun parseAccountFormat(value: String): AccountFormat = when (value) {
        "legacy" -> AccountFormat(value, singlesig = AddressFormat.LEGACY)
        "nested-segwit" -> AccountFormat(value, singlesig = AddressFormat.NESTED_SEGWIT)
        "native-segwit" -> AccountFormat(value, singlesig = AddressFormat.NATIVE_SEGWIT)
        "taproot" -> AccountFormat(value, singlesig = AddressFormat.TAPROOT)
        "multisig-legacy" -> AccountFormat(value, multisig = MultisigAddressFormat.LEGACY)
        "multisig-wrapped" -> AccountFormat(value, multisig = MultisigAddressFormat.SH_WIT)
        "multisig-native" -> AccountFormat(value, multisig = MultisigAddressFormat.WIT)
        else -> throw BhwiFailure(BHWI_INVALID_INPUT)
    }

    private fun deviceArray(devices: List<BhwiCandidate>): WritableArray = Arguments.createArray().apply {
        devices.forEach { device ->
            pushMap(Arguments.createMap().apply {
                putString("id", device.id)
                putString("name", device.name)
                putString("family", device.family.wireName)
                putString("transport", device.transport)
            })
        }
    }

    private fun deviceInfo(
        family: BhwiFamily,
        fingerprint: String,
        version: String?,
        model: String?,
    ): WritableMap = Arguments.createMap().apply {
        putString("family", family.wireName)
        putString("fingerprint", fingerprint)
        putString("version", version)
        putString("model", model)
    }

    private fun reject(promise: Promise, error: Throwable) {
        val code = bhwiErrorCode(error)
        promise.reject(code, SAFE_MESSAGES.getValue(code))
    }



    companion object {
        const val NAME = "Bhwi"
        private val OWNER_PATTERN = Regex("^[0-9a-f]{32}$")


        private val SAFE_MESSAGES = mapOf(
            BHWI_UNAVAILABLE to "Hardware wallets are unavailable.",
            BHWI_BUSY to "Another hardware wallet operation is active.",
            BHWI_INVALID_INPUT to "Invalid hardware wallet request.",
            BHWI_PERMISSION_DENIED to "Hardware wallet permission was denied.",
            BHWI_USER_REFUSED to "The hardware wallet request was refused.",
            BHWI_AUTH_REFUSED to "Hardware wallet authentication was refused.",
            BHWI_CANCELLED to "The hardware wallet request was cancelled.",
            BHWI_DISCONNECTED to "The hardware wallet disconnected.",
            BHWI_TIMEOUT to "The hardware wallet request timed out.",
            BHWI_UNSUPPORTED to "The hardware wallet operation is unsupported.",
            BHWI_DEVICE_ERROR to "The hardware wallet reported an error.",
            BHWI_INTERNAL to "The hardware wallet operation failed.",
        )

        private fun validOwnerId(value: String): Boolean = OWNER_PATTERN.matches(value)
    }
}

private fun ByteArray.toHex(): String {
    val alphabet = "0123456789abcdef"
    val output = CharArray(size * 2)
    forEachIndexed { index, byte ->
        val value = byte.toInt() and 0xff
        output[index * 2] = alphabet[value ushr 4]
        output[index * 2 + 1] = alphabet[value and 0x0f]
    }
    return output.concatToString()
}
