package io.bluewallet.bluewallet

import android.hardware.usb.UsbConstants
import com.wizardsardine.bhwi.JadeSerialLink
import com.wizardsardine.bhwi.HidChannel
import com.wizardsardine.bhwi.HwiSession
import com.wizardsardine.bhwi.SpecterSerialLink
import com.wizardsardine.bhwi.TrezorV1Link
import com.wizardsardine.bhwi.SerialStream
import com.wizardsardine.bhwi.TransportException
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.bhwi_ffi.AddressFormat
import uniffi.bhwi_ffi.HwiException
import uniffi.bhwi_ffi.HwiResponse
import uniffi.bhwi_ffi.MultisigAddressFormat
import uniffi.bhwi_ffi.HostPassphraseHandle
import uniffi.bhwi_ffi.SpecterFrameDecoder
import uniffi.bhwi_ffi.Network
import uniffi.bhwi_ffi.WalletPolicy
import uniffi.bhwi_ffi.WalletRegistration

class BhwiTransportTest {
    @Test
    fun permissionIdentityAndHidUsageSelectionAreExact() {
        val expected = UsbIdentity("/dev/bus/usb/001/002", 2, 0x2c97, 1)
        assertTrue(expected.matches(expected.copy()))
        assertFalse(expected.matches(expected.copy(deviceId = 3)))
        assertFalse(expected.matches(expected.copy(productId = 2)))

        assertEquals(setOf(0xffa0), reportUsagePages(byteArrayOf(0x06, 0xa0.toByte(), 0xff.toByte())))
        assertEquals(setOf(0xffff), reportUsagePages(byteArrayOf(0x06, 0xff.toByte(), 0xff.toByte())))
        assertEquals(setOf(0xf1d0), reportUsagePages(byteArrayOf(0x06, 0xd0.toByte(), 0xf1.toByte())))
        assertTrue(reportUsagePages(byteArrayOf(0xfe.toByte(), 4, 0, 1, 2)).isEmpty())
    }

    @Test
    fun trezorKeepkeyAndSpecterSelectorsRejectBootloaderAndWrongEndpoints() {
        assertEquals(BhwiFamily.KEEPKEY, usbHidFamily(0x2b24, 0x0001))
        assertEquals(BhwiFamily.KEEPKEY, usbHidFamily(0x2b24, 0x0002))
        assertEquals(BhwiFamily.TREZOR, usbHidFamily(0x534c, 0x0001))
        assertEquals(BhwiFamily.TREZOR, usbHidFamily(0x1209, 0x53c1))
        assertEquals(null, usbHidFamily(0x1209, 0x53c0))
        assertEquals(BhwiFamily.SPECTER, usbSerialFamily(0xf055, 0x0001))
        assertEquals(null, usbSerialFamily(0x1209, 0x53c0))
        assertEquals(setOf(0xff00), reportUsagePages(byteArrayOf(0x06, 0x00, 0xff.toByte())))
        assertTrue(requiresStalePacketDrain(BhwiFamily.TREZOR))
        assertTrue(requiresStalePacketDrain(BhwiFamily.KEEPKEY))
        assertFalse(requiresStalePacketDrain(BhwiFamily.LEDGER))

        val exact = listOf(
            UsbEndpointIdentity(0x01, UsbConstants.USB_ENDPOINT_XFER_INT, 64),
            UsbEndpointIdentity(0x81, UsbConstants.USB_ENDPOINT_XFER_INT, 64),
        )
        assertTrue(hasExactTrezorEndpoints(exact))
        assertFalse(hasExactTrezorEndpoints(exact + UsbEndpointIdentity(0x82, UsbConstants.USB_ENDPOINT_XFER_INT, 64)))
        assertFalse(hasExactTrezorEndpoints(exact.map { if (it.address == 0x01) it.copy(address = 0x02) else it }))
        assertFalse(hasExactTrezorEndpoints(exact.map { it.copy(maxPacketSize = 32) }))
    }

