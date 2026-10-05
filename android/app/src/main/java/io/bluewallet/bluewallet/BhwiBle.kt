package io.bluewallet.bluewallet

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import androidx.core.content.getSystemService
import com.wizardsardine.bhwi.BleChannel
import com.wizardsardine.bhwi.SerialStream
import com.wizardsardine.bhwi.TransportException
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout

internal data class BleBhwiCandidate(
    val device: BluetoothDevice,
    override val family: BhwiFamily,
    override val name: String,
) : BhwiCandidate {
    override val id = "ble:${device.address}"
    override val transport = "ble"
}

internal object JadeUuids {
    val SERVICE: UUID = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
    val WRITE: UUID = UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e")
    val NOTIFY: UUID = UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e")
}

internal object LedgerUuids {
    val SERVICES = listOf(
        UUID.fromString("13d63400-2c97-0004-0000-4c6564676572"),
        UUID.fromString("13d63400-2c97-0006-0000-4c6564676572"),
        UUID.fromString("13d63400-2c97-0007-0000-4c6564676572"),
    )
    val NOTIFY: UUID = UUID.fromString("13d63400-2c97-0001-0000-4c6564676572")
    val WRITE: UUID = UUID.fromString("13d63400-2c97-0002-0000-4c6564676572")
}

@SuppressLint("MissingPermission")
internal object BhwiBle {
    fun requiredPermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    fun enabled(context: Context): Boolean = context.getSystemService<BluetoothManager>()?.adapter?.isEnabled == true

    suspend fun discover(context: Context, isOwner: () -> Boolean): List<BleBhwiCandidate> =
        suspendCancellableCoroutine { continuation ->
            if (!isOwner()) {
                continuation.resumeWithException(TransportException.Cancelled())
                return@suspendCancellableCoroutine
            }
            val scanner = context.getSystemService<BluetoothManager>()?.adapter?.bluetoothLeScanner
            if (scanner == null) {
                continuation.resumeWithException(TransportException.Io("Bluetooth is unavailable"))
                return@suspendCancellableCoroutine
            }
            val found = linkedMapOf<String, BleBhwiCandidate>()
            val stopped = AtomicBoolean(false)
            val handler = Handler(Looper.getMainLooper())
            lateinit var callback: ScanCallback
            fun stop() {
                if (stopped.compareAndSet(false, true)) {
                    handler.removeCallbacksAndMessages(callback)
                    runCatching { scanner.stopScan(callback) }
                }
            }
            callback = object : ScanCallback() {
                override fun onScanResult(callbackType: Int, result: ScanResult) {
                    if (!isOwner()) return
                    classify(result)?.let { found.putIfAbsent(it.id, it) }
                }

                override fun onBatchScanResults(results: MutableList<ScanResult>) {
                    results.forEach { onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, it) }
                }

                override fun onScanFailed(errorCode: Int) {
                    stop()
                    if (continuation.isActive) continuation.resumeWithException(TransportException.Io("BLE scan failed"))
                }
            }
            continuation.invokeOnCancellation { stop() }
            try {
                scanner.startScan(
                    null,
                    ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
                    callback,
                )
                handler.postAtTime({
                    stop()
                    if (!continuation.isActive) return@postAtTime
                    if (!isOwner()) continuation.resumeWithException(TransportException.Cancelled())
                    else continuation.resume(found.values.toList())
                }, callback, android.os.SystemClock.uptimeMillis() + SCAN_TIMEOUT_MS)
            } catch (error: Throwable) {
                stop()
                if (continuation.isActive) continuation.resumeWithException(TransportException.Io("BLE scan could not start"))
            }
        }

    private fun classify(result: ScanResult): BleBhwiCandidate? {
        val services = result.scanRecord?.serviceUuids.orEmpty()
        val name = result.scanRecord?.deviceName ?: result.device.name ?: return null
        return when {
            services.any { it.isLedgerService() } -> BleBhwiCandidate(result.device, BhwiFamily.LEDGER, name)
            services.any { it.uuid == JadeUuids.SERVICE } || name.startsWith("Jade", true) ->
                BleBhwiCandidate(result.device, BhwiFamily.JADE, name)
            else -> null
        }
    }

    private fun ParcelUuid.isLedgerService(): Boolean = uuid in LedgerUuids.SERVICES

    private const val SCAN_TIMEOUT_MS = 15_000L
}

internal interface BleLink : Closeable {
    val payloadSize: Int
    suspend fun write(data: ByteArray)
    suspend fun receive(): BlePacket
}

