package io.bluewallet.bluewallet

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.content.getSystemService
import com.hoho.android.usbserial.driver.SerialTimeoutException
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.wizardsardine.bhwi.HidChannel
import com.wizardsardine.bhwi.SerialStream
import com.wizardsardine.bhwi.TransportException
import java.io.Closeable
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

internal enum class BhwiFamily(val wireName: String, val displayName: String) {
    BITBOX02("bitbox02", "BitBox02"),
    COLDCARD("coldcard", "Coldcard"),
    JADE("jade", "Jade"),
    LEDGER("ledger", "Ledger"),
    KEEPKEY("keepkey", "KeepKey"),
    SPECTER("specter", "Specter"),
    TREZOR("trezor", "Trezor"),
}

internal sealed interface BhwiCandidate {
    val id: String
    val name: String
    val family: BhwiFamily
    val transport: String
}

internal data class UsbBhwiCandidate(
    val device: UsbDevice,
    override val family: BhwiFamily,
    val serial: Boolean,
) : BhwiCandidate {
    override val id = "usb:${device.deviceName}"
    override val name = device.productName?.takeIf(String::isNotBlank) ?: family.displayName
    override val transport = "usb"
}

internal data class UnclassifiedUsbSerialCandidate(
    val device: UsbDevice,
    val proposedFamily: BhwiFamily,
) {
    val name = device.productName?.takeIf(String::isNotBlank) ?: "USB serial adapter"
}

internal data class UsbDiscoveryResult(
    val wallets: List<UsbBhwiCandidate>,
    val serialAdapters: List<UnclassifiedUsbSerialCandidate>,
)

private val jadeSerialIds = setOf(
    0x10c4 to 0xea60,
    0x1a86 to 0x55d4,
    0x0403 to 0x6001,
    0x1a86 to 0x7523,
    0x303a to 0x4001,
    0x303a to 0x1001,
)

internal data class UsbIdentity(
    val deviceName: String,
    val deviceId: Int,
    val vendorId: Int,
    val productId: Int,
)

internal fun UsbIdentity.matches(other: UsbIdentity): Boolean =
    deviceName == other.deviceName &&
        deviceId == other.deviceId &&
        vendorId == other.vendorId &&
        productId == other.productId

internal data class UsbEndpointIdentity(val address: Int, val type: Int, val maxPacketSize: Int)

internal fun hasExactTrezorEndpoints(endpoints: List<UsbEndpointIdentity>): Boolean =
    endpoints.size == 2 &&
        endpoints.any {
            it.address == TREZOR_ENDPOINT_IN &&
                it.type == UsbConstants.USB_ENDPOINT_XFER_INT &&
                it.maxPacketSize == HID_REPORT_SIZE
        } &&
        endpoints.any {
            it.address == TREZOR_ENDPOINT_OUT &&
                it.type == UsbConstants.USB_ENDPOINT_XFER_INT &&
                it.maxPacketSize == HID_REPORT_SIZE
        }

internal fun usbHidFamily(vendorId: Int, productId: Int): BhwiFamily? = when {
    vendorId == 0x2c97 -> BhwiFamily.LEDGER
    vendorId == 0x03eb && productId == 0x2403 -> BhwiFamily.BITBOX02
    vendorId == 0xd13e && productId == 0xcc10 -> BhwiFamily.COLDCARD
    vendorId == VID_KEEPKEY && (productId == PID_KEEPKEY_HID || productId == PID_KEEPKEY_VENDOR) -> BhwiFamily.KEEPKEY
    vendorId == VID_TREZOR_OLD && productId == PID_TREZOR_OLD -> BhwiFamily.TREZOR
    vendorId == VID_TREZOR && productId == PID_TREZOR -> BhwiFamily.TREZOR
    else -> null
}

internal fun usbSerialFamily(vendorId: Int, productId: Int): BhwiFamily? = when {
    (vendorId to productId) in jadeSerialIds -> BhwiFamily.JADE
    vendorId == VID_SPECTER -> BhwiFamily.SPECTER
    else -> null
}