    @Test
    fun stalePacketDrainStopsOnFirstQuietPollAndFailsWhenNeverQuiet() {
        runBlocking {
            val quietIo = FakeUsbDeviceConnection(emptyList(), listOf(64, -1))
            UsbHidChannel(quietIo, isAttached = { true }, isOwner = { true })
                .drainStalePackets(timeoutMillis = 1_000, pollMillis = 50)
            assertEquals(2, quietIo.reads)

            val busyIo = FakeUsbDeviceConnection(emptyList(), defaultRead = 64)
            val busy = UsbHidChannel(busyIo, isAttached = { true }, isOwner = { true })
            var now = 0L
            assertThrows(TransportException.Io::class.java) {
                runBlocking {
                    busy.drainStalePackets(timeoutMillis = 100, pollMillis = 50, nanoTime = {
                        val value = now
                        now += TimeUnit.MILLISECONDS.toNanos(25)
                        value
                    })
                }
            }
            busy.close()
            assertTrue(busyIo.closed)
        }
    }

    @Test
    fun trezorV1LinkUsesExactRaw64BytePackets() {
        val request = byteArrayOf(0x23, 0x23, 0, 1, 0, 0, 0, 3, 1, 2, 3)
        val response = byteArrayOf(0x23, 0x23, 0, 2, 0, 0, 0, 2, 4, 5)
        val packet = ByteArray(64)
        packet[0] = 0x3f
        response.copyInto(packet, 1)
        val writes = mutableListOf<ByteArray>()
        val channel = object : HidChannel {
            override suspend fun send(report: ByteArray): UInt {
                writes += report.copyOf()
                return report.size.toUInt()
            }

            override suspend fun receive(maxLen: UInt): ByteArray = packet.copyOf()
        }
        val result = runBlocking { TrezorV1Link(channel).exchange(request, false) }
        assertArrayEquals(response, result)
        assertEquals(1, writes.size)
        assertEquals(64, writes.single().size)
        assertEquals(0x3f, writes.single()[0].toInt())
        assertArrayEquals(request, writes.single().copyOfRange(1, 1 + request.size))
    }

    @Test
    fun usbPartialWritesCompleteAndZeroProgressFails() {
        runBlocking {
            val connection = FakeUsbDeviceConnection(listOf(7, 9, 16))
            val channel = UsbHidChannel(connection, isAttached = { true }, isOwner = { true })
            assertEquals(32u, channel.send(ByteArray(32)))
            assertEquals(listOf(0 to 32, 7 to 25, 16 to 16), connection.writeCalls)
            channel.close()
            assertTrue(connection.closed)

            assertThrows(TransportException.Io::class.java) {
                runBlocking { completePartialWrite(1, 5_000) { _, _, _ -> 0 } }
            }
        }
    }

    @Test
    fun usbWholeWriteDeadlineIsNotRestarted() {
        var now = 0L
        assertThrows(TransportException.Timeout::class.java) {
            runBlocking {
                completePartialWrite(8, 5, nanoTime = {
                    val value = now
                    now += TimeUnit.MILLISECONDS.toNanos(3)
                    value
                }) { _, _, _ -> 4 }
            }
        }
    }

    @Test
    fun emptyFfiSerialReadIsEofRatherThanIdlePolling() {
        var writes = 0
        val stream = object : SerialStream {
            override suspend fun writeAll(data: ByteArray) {
                writes++
            }

            override suspend fun read(maxLen: UInt) = ByteArray(0)
        }
        assertThrows(TransportException.Io::class.java) {
            runBlocking { JadeSerialLink(stream).exchange(byteArrayOf(1), false) }
        }
        assertEquals(1, writes)
    }

    @Test
    fun bleQueueIncludesRetainedPacketsAndFailsAtFourMiB() {
        val budget = BleByteBudget()
        assertTrue(budget.reserve(4 * 1024 * 1024))
        assertFalse(budget.reserve(1))
        assertEquals(4L * 1024 * 1024, budget.size())
        budget.release(1024)
        assertTrue(budget.reserve(1024))
        budget.release(32)
        assertTrue(budget.reserve(32))

        val packet = BlePacket(ByteArray(32)) { budget.release(it) }
        packet.close()
        packet.close()
        assertEquals(4L * 1024 * 1024 - 32, budget.size())
    }

