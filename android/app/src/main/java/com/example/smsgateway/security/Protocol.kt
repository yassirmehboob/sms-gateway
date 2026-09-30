package com.example.smsgateway.security

import java.security.MessageDigest
import java.net.URI

object Protocol {
    fun hash(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun origin(value: String, allowLocalHttp: Boolean = false): String {
        val uri = URI(value.trim())
        val octets = uri.host?.split('.')?.mapNotNull { it.toIntOrNull()?.takeIf { n -> n in 0..255 } }.orEmpty()
        val local = uri.host?.matches(Regex("[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+")) == true && octets.size == 4 && (octets[0] == 10 || (octets[0] == 172 && octets[1] in 16..31) || (octets[0] == 192 && octets[1] == 168))
        val basePath = (uri.rawPath ?: "").removeSuffix("/")
        require((uri.scheme == "https" || (allowLocalHttp && uri.scheme == "http" && local)) && !uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && (uri.port == -1 || uri.port in 1..65535) && basePath.matches(Regex("(?:/[A-Za-z0-9_-]+)*"))) { "Use an HTTPS base URL with an optional path such as /sms-gateway" }
        return value.trim().trimEnd('/')
    }
    fun devicePath(baseUrl: String, endpoint: String): String = URI(baseUrl).rawPath.orEmpty().trimEnd('/') + "/v1/device$endpoint"
    fun signingText(deviceId: String, seconds: Long, nonce: String, path: String, body: ByteArray) = listOf("sms-gateway-device-v1", deviceId, seconds.toString(), nonce, "POST", path, hash(body)).joinToString("\n")
    fun deadlineValid(leaseMillis: Long, expiryMillis: Long, nowMillis: Long): Boolean = nowMillis + 5_000 < minOf(leaseMillis, expiryMillis)
    fun monotonicAuthorizationValid(requestStarted: Long, now: Long, validForMs: Long): Boolean = now >= requestStarted && now - requestStarted < minOf(20_000, validForMs - 5_000)
}