internal fun requiresStalePacketDrain(family: BhwiFamily): Boolean =
    family == BhwiFamily.TREZOR || family == BhwiFamily.KEEPKEY

internal object BhwiUsb {
    private val permissionSequence = AtomicInteger()

    fun manager(context: Context): UsbManager =
        context.getSystemService<UsbManager>() ?: throw TransportException.Io("USB host is unavailable")

    fun discover(context: Context): UsbDiscoveryResult {
        val manager = manager(context)
        val serial = UsbSerialProber.getDefaultProber().findAllDrivers(manager)
            .asSequence()
            .filter { it.ports.isNotEmpty() }
            .mapNotNull { driver ->
                usbSerialFamily(driver.device.vendorId, driver.device.productId)
                    ?.let { UnclassifiedUsbSerialCandidate(driver.device, it) }
            }
            .toList()
        val wallets = manager.deviceList.values.mapNotNull { device ->
            usbHidFamily(device.vendorId, device.productId)?.let { UsbBhwiCandidate(device, it, false) }
        }
        return UsbDiscoveryResult(wallets, serial)
    }

    fun currentDevice(manager: UsbManager, candidate: UsbBhwiCandidate): UsbDevice? {
        val device = manager.deviceList[candidate.device.deviceName]
        if (!sameDevice(device, candidate.device)) {
            return null
        }
        if (device == null) return null
        val familyMatches = if (candidate.serial) {
            when (candidate.family) {
                BhwiFamily.JADE -> (device.vendorId to device.productId) in jadeSerialIds
                BhwiFamily.SPECTER -> device.vendorId == VID_SPECTER
                else -> false
            }
        } else {
            hidFamily(device) == candidate.family
        }
        return device.takeIf { familyMatches }
    }