    @Test
    fun gattCallbacksRequireOrderAndMtuFailureFallsBackToAttTwenty() {
        val callbacks = GattSetupState()
        assertFalse(callbacks.move(GattPhase.MTU, GattPhase.SERVICES))
        assertTrue(callbacks.move(GattPhase.CONNECTING, GattPhase.MTU))
        assertFalse(callbacks.move(GattPhase.CONNECTING, GattPhase.SERVICES))
        assertTrue(callbacks.move(GattPhase.MTU, GattPhase.SERVICES))
        assertTrue(callbacks.move(GattPhase.SERVICES, GattPhase.SUBSCRIBING))
        assertTrue(callbacks.move(GattPhase.SUBSCRIBING, GattPhase.READY))
        callbacks.close()
        assertFalse(callbacks.expects(GattPhase.READY))

        assertEquals(23, resolvedGattMtu(false, 517))
        assertEquals(20, attPayloadSize(resolvedGattMtu(false, 517)))
        assertEquals(514, attPayloadSize(resolvedGattMtu(true, 517)))
    }

    @Test
    fun cancellationClosesOwnedIoDirectlyInReverseOrder() {
        val closed = mutableListOf<String>()
        closeBhwiResources(
            listOf(
                Closeable { closed += "connection" },
                Closeable {
                    closed += "port"
                    throw IllegalStateException("close failure")
                },
                Closeable { closed += "receiver" },
            ),
        )
        assertEquals(listOf("receiver", "port", "connection"), closed)
    }

    @Test
    fun staleAndExpiredPromptsSettleWithoutPublishing() {
        val owner = BhwiOwner("new-owner")
        assertFalse(ownsBhwiState(owner, "old-owner", invalidated = false))
        assertTrue(ownsBhwiState(owner, "new-owner", invalidated = false))
        owner.closing = true
        assertFalse(ownsBhwiState(owner, "new-owner", invalidated = false))
        val stale = PairingPrompt("old", { it == "new" }, deadlineNanos = 100, nanoTime = { 0 })
        stale.cancel()
        val staleError = assertThrows(BhwiFailure::class.java) { stale.await() }
        assertEquals("BHWI_CANCELLED", staleError.code)

        val expired = PairingPrompt("owner", { it == "owner" }, deadlineNanos = 0, nanoTime = { 1 })
        val timeout = assertThrows(BhwiFailure::class.java) { expired.await() }
        assertEquals("BHWI_TIMEOUT", timeout.code)
    }

    @Test
    fun staleSessionFactoryResultIsDisconnectedBeforeItCanPublish() {
        val staleOwner = BhwiOwner("owner").apply { closing = true }
        val staleSession = FakeBhwiSession()
        val failure = assertThrows(BhwiFailure::class.java) {
            adoptBhwiSessionState(staleOwner, "owner", BhwiFamily.BITBOX02, staleSession)
        }
        assertEquals("BHWI_CANCELLED", failure.code)
        assertTrue(staleSession.disconnected)
        assertEquals(null, staleOwner.session)

        val currentOwner = BhwiOwner("owner")
        val currentSession = FakeBhwiSession()
        assertEquals(currentSession, adoptBhwiSessionState(currentOwner, "owner", BhwiFamily.JADE, currentSession))
        assertFalse(currentSession.disconnected)
        assertEquals(BhwiFamily.JADE, currentOwner.family)
    }