internal class BlePacket(
    val bytes: ByteArray,
    private val onRelease: (Int) -> Unit,
) : Closeable {
    private val released = AtomicBoolean(false)
    override fun close() {
        if (released.compareAndSet(false, true)) onRelease(bytes.size)
    }
}

internal class BleByteBudget(private val maximum: Long = 4L * 1024 * 1024) {
    private val retained = AtomicLong()

    fun reserve(bytes: Int): Boolean {
        while (true) {
            val current = retained.get()
            val next = current + bytes
            if (bytes < 0 || next > maximum) return false
            if (retained.compareAndSet(current, next)) return true
        }
    }

    fun release(bytes: Int) {
        retained.addAndGet(-bytes.toLong())
    }

    fun size(): Long = retained.get()
}

internal enum class GattPhase { CONNECTING, MTU, SERVICES, SUBSCRIBING, READY, CLOSED }

internal class GattSetupState {
    private val phase = AtomicReference(GattPhase.CONNECTING)

    fun expects(expected: GattPhase): Boolean = phase.get() == expected
    fun move(expected: GattPhase, next: GattPhase): Boolean = phase.compareAndSet(expected, next)
    fun close() {
        phase.set(GattPhase.CLOSED)
    }
}

internal fun resolvedGattMtu(success: Boolean, mtu: Int): Int = if (success) mtu else 23
internal fun attPayloadSize(mtu: Int): Int = (mtu - 3).coerceAtLeast(20)