    suspend fun requestPermission(
        context: Context,
        manager: UsbManager,
        owner: String,
        device: UsbDevice,
        isOwner: () -> Boolean,
    ): Boolean {
        if (!isOwner()) throw TransportException.Cancelled()
        if (manager.hasPermission(device)) return true
        val app = context.applicationContext
        val request = permissionSequence.incrementAndGet()
        val action = "${app.packageName}.BHWI_USB_PERMISSION.$request"
        return withTimeout(PERMISSION_TIMEOUT_MS) {
            suspendCancellableCoroutine { continuation ->
                val removed = AtomicBoolean(false)
                lateinit var receiver: BroadcastReceiver
                fun unregister() {
                    if (removed.compareAndSet(false, true)) runCatching { app.unregisterReceiver(receiver) }
                }
                receiver = object : BroadcastReceiver() {
                    override fun onReceive(context: Context?, intent: Intent?) {
                        if (intent?.action != action || intent.getStringExtra("owner") != owner) return
                        val returned = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
                        } else {
                            @Suppress("DEPRECATION")
                            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
                        }
                        if (!sameDevice(returned, device)) {
                            return
                        }
                        unregister()
                        if (continuation.isActive) {
                            continuation.resume(
                                isOwner() &&
                                    intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false) &&
                                    manager.hasPermission(device),
                            )
                        }
                    }
                }
                ContextCompat.registerReceiver(
                    app,
                    receiver,
                    IntentFilter(action),
                    ContextCompat.RECEIVER_NOT_EXPORTED,
                )
                continuation.invokeOnCancellation {
                    unregister()
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    PendingIntent.FLAG_MUTABLE
                } else {
                    0
                }
                try {
                    val intent = Intent(action).setPackage(app.packageName).putExtra("owner", owner)
                    manager.requestPermission(device, PendingIntent.getBroadcast(app, request, intent, flags))
                } catch (error: Throwable) {
                    unregister()
                    if (continuation.isActive) continuation.resume(false)
                }
            }
        }.also {
            if (!isOwner()) throw TransportException.Cancelled()
        }
    }

    fun selectHidInterface(
        connection: UsbDeviceConnection,
        device: UsbDevice,
        family: BhwiFamily,
        isOwner: () -> Boolean,
    ): UsbInterface {
        if (family == BhwiFamily.TREZOR || family == BhwiFamily.KEEPKEY) {
            return selectTrezorInterface(connection, device, family, isOwner)
        }
        val matches = (0 until device.interfaceCount).map { device.getInterface(it) }.filter { iface ->
            if (iface.interfaceClass != UsbConstants.USB_CLASS_HID || interruptEndpoints(iface) == null) return@filter false
            if (!isOwner()) throw TransportException.Cancelled()
            val pages = readUsagePages(connection, iface)
            if (!isOwner()) throw TransportException.Cancelled()
            when (family) {
                BhwiFamily.LEDGER -> LEDGER_USAGE_PAGE in pages
                BhwiFamily.BITBOX02 -> BITBOX_USAGE_PAGE in pages
                BhwiFamily.COLDCARD -> pages.any { it >= VENDOR_USAGE_MIN && it != FIDO_USAGE_PAGE }
                else -> false
            }
        }
        if (matches.size != 1) throw TransportException.Io("expected hardware wallet HID interface was not found")
        return matches.single()
    }

    private fun selectTrezorInterface(
        connection: UsbDeviceConnection,
        device: UsbDevice,
        family: BhwiFamily,
        isOwner: () -> Boolean,
    ): UsbInterface {
        if (device.interfaceCount == 0 || !isOwner()) throw TransportException.Disconnected()
        val iface = device.getInterface(0)
        if (iface.id != 0 || !hasTrezorEndpoints(iface)) {
            throw TransportException.Io("expected wallet packet interface was not found")
        }
        val hidVariant = when (family) {
            BhwiFamily.KEEPKEY ->
                device.vendorId == VID_KEEPKEY && device.productId == PID_KEEPKEY_HID
            BhwiFamily.TREZOR ->
                device.vendorId == VID_TREZOR_OLD && device.productId == PID_TREZOR_OLD
            else -> false
        }
        val vendorVariant = when (family) {
            BhwiFamily.KEEPKEY ->
                device.vendorId == VID_KEEPKEY && device.productId == PID_KEEPKEY_VENDOR
            BhwiFamily.TREZOR ->
                device.vendorId == VID_TREZOR && device.productId == PID_TREZOR
            else -> false
        }
        if (
            (hidVariant && iface.interfaceClass != UsbConstants.USB_CLASS_HID) ||
            (vendorVariant && iface.interfaceClass != USB_CLASS_VENDOR) ||
            (!hidVariant && !vendorVariant)
        ) {
            throw TransportException.Io("expected wallet packet interface was not found")
        }
        if (hidVariant && TREZOR_USAGE_PAGE !in readUsagePages(connection, iface)) {
            throw TransportException.Io("expected wallet HID usage was not found")
        }
        if (!isOwner()) throw TransportException.Cancelled()
        return iface
    }

    private fun readUsagePages(connection: UsbDeviceConnection, iface: UsbInterface): Set<Int> {
        val descriptor = ByteArray(MAX_REPORT_DESCRIPTOR)
        val count = connection.controlTransfer(
            UsbConstants.USB_DIR_IN or UsbConstants.USB_TYPE_STANDARD or USB_RECIPIENT_INTERFACE,
            GET_DESCRIPTOR,
            REPORT_DESCRIPTOR_TYPE shl 8,
            iface.id,
            descriptor,
            descriptor.size,
            DESCRIPTOR_TIMEOUT_MS,
        )
        return if (count > 0) reportUsagePages(descriptor, count) else emptySet()
    }

    fun serialPort(manager: UsbManager, device: UsbDevice): UsbSerialPort =
        UsbSerialProber.getDefaultProber().findAllDrivers(manager)
            .firstOrNull { sameDevice(it.device, device) }
            ?.ports
            ?.firstOrNull()
            ?: throw TransportException.Io("wallet serial interface was not found")

    fun watchDetach(context: Context, device: UsbDevice, onDetach: () -> Unit): Closeable {
        val app = context.applicationContext
        val closed = AtomicBoolean(false)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action != UsbManager.ACTION_USB_DEVICE_DETACHED) return
                val detached = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
                }
                if (sameDevice(detached, device)) {
                    onDetach()
                }
            }
        }
        ContextCompat.registerReceiver(
            app,
            receiver,
            IntentFilter(UsbManager.ACTION_USB_DEVICE_DETACHED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        return Closeable {
            if (closed.compareAndSet(false, true)) runCatching { app.unregisterReceiver(receiver) }
        }
    }

    private fun hidFamily(device: UsbDevice): BhwiFamily? = usbHidFamily(device.vendorId, device.productId)
}