    @Test
    fun jadeUrlBoundaryAllowsOnlyOfficialHttpsOrigin() {
        assertEquals(
            "https://jadepin.blockstream.com/get_pin",
            trustedPinServerUrl("https://jadepin.blockstream.com/get_pin").toString(),
        )
        listOf(
            "http://jadepin.blockstream.com/get_pin",
            "https://JADEPIN.BLOCKSTREAM.COM/get_pin",
            "https://user@jadepin.blockstream.com/get_pin",
            "https://jadepin.blockstream.com:444/get_pin",
            "https://jadepin.blockstream.com/get_pin#fragment",
            "https://example.com/get_pin",
        ).forEach { value ->
            assertThrows(PinServerPolicyException::class.java) { trustedPinServerUrl(value) }
        }
    }

    @Test
    fun jadePostIsUnchangedBoundedAndNeverFollowsRedirects() {
        val body = "{\"opaque\":true}".toByteArray()
        val success = FakeHttpConnection(200, "response".toByteArray())
        val response = runBlocking {
            BhwiPinServerHttp(PinConnectionFactory { success }, maximumResponseBytes = 8).request(
                "https://jadepin.blockstream.com/get_pin",
                body,
            )
        }
        assertArrayEquals("response".toByteArray(), response)
        assertArrayEquals(body, success.sent.toByteArray())
        assertEquals("application/json", success.getRequestProperty("Content-Type"))
        assertFalse(success.instanceFollowRedirects)
        assertTrue(success.disconnected)

        val redirect = FakeHttpConnection(302, ByteArray(0))
        assertThrows(TransportException.Io::class.java) {
            runBlocking {
                BhwiPinServerHttp(PinConnectionFactory { redirect }).request(
                    "https://jadepin.blockstream.com/get_pin",
                    body,
                )
            }
        }
        assertFalse(redirect.instanceFollowRedirects)

        val oversized = object : FakeHttpConnection(200, ByteArray(9)) {
            override fun getContentLengthLong() = -1L
        }
        assertThrows(TransportException.Io::class.java) {
            runBlocking {
                BhwiPinServerHttp(PinConnectionFactory { oversized }, maximumResponseBytes = 8).request(
                    "https://jadepin.blockstream.com/get_pin",
                    body,
                )
            }
        }
    }

    @Test
    fun jadeDeadlineDisconnectsTheOwnedConnection() {
        val blocked = BlockingHttpConnection()
        assertThrows(TimeoutCancellationException::class.java) {
            runBlocking {
                BhwiPinServerHttp(PinConnectionFactory { blocked }, requestTimeoutMillis = 10).request(
                    "https://jadepin.blockstream.com/get_pin",
                    byteArrayOf(1),
                )
            }
        }
        assertTrue(blocked.disconnected)
    }

    @Test
    fun nativeErrorsAreClassifiedWithoutTheirPayload() {
        val canary = "raw-secret-payload"
        val code = bhwiErrorCode(HwiException.Device(canary))
        assertEquals("BHWI_DEVICE_ERROR", code)
        assertFalse(code.contains(canary))
        assertEquals("BHWI_TIMEOUT", bhwiErrorCode(TransportException.Timeout()))
        assertEquals("BHWI_DISCONNECTED", bhwiErrorCode(TransportException.Disconnected()))
        assertEquals("BHWI_UNSUPPORTED", bhwiErrorCode(PinServerPolicyException()))
    }

