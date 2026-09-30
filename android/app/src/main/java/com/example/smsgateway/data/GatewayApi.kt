package com.example.smsgateway.data

import com.example.smsgateway.security.*
import com.example.smsgateway.security.Protocol
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

class ApiFailure(val status: Int) : Exception("Gateway request failed ($status)")
class GatewayApi(private val secrets: SecretStore) {
    private val identity = DeviceIdentity()
    // Automatic retries/redirects are disabled, especially for one-time authorization.
    private val client = OkHttpClient.Builder().retryOnConnectionFailure(false).followRedirects(false).followSslRedirects(false).callTimeout(20, TimeUnit.SECONDS).build()
    fun post(endpoint: String, body: JSONObject): JSONObject {
        val origin = Protocol.origin(requireNotNull(secrets.get("origin")), com.example.smsgateway.BuildConfig.DEBUG)
        val id = requireNotNull(secrets.get("deviceId"))
        val path = Protocol.devicePath(origin, endpoint)
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        val seconds = System.currentTimeMillis() / 1000
        val nonce = UUID.randomUUID().toString()
        val signature = identity.sign(Protocol.signingText(id, seconds, nonce, path, bytes).toByteArray(Charsets.UTF_8))
        val req = Request.Builder().url(origin + "/v1/device$endpoint").header("X-Device-Id", id).header("X-Device-Timestamp", seconds.toString()).header("X-Device-Nonce", nonce).header("X-Device-Signature", signature).post(bytes.toRequestBody("application/json".toMediaType())).build()
        return client.newCall(req).execute().use { response ->
            if (!response.isSuccessful) throw ApiFailure(response.code)
            val source = requireNotNull(response.body).source()
            require(!source.request(32769)) { "Oversized gateway response" }
            JSONObject(source.readUtf8())
        }
    }
}