internal suspend fun completePartialWrite(
    totalBytes: Int,
    timeoutMillis: Int,
    nanoTime: () -> Long = System::nanoTime,
    transfer: (offset: Int, length: Int, remainingMillis: Int) -> Int,
): Int {
    val deadline = nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis.toLong())
    var written = 0
    while (written < totalBytes) {
        currentCoroutineContext().ensureActive()
        val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - nanoTime()).coerceAtLeast(0).toInt()
        if (remaining == 0) throw TransportException.Timeout()
        val count = transfer(written, totalBytes - written, remaining)
        if (count <= 0 || count > totalBytes - written) throw TransportException.Io("incomplete transport write")
        written += count
    }
    return written
}

internal interface UsbHidIo : Closeable {
    fun write(report: ByteArray, offset: Int, length: Int, timeoutMillis: Int): Int
    fun read(buffer: ByteArray, timeoutMillis: Int): Int
}

private class AndroidUsbHidIo(
    private val connection: UsbDeviceConnection,
    private val iface: UsbInterface,
) : UsbHidIo {
    private val endpoints = interruptEndpoints(iface)
        ?: throw TransportException.Io("HID interrupt endpoints were not found")
    private val input = endpoints.first
    private val output = endpoints.second

    init {
        if (!connection.claimInterface(iface, true)) throw TransportException.Io("HID interface could not be claimed")
    }

    override fun write(report: ByteArray, offset: Int, length: Int, timeoutMillis: Int): Int =
        connection.bulkTransfer(output, report, offset, length, timeoutMillis)

    override fun read(buffer: ByteArray, timeoutMillis: Int): Int =
        connection.bulkTransfer(input, buffer, buffer.size, timeoutMillis)

    override fun close() {
        runCatching { connection.releaseInterface(iface) }
        runCatching { connection.close() }
    }
}

internal class UsbHidChannel internal constructor(
    private val io: UsbHidIo,
    private val isAttached: () -> Boolean,
    private val isOwner: () -> Boolean,
) : HidChannel, Closeable {
    constructor(
        connection: UsbDeviceConnection,
        iface: UsbInterface,
        isAttached: () -> Boolean,
        isOwner: () -> Boolean,
    ) : this(AndroidUsbHidIo(connection, iface), isAttached, isOwner)

    private val closed = AtomicBoolean(false)

    override suspend fun send(report: ByteArray): UInt = withContext(Dispatchers.IO) {
        requireOpen()
        completePartialWrite(report.size, WRITE_TIMEOUT_MS) { offset, length, remaining ->
            requireOpen()
            val count = io.write(report, offset, length, remaining)
            if (count <= 0) failWrite()
            count
        }.toUInt()
    }

    override suspend fun receive(maxLen: UInt): ByteArray = withContext(Dispatchers.IO) {
        val buffer = ByteArray(maxLen.coerceAtMost(MAX_REPORT.toUInt()).toInt().coerceAtLeast(1))
        while (true) {
            currentCoroutineContext().ensureActive()
            requireOpen()
            val count = io.read(buffer, READ_POLL_MS)
            currentCoroutineContext().ensureActive()
            requireOpen()
            if (count > 0) return@withContext buffer.copyOf(count)
            if (count < 0 && !isAttached()) throw TransportException.Disconnected()
        }
        @Suppress("UNREACHABLE_CODE")
        ByteArray(0)
    }

    suspend fun drainStalePackets(
        timeoutMillis: Int = STALE_DRAIN_TIMEOUT_MS,
        pollMillis: Int = STALE_DRAIN_POLL_MS,
        nanoTime: () -> Long = System::nanoTime,
    ) = withContext(Dispatchers.IO) {
        val deadline = nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis.toLong())
        val buffer = ByteArray(HID_REPORT_SIZE)
        while (true) {
            currentCoroutineContext().ensureActive()
            requireOpen()
            val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - nanoTime()).toInt()
            if (remaining <= 0) throw TransportException.Io("wallet packet channel did not quiesce")
            val read = io.read(buffer, minOf(pollMillis, remaining))
            currentCoroutineContext().ensureActive()
            requireOpen()
            if (read <= 0) return@withContext
            if (read > buffer.size) throw TransportException.Io("wallet packet read exceeded report size")
        }
    }

    private fun requireOpen() {
        if (closed.get() || !isAttached()) throw TransportException.Disconnected()
        if (!isOwner()) throw TransportException.Cancelled()
    }

    private fun failWrite(): Nothing {
        if (!isAttached() || closed.get()) throw TransportException.Disconnected()
        throw TransportException.Io("HID write failed")
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) io.close()
    }

    private companion object {
        const val WRITE_TIMEOUT_MS = 5_000
        const val READ_POLL_MS = 250
        const val MAX_REPORT = 4_096
        const val STALE_DRAIN_POLL_MS = 50
        const val STALE_DRAIN_TIMEOUT_MS = 1_000
    }
}