    @Test
    fun connectedFamilyFormatsFailClosedBeforeFfi() {
        assertFalse(supportsBhwiFormat(BhwiFamily.BITBOX02, "legacy"))
        assertFalse(supportsBhwiFormat(BhwiFamily.BITBOX02, "taproot"))
        assertTrue(supportsBhwiFormat(BhwiFamily.BITBOX02, "native-segwit"))
        assertFalse(supportsBhwiFormat(BhwiFamily.JADE, "taproot"))
        assertTrue(supportsBhwiFormat(BhwiFamily.JADE, "nested-segwit"))
        assertFalse(supportsBhwiFormat(BhwiFamily.KEEPKEY, "taproot"))
        assertFalse(supportsBhwiFormat(BhwiFamily.TREZOR, "taproot", model = "1"))
        assertTrue(supportsBhwiFormat(BhwiFamily.TREZOR, "taproot", model = "T"))
        assertFalse(supportsBhwiFormat(BhwiFamily.SPECTER, "taproot"))
        assertTrue(supportsDescriptorDisplay(BhwiFamily.SPECTER, "wpkh(key)"))
        assertFalse(supportsDescriptorDisplay(BhwiFamily.SPECTER, "tr(key)"))
        assertFalse(supportsRegistration(BhwiFamily.TREZOR))
        assertFalse(supportsRegistration(BhwiFamily.KEEPKEY))
        assertTrue(supportsRegistration(BhwiFamily.SPECTER))
        assertTrue(supportsRawMultisigDisplay(BhwiFamily.TREZOR))
        assertFalse(supportsRawMultisigDisplay(BhwiFamily.SPECTER))
        assertFalse(supportsBhwiFormat(BhwiFamily.COLDCARD, "taproot"))
        assertTrue(supportsBhwiFormat(BhwiFamily.LEDGER, "taproot"))
        assertFalse(supportsDescriptorDisplay(BhwiFamily.JADE, "tr([deadbeef/86'/0'/0']xpub/<0;1>/*)"))
        assertFalse(supportsDescriptorDisplay(BhwiFamily.COLDCARD, "wsh(sortedmulti(2,key1,key2))"))
        assertTrue(supportsDescriptorDisplay(BhwiFamily.LEDGER, "tr(key)"))
        assertTrue(supportsBhwiMessageSigning(BhwiFamily.COLDCARD, "native-segwit", model = "mk5"))
        assertTrue(supportsBhwiMessageSigning(BhwiFamily.LEDGER, "legacy"))
        assertTrue(supportsBhwiMessageSigning(BhwiFamily.LEDGER, "native-segwit"))
        assertTrue(supportsBhwiMessageSigning(BhwiFamily.JADE, "legacy"))
        assertTrue(supportsBhwiMessageSigning(BhwiFamily.KEEPKEY, "legacy"))
        assertTrue(supportsBhwiMessageSigning(BhwiFamily.TREZOR, "legacy", model = "1"))
        assertTrue(supportsBhwiMessageSigning(BhwiFamily.TREZOR, "native-segwit", model = "T"))
        assertFalse(supportsBhwiMessageSigning(BhwiFamily.TREZOR, "legacy", model = "unknown"))
        assertTrue(supportsBhwiMessageSigning(BhwiFamily.BITBOX02, "nested-segwit"))
        assertTrue(supportsBhwiMessageSigning(BhwiFamily.BITBOX02, "native-segwit"))
        assertFalse(supportsBhwiMessageSigning(BhwiFamily.BITBOX02, "legacy"))
        assertFalse(supportsBhwiMessageSigning(BhwiFamily.SPECTER, "legacy"))
        assertFalse(supportsBhwiMessageSigning(BhwiFamily.LEDGER, "taproot"))
    }

    @Test
    fun trezorModelsRouteHostPinAndKeepkeyRejectsOnDevicePassphrase() {
        val channel = object : HidChannel {
            override suspend fun send(report: ByteArray): UInt = error("unexpected IO")
            override suspend fun receive(maxLen: UInt): ByteArray = error("unexpected IO")
        }
        fun info(model: String?) = HwiResponse.Info(
            version = "test",
            firmware = model,
            initialized = true,
            networks = listOf(Network.TESTNET),
            label = null,
            onDevicePassphraseEntry = model == "T",
            needsPinSent = true,
            needsPassphraseSent = model != "T",
        )

        val trezor = HwiSession.trezorUsb(channel, Network.TESTNET)
        assertTrue(trezor.supportsHostPin(info(null)))
        assertTrue(trezor.supportsHostPin(info("1")))
        assertFalse(trezor.supportsHostPin(info("T")))
        assertEquals(
            listOf(PassphraseMode.STANDARD, PassphraseMode.ON_DEVICE),
            passphraseModes(BhwiFamily.TREZOR, info("T")),
        )
        assertEquals(
            listOf(PassphraseMode.STANDARD, PassphraseMode.HOST),
            passphraseModes(BhwiFamily.TREZOR, info("1")),
        )
        assertEquals(
            listOf(PassphraseMode.STANDARD),
            passphraseModes(BhwiFamily.KEEPKEY, info("T")),
        )
        assertThrows(HwiException.InvalidInput::class.java) { trezor.supportsHostPin(info("unknown")) }
        assertThrows(HwiException.InvalidInput::class.java) { HostPassphraseHandle("a".repeat(51)) }

        val keepkey = HwiSession.keepkeyUsb(channel, Network.TESTNET)
        assertTrue(keepkey.supportsHostPin(info(null)))
        assertThrows(HwiException.InvalidInput::class.java) { keepkey.configurePassphrase(null, true) }
        keepkey.disconnect()

        val handle = HostPassphraseHandle("owner-controlled passphrase")
        handle.validate()
        trezor.configurePassphrase(handle, false)
        trezor.disconnect()
        assertThrows(HwiException.BadState::class.java) { handle.validate() }
    }