@SuppressLint("MissingPermission")
internal class GattLink private constructor(
    private val serviceUuids: List<UUID>,
    private val writeUuid: UUID,
    private val notifyUuid: UUID,
    private val isOwner: () -> Boolean,
) : BleLink {
    private val setup = GattSetupState()
    private val closed = AtomicBoolean(false)
    private val byteBudget = BleByteBudget()
    private val writeLock = Mutex()
    private val notifications = Channel<BlePacket>(Channel.UNLIMITED)
    private val connected = CompletableDeferred<Unit>()
    private val mtuDone = CompletableDeferred<Int>()
    private val servicesDone = CompletableDeferred<Unit>()
    private val descriptorDone = CompletableDeferred<Unit>()
    @Volatile private var writeDone: CompletableDeferred<Unit>? = null
    private val gattLock = Any()
    @Volatile private var gatt: BluetoothGatt? = null
    @Volatile private lateinit var writeCharacteristic: BluetoothGattCharacteristic
    @Volatile private var expectedDescriptor: BluetoothGattDescriptor? = null
    @Volatile override var payloadSize = attPayloadSize(DEFAULT_MTU)
        private set
    @Volatile var onDisconnected: (() -> Unit)? = null

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (!accept(g)) return
            if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED && setup.expects(GattPhase.CONNECTING)) {
                connected.complete(Unit)
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                fail(TransportException.Disconnected(), notifyDrop = true)
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            if (!accept(g) || !setup.expects(GattPhase.MTU)) return
            mtuDone.complete(resolvedGattMtu(status == BluetoothGatt.GATT_SUCCESS, mtu))
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (!accept(g) || !setup.expects(GattPhase.SERVICES)) return
            if (status == BluetoothGatt.GATT_SUCCESS) servicesDone.complete(Unit)
            else servicesDone.completeExceptionally(TransportException.Io("BLE service discovery failed"))
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            if (!accept(g) || !setup.expects(GattPhase.SUBSCRIBING) || descriptor !== expectedDescriptor) return
            if (status == BluetoothGatt.GATT_SUCCESS) descriptorDone.complete(Unit)
            else descriptorDone.completeExceptionally(TransportException.Io("BLE notification setup failed"))
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            if (!accept(g) || !setup.expects(GattPhase.READY) || characteristic !== writeCharacteristic) return
            val pending = takeWrite() ?: return
            if (status == BluetoothGatt.GATT_SUCCESS) pending.complete(Unit)
            else pending.completeExceptionally(TransportException.Io("BLE write failed"))
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            if (accept(g) && setup.expects(GattPhase.READY) && characteristic.uuid == notifyUuid) enqueue(value.copyOf())
        }

        @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
            if (accept(g) && setup.expects(GattPhase.READY) && characteristic.uuid == notifyUuid) {
                characteristic.value?.let { enqueue(it.copyOf()) }
            }
        }
    }

    private fun accept(callbackGatt: BluetoothGatt): Boolean {
        val accepted = synchronized(gattLock) {
            if (closed.get() || !isOwner()) {
                false
            } else {
                val active = gatt
                if (active == null) {
                    gatt = callbackGatt
                    true
                } else {
                    active === callbackGatt
                }
            }
        }
        if (!accepted) closeGatt(callbackGatt)
        return accepted
    }

    private fun bindReturnedGatt(connection: BluetoothGatt) {
        if (!accept(connection)) throw TransportException.Disconnected()
    }

    private fun closeGatt(connection: BluetoothGatt) {
        runCatching { connection.disconnect() }
        runCatching { connection.close() }
    }

    private fun enqueue(bytes: ByteArray) {
        if (!byteBudget.reserve(bytes.size)) {
            fail(TransportException.Io("BLE notification queue exceeded its limit"), notifyDrop = true)
            return
        }
        val packet = BlePacket(bytes) { size -> byteBudget.release(size) }
        if (notifications.trySend(packet).isFailure) packet.close()
    }

    override suspend fun receive(): BlePacket {
        ensureOwner()
        val packet = try {
            notifications.receive()
        } catch (error: CancellationException) {
            throw error
        } catch (error: TransportException) {
            throw error
        } catch (error: Throwable) {
            throw TransportException.Disconnected()
        }
        try {
            ensureOwner()
            return packet
        } catch (error: Throwable) {
            packet.close()
            throw error
        }
    }

    override suspend fun write(data: ByteArray) = writeLock.withLock {
        ensureOwner()
        if (data.size > payloadSize) throw TransportException.Io("BLE write exceeds negotiated payload size")
        val connection = gatt ?: throw TransportException.Disconnected()
        val pending = CompletableDeferred<Unit>()
        synchronized(this) {
            if (writeDone != null) throw TransportException.Io("BLE write already pending")
            writeDone = pending
        }
        val queued = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            connection.writeCharacteristic(
                writeCharacteristic,
                data,
                BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT,
            ) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            run {
                writeCharacteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                writeCharacteristic.value = data
                connection.writeCharacteristic(writeCharacteristic)
            }
        }
        if (!queued) {
            clearWrite(pending)
            fail(TransportException.Io("BLE write was rejected"), notifyDrop = false)
            throw TransportException.Io("BLE write was rejected")
        }
        try {
            withTimeout(WRITE_TIMEOUT_MS) { pending.await() }
            ensureOwner()
        } catch (error: Throwable) {
            clearWrite(pending)
            fail(
                if (error is TimeoutCancellationException) TransportException.Timeout() else TransportException.Cancelled(),
                notifyDrop = false,
            )
            if (error is TimeoutCancellationException) throw TransportException.Timeout()
            throw error
        }
    }

    @Synchronized
    private fun takeWrite(): CompletableDeferred<Unit>? = writeDone.also { writeDone = null }

    @Synchronized
    private fun clearWrite(expected: CompletableDeferred<Unit>) {
        if (writeDone === expected) writeDone = null
    }

    private fun ensureOwner() {
        if (closed.get()) throw TransportException.Disconnected()
        if (!isOwner()) throw TransportException.Cancelled()
    }

    private fun fail(error: TransportException, notifyDrop: Boolean) {
        if (!closed.compareAndSet(false, true)) return
        setup.close()
        connected.completeExceptionally(error)
        mtuDone.completeExceptionally(error)
        servicesDone.completeExceptionally(error)
        descriptorDone.completeExceptionally(error)
        takeWrite()?.completeExceptionally(error)
        notifications.close(error)
        while (true) {
            val packet = notifications.tryReceive().getOrNull() ?: break
            packet.close()
        }
        val connection = synchronized(gattLock) {
            val active = gatt
            gatt = null
            active
        }
        connection?.let(::closeGatt)
        if (notifyDrop) onDisconnected?.invoke()
    }

    override fun close() {
        fail(TransportException.Disconnected(), notifyDrop = false)
    }

    private suspend fun setUp(connection: BluetoothGatt) {
        withTimeout(CONNECT_TIMEOUT_MS) { connected.await() }
        ensureOwner()
        if (!setup.move(GattPhase.CONNECTING, GattPhase.MTU)) throw TransportException.Disconnected()
        if (!connection.requestMtu(REQUESTED_MTU)) mtuDone.complete(DEFAULT_MTU)
        payloadSize = attPayloadSize(withTimeout(SETUP_TIMEOUT_MS) { mtuDone.await() })
        ensureOwner()
        if (!setup.move(GattPhase.MTU, GattPhase.SERVICES)) throw TransportException.Disconnected()
        if (!connection.discoverServices()) throw TransportException.Io("BLE service discovery was rejected")
        withTimeout(DISCOVERY_TIMEOUT_MS) { servicesDone.await() }
        ensureOwner()
        if (!setup.move(GattPhase.SERVICES, GattPhase.SUBSCRIBING)) throw TransportException.Disconnected()
        subscribe(connection)
        ensureOwner()
        if (!setup.move(GattPhase.SUBSCRIBING, GattPhase.READY)) throw TransportException.Disconnected()
    }

    private suspend fun subscribe(connection: BluetoothGatt) {
        val service = serviceUuids.firstNotNullOfOrNull(connection::getService)
            ?: throw TransportException.Io("required BLE service is absent")
        writeCharacteristic = service.getCharacteristic(writeUuid)
            ?: throw TransportException.Io("required BLE write characteristic is absent")
        val notify = service.getCharacteristic(notifyUuid)
            ?: throw TransportException.Io("required BLE notification characteristic is absent")
        if (!connection.setCharacteristicNotification(notify, true)) {
            throw TransportException.Io("BLE notifications could not be enabled")
        }
        val descriptor = notify.getDescriptor(CCCD)
            ?: throw TransportException.Io("required BLE notification descriptor is absent")
        expectedDescriptor = descriptor
        val value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        val queued = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            connection.writeDescriptor(descriptor, value) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            run {
                descriptor.value = value
                connection.writeDescriptor(descriptor)
            }
        }
        if (!queued) throw TransportException.Io("BLE notification descriptor write was rejected")
        withTimeout(SETUP_TIMEOUT_MS) { descriptorDone.await() }
    }

    companion object {
        suspend fun connect(
            context: Context,
            candidate: BleBhwiCandidate,
            isOwner: () -> Boolean,
            onCreated: (GattLink) -> Unit = {},
        ): GattLink {
            val jade = candidate.family == BhwiFamily.JADE
            val link = GattLink(
                if (jade) listOf(JadeUuids.SERVICE) else LedgerUuids.SERVICES,
                if (jade) JadeUuids.WRITE else LedgerUuids.WRITE,
                if (jade) JadeUuids.NOTIFY else LedgerUuids.NOTIFY,
                isOwner,
            )
            if (!isOwner()) throw TransportException.Cancelled()
            val connection = candidate.device.connectGatt(context, false, link.callback, BluetoothDevice.TRANSPORT_LE)
                ?: throw TransportException.Io("BLE connection could not be created")
            try {
                link.bindReturnedGatt(connection)
                onCreated(link)
                link.setUp(connection)
                return link
            } catch (error: Throwable) {
                link.close()
                link.closeGatt(connection)
                throw error
            }
        }

        private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private const val DEFAULT_MTU = 23
        private const val REQUESTED_MTU = 517
        private const val CONNECT_TIMEOUT_MS = 20_000L
        private const val DISCOVERY_TIMEOUT_MS = 15_000L
        private const val SETUP_TIMEOUT_MS = 15_000L
        private const val WRITE_TIMEOUT_MS = 10_000L
    }
}