internal class UsbWalletSerialStream private constructor(
    private val port: UsbSerialPort,
    private val isOwner: () -> Boolean,
) : SerialStream, Closeable {
    private val closed = AtomicBoolean(false)

    override suspend fun writeAll(data: ByteArray) = withContext(Dispatchers.IO) {
        requireOpen()
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(WRITE_TIMEOUT_MS.toLong())
        var offset = 0
        while (offset < data.size) {
            currentCoroutineContext().ensureActive()
            requireOpen()
            val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()).coerceAtLeast(0).toInt()
            if (remaining == 0) throw TransportException.Timeout()
            val chunk = if (offset == 0) data else data.copyOfRange(offset, data.size)
            try {
                port.write(chunk, remaining)
                offset = data.size
            } catch (error: SerialTimeoutException) {
                if (error.bytesTransferred !in 1..chunk.size) throw TransportException.Timeout()
                offset += error.bytesTransferred
            } catch (error: IOException) {
                failIo("serial write failed")
            }
        }
    }

    override suspend fun read(maxLen: UInt): ByteArray = withContext(Dispatchers.IO) {
        val buffer = ByteArray(maxLen.coerceAtMost(MAX_CHUNK.toUInt()).toInt().coerceAtLeast(1))
        while (true) {
            currentCoroutineContext().ensureActive()
            requireOpen()
            val count = try {
                port.read(buffer, READ_POLL_MS)
            } catch (error: IOException) {
                failIo("serial read failed")
            }
            currentCoroutineContext().ensureActive()
            requireOpen()
            if (count > 0) return@withContext buffer.copyOf(count)
        }
        @Suppress("UNREACHABLE_CODE")
        ByteArray(0)
    }

    private fun requireOpen() {
        if (closed.get() || !port.isOpen) {
            throw TransportException.Disconnected()
        }
        if (!isOwner()) throw TransportException.Cancelled()
    }

    private fun failIo(message: String): Nothing {
        if (closed.get() || !port.isOpen) throw TransportException.Disconnected()
        throw TransportException.Io(message)
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) {
            runCatching { port.close() }
        }
    }

    companion object {
        private const val BAUD = 115_200
        private const val WRITE_TIMEOUT_MS = 5_000
        private const val READ_POLL_MS = 250
        private const val MAX_CHUNK = 4_096

        fun open(
            port: UsbSerialPort,
            connection: UsbDeviceConnection,
            family: BhwiFamily,
            isOwner: () -> Boolean,
        ): UsbWalletSerialStream {
            if (family != BhwiFamily.JADE && family != BhwiFamily.SPECTER) {
                throw TransportException.Io("unsupported serial wallet family")
            }
            port.open(connection)
            try {
                port.setParameters(BAUD, UsbSerialPort.DATABITS_8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
                if (family == BhwiFamily.JADE) {
                    runCatching { port.setDTR(false) }
                    runCatching { port.setRTS(false) }
                }
            } catch (error: Throwable) {
                runCatching { port.close() }
                throw error
            }
            return UsbWalletSerialStream(port, isOwner)
        }
    }
}