    @Test
    fun hostPinFlowUsesOnlyPositionsOnOneSessionAndMapsRefusal() {
        val positions = PinPositionBuffer()
        assertFalse(positions.add(0))
        assertTrue(positions.add(9))
        assertTrue(positions.add(1))
        positions.backspace()
        assertEquals("9", positions.take())
        assertTrue(positions.isEmpty)

        val events = mutableListOf<String>()
        runBlocking {
            runHostPinFlow(
                promptPin = {
                    events += "prompt"
                    true
                },
                readPositions = {
                    events += "keypad"
                    "193"
                },
                sendPin = {
                    events += "send:$it"
                    true
                },
            )
        }
        assertEquals(listOf("prompt", "keypad", "send:193"), events)

        val refusal = assertThrows(BhwiFailure::class.java) {
            runBlocking { runHostPinFlow(promptPin = { false }, readPositions = { "1" }, sendPin = { true }) }
        }
        assertEquals("BHWI_AUTH_REFUSED", refusal.code)
        val cancelled = BlockingValuePrompt<String>("owner", { true }, Long.MAX_VALUE).apply { cancel() }
        assertEquals(
            "BHWI_CANCELLED",
            assertThrows(BhwiFailure::class.java) { cancelled.await() }.code,
        )
    }

    @Test
    fun specterFramesRespectEofFourMiBBoundaryAndCancellation() {
        val request = "\r\n\r\nfingerprint\r\n".toByteArray()
        val maximum = 4 * 1024 * 1024
        val reply = "ACK\r\n".toByteArray() + ByteArray(maximum) { 'x'.code.toByte() } + "\r\n".toByteArray()
        val chunks = ArrayDeque<ByteArray>()
        for (offset in reply.indices step (16 * 1024)) {
            chunks += reply.copyOfRange(offset, minOf(offset + 16 * 1024, reply.size))
        }
        val stream = object : SerialStream {
            override suspend fun writeAll(data: ByteArray) = Unit
            override suspend fun read(maxLen: UInt): ByteArray = if (chunks.isEmpty()) ByteArray(0) else chunks.removeFirst()
        }
        val result = runBlocking { SpecterSerialLink(stream).exchange(request, false) }
        assertEquals(reply.size, result.size)
        assertArrayEquals(reply.copyOfRange(0, 5), result.copyOfRange(0, 5))

        val oversized = "ACK\r\n".toByteArray() + ByteArray(maximum + 1) { 'x'.code.toByte() } + "\r\n".toByteArray()
        SpecterFrameDecoder().use { decoder ->
            assertThrows(HwiException.Device::class.java) { decoder.push(oversized) }
        }
        val eof = object : SerialStream {
            override suspend fun writeAll(data: ByteArray) = Unit
            override suspend fun read(maxLen: UInt) = ByteArray(0)
        }
        assertThrows(TransportException.Disconnected::class.java) {
            runBlocking { SpecterSerialLink(eof).exchange(request, false) }
        }

        val entered = CompletableDeferred<Unit>()
        val blocked = object : SerialStream {
            override suspend fun writeAll(data: ByteArray) = Unit
            override suspend fun read(maxLen: UInt): ByteArray {
                entered.complete(Unit)
                awaitCancellation()
            }
        }
        runBlocking {
            val link = SpecterSerialLink(blocked)
            val call = async { link.exchange(request, false) }
            withTimeout(1_000) { entered.await() }
            call.cancelAndJoin()
            assertThrows(TransportException.Disconnected::class.java) {
                runBlocking { link.exchange(request, false) }
            }
        }
    }