internal class LedgerBleChannel(private val link: BleLink) : BleChannel, Closeable {
    override suspend fun write(data: ByteArray) = link.write(data)

    override suspend fun read(): ByteArray {
        val packet = link.receive()
        return packet.use { it.bytes }
    }

    override fun mtu(): UShort = link.payloadSize.coerceAtLeast(20).toUShort()
    override fun close() = link.close()
}

internal class JadeBleStream(private val link: BleLink) : SerialStream, Closeable {
    private val lock = Mutex()
    private var pending: BlePacket? = null
    private var offset = 0

    override suspend fun writeAll(data: ByteArray) {
        val chunkSize = link.payloadSize.coerceIn(20, 509)
        var start = 0
        while (start < data.size) {
            currentCoroutineContext().ensureActive()
            val end = minOf(start + chunkSize, data.size)
            link.write(data.copyOfRange(start, end))
            start = end
        }
    }

    override suspend fun read(maxLen: UInt): ByteArray = lock.withLock {
        while (pending == null || offset >= requireNotNull(pending).bytes.size) {
            pending?.close()
            pending = link.receive()
            offset = 0
            if (requireNotNull(pending).bytes.isEmpty()) {
                pending?.close()
                pending = null
            }
        }
        val packet = requireNotNull(pending)
        val count = minOf(maxLen.toInt().coerceAtLeast(1), packet.bytes.size - offset)
        val result = packet.bytes.copyOfRange(offset, offset + count)
        offset += count
        if (offset >= packet.bytes.size) {
            packet.close()
            pending = null
        }
        result
    }

    override fun close() {
        pending?.close()
        pending = null
        link.close()
    }
}
