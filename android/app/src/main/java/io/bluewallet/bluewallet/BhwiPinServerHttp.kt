package io.bluewallet.bluewallet

import com.wizardsardine.bhwi.HttpBridge
import com.wizardsardine.bhwi.TransportException
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout

internal fun interface PinConnectionFactory {
    fun open(url: URL): HttpURLConnection
}

internal class PinServerPolicyException : Exception()

internal class BhwiPinServerHttp(
    private val connectionFactory: PinConnectionFactory = PinConnectionFactory { url ->
        url.openConnection() as? HttpURLConnection
            ?: throw TransportException.Io("unsupported PIN server connection")
    },
    private val requestTimeoutMillis: Long = 30_000L,
    private val maximumResponseBytes: Long = 1024L * 1024,
) : HttpBridge {
    override suspend fun request(url: String, body: ByteArray): ByteArray {
        val trusted = trustedPinServerUrl(url)
        return withTimeout(requestTimeoutMillis) {
            coroutineScope {
                val requestScope = this
                suspendCancellableCoroutine { continuation ->
                    val connection = try {
                        connectionFactory.open(trusted)
                    } catch (error: TransportException) {
                        continuation.resumeWithException(error)
                        return@suspendCancellableCoroutine
                    } catch (error: Throwable) {
                        continuation.resumeWithException(TransportException.Io("PIN server connection failed"))
                        return@suspendCancellableCoroutine
                    }
                    val disconnected = AtomicBoolean(false)
                    fun disconnect() {
                        if (disconnected.compareAndSet(false, true)) connection.disconnect()
                    }
                    continuation.invokeOnCancellation { disconnect() }
                    requestScope.launch(Dispatchers.IO) {
                        try {
                            val response = execute(connection, body)
                            if (continuation.isActive) continuation.resume(response)
                        } catch (error: Throwable) {
                            val safe = when (error) {
                                is TransportException -> error
                                is IOException -> TransportException.Io("PIN server request failed")
                                else -> TransportException.Io("PIN server request failed")
                            }
                            if (continuation.isActive) continuation.resumeWithException(safe)
                        } finally {
                            disconnect()
                        }
                    }
                }
            }
        }
    }

    private fun execute(connection: HttpURLConnection, body: ByteArray): ByteArray {
        connection.instanceFollowRedirects = false
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.connectTimeout = requestTimeoutMillis.toInt()
        connection.readTimeout = requestTimeoutMillis.toInt()
        connection.setRequestProperty("Content-Type", "application/json")
        connection.setFixedLengthStreamingMode(body.size)
        connection.outputStream.use { it.write(body) }
        val status = connection.responseCode
        if (status !in 200..299) throw TransportException.Io("PIN server request failed")
        if (connection.contentLengthLong > maximumResponseBytes) {
            throw TransportException.Io("PIN server response exceeded its limit")
        }
        connection.inputStream.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count == 0) continue
                if (output.size().toLong() + count > maximumResponseBytes) {
                    throw TransportException.Io("PIN server response exceeded its limit")
                }
                output.write(buffer, 0, count)
            }
            return output.toByteArray()
        }
    }

}

internal fun trustedPinServerUrl(value: String): URL {
    val uri = try {
        URI(value)
    } catch (error: Exception) {
        throw PinServerPolicyException()
    }
    if (
        uri.scheme != "https" ||
        (uri.host != "jadepin.blockstream.com" && uri.host != "j8d.io") ||
        (uri.port != -1 && uri.port != 443) ||
        uri.rawUserInfo != null ||
        uri.rawFragment != null
    ) {
        throw PinServerPolicyException()
    }
    return try {
        uri.toURL()
    } catch (error: Exception) {
        throw PinServerPolicyException()
    }
}