    @Test
    fun immutableBuildProfilesMapOnlyToBitcoinAndTestnet() {
        assertEquals(Network.BITCOIN, bhwiNetwork("bitcoin"))
        assertEquals(Network.TESTNET, bhwiNetwork("testnet"))
        assertThrows(IllegalStateException::class.java) { bhwiNetwork("testnet3") }
    }

}

private class FakeBhwiSession : BhwiSessionApi {
    @Volatile var disconnected = false

    override suspend fun unlock(network: Network): HwiResponse = error("unused")
    override suspend fun getInfo(): HwiResponse.Info = error("unused")
    override suspend fun fingerprint(): String = error("unused")
    override suspend fun xpub(path: String): String = error("unused")
    override suspend fun register(name: String, descriptor: String): WalletRegistration = error("unused")
    override suspend fun displaySinglesig(path: String, format: AddressFormat): String = error("unused")
    override suspend fun displayDescriptor(index: UInt, change: Boolean, policy: WalletPolicy): String = error("unused")
    override suspend fun displayMultisig(threshold: UByte, format: MultisigAddressFormat, keys: List<String>): String =
        error("unused")
    override suspend fun signPsbt(psbt: String, policy: WalletPolicy?): String = error("unused")
    override suspend fun signMessage(path: String, message: String): String = error("unused")
    override fun supportsHostPin(info: HwiResponse.Info) = false
    override suspend fun promptPin() = error("unused")
    override suspend fun sendPin(positions: String) = error("unused")
    override fun configurePassphrase(mode: PassphraseMode, text: String?) = error("unused")
    override fun disconnect() {
        disconnected = true
    }
}

private class FakeUsbDeviceConnection(
    writeResults: List<Int>,
    readResults: List<Int> = emptyList(),
    private val defaultRead: Int = 0,
) : UsbHidIo {
    private val writeResults = ArrayDeque(writeResults)
    private val readResults = ArrayDeque(readResults)
    val writeCalls = mutableListOf<Pair<Int, Int>>()
    var reads = 0
        private set
    @Volatile var closed = false

    override fun write(report: ByteArray, offset: Int, length: Int, timeoutMillis: Int): Int {
        writeCalls += offset to length
        return writeResults.removeFirst()
    }

    override fun read(buffer: ByteArray, timeoutMillis: Int): Int {
        reads++
        return if (readResults.isEmpty()) defaultRead else readResults.removeFirst()
    }

    override fun close() {
        closed = true
    }
}

private open class FakeHttpConnection(
    private val status: Int,
    private val response: ByteArray,
) : HttpURLConnection(URL("https://jadepin.blockstream.com/get_pin")) {
    val sent = ByteArrayOutputStream()
    @Volatile var disconnected = false

    override fun connect() = Unit
    override fun disconnect() {
        disconnected = true
    }
    override fun usingProxy() = false
    override fun getResponseCode() = status
    override fun getContentLengthLong() = response.size.toLong()
    override fun getOutputStream() = sent
    override fun getInputStream(): InputStream = ByteArrayInputStream(response)
}

private class BlockingHttpConnection : FakeHttpConnection(200, ByteArray(0)) {
    private val closed = CountDownLatch(1)

    override fun disconnect() {
        super.disconnect()
        closed.countDown()
    }

    override fun getInputStream(): InputStream = object : InputStream() {
        override fun read(): Int {
            closed.await()
            return -1
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            closed.await()
            return -1
        }
    }
}