private fun sameDevice(first: UsbDevice?, second: UsbDevice): Boolean =
    first?.usbIdentity()?.matches(second.usbIdentity()) == true

private fun UsbDevice.usbIdentity() = UsbIdentity(deviceName, deviceId, vendorId, productId)

private fun interruptEndpoints(iface: UsbInterface): Pair<UsbEndpoint, UsbEndpoint>? {
    val inputs = mutableListOf<UsbEndpoint>()
    val outputs = mutableListOf<UsbEndpoint>()
    for (index in 0 until iface.endpointCount) {
        val endpoint = iface.getEndpoint(index)
        if (endpoint.type != UsbConstants.USB_ENDPOINT_XFER_INT || endpoint.maxPacketSize != HID_REPORT_SIZE) continue
        if (endpoint.direction == UsbConstants.USB_DIR_IN) inputs += endpoint else outputs += endpoint
    }
    return if (inputs.size == 1 && outputs.size == 1) inputs.single() to outputs.single() else null
}

private fun hasTrezorEndpoints(iface: UsbInterface): Boolean =
    hasExactTrezorEndpoints(
        (0 until iface.endpointCount).map { index ->
            val endpoint = iface.getEndpoint(index)
            UsbEndpointIdentity(endpoint.address, endpoint.type, endpoint.maxPacketSize)
        },
    )

internal fun reportUsagePages(descriptor: ByteArray, length: Int = descriptor.size): Set<Int> {
    val pages = mutableSetOf<Int>()
    var offset = 0
    val end = length.coerceIn(0, descriptor.size)
    while (offset < end) {
        val prefix = descriptor[offset].toInt() and 0xff
        if (prefix == 0xfe) {
            if (offset + 2 >= end) break
            offset += 3 + (descriptor[offset + 1].toInt() and 0xff)
            continue
        }
        val encodedSize = prefix and 0x03
        val size = if (encodedSize == 3) 4 else encodedSize
        if (offset + 1 + size > end) break
        if (prefix and 0xfc == 0x04 && size > 0) {
            var value = 0
            for (index in 0 until size) value = value or ((descriptor[offset + 1 + index].toInt() and 0xff) shl (8 * index))
            pages += value
        }
        offset += 1 + size
    }
    return pages
}

private const val PERMISSION_TIMEOUT_MS = 60_000L
private const val MAX_REPORT_DESCRIPTOR = 4_096
private const val DESCRIPTOR_TIMEOUT_MS = 1_000
private const val GET_DESCRIPTOR = 0x06
private const val REPORT_DESCRIPTOR_TYPE = 0x22
private const val USB_RECIPIENT_INTERFACE = 0x01
private const val HID_REPORT_SIZE = 64
private const val LEDGER_USAGE_PAGE = 0xffa0
private const val BITBOX_USAGE_PAGE = 0xffff
private const val FIDO_USAGE_PAGE = 0xf1d0
private const val VENDOR_USAGE_MIN = 0xff00
private const val TREZOR_USAGE_PAGE = 0xff00
private const val USB_CLASS_VENDOR = 0xff
private const val TREZOR_ENDPOINT_OUT = 0x01
private const val TREZOR_ENDPOINT_IN = 0x81
private const val VID_KEEPKEY = 0x2b24
private const val PID_KEEPKEY_HID = 0x0001
private const val PID_KEEPKEY_VENDOR = 0x0002
private const val VID_TREZOR_OLD = 0x534c
private const val PID_TREZOR_OLD = 0x0001
private const val VID_TREZOR = 0x1209
private const val PID_TREZOR = 0x53c1
private const val VID_SPECTER = 0xf055
