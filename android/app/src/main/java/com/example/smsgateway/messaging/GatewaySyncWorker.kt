package com.example.smsgateway.messaging

import android.content.Context
import android.os.SystemClock
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.ListenableWorker.Result
import com.example.smsgateway.GatewayApplication
import com.example.smsgateway.data.*
import com.example.smsgateway.security.*
import com.example.smsgateway.telephony.*
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

class GatewaySyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = GatewaySyncEngine(applicationContext) { isStopped }.run()
}

class GatewaySyncEngine(private val applicationContext: Context, private val stopped: () -> Boolean = { false }) {
    private val isStopped get() = stopped()
    fun run(): Result = synchronized(GatewayApplication.syncLock) {
        val secrets = SecretStore(applicationContext)
        try {
            if (secrets.get("enrolled") != "true") return@synchronized Result.success()
            val api = GatewayApi(secrets)
            val dao = Journal.get(applicationContext).dao()
            for (event in dao.pendingControls()) {
                val payload = JSONObject(secrets.decrypt("inbound:${event.eventId}", requireNotNull(event.encryptedPayload)))
                try {
                    val response = api.post("/inbound-control", payload)
                    synchronized(GatewayApplication.sendLock) {
                        Journal.get(applicationContext).runInTransaction {
                            // Unknown senders remain locally blocked; no automatic response is sent.
                            dao.reconcileLocal(Protocol.hash(payload.getString("from").toByteArray()), event.eventId,
                                !response.optBoolean("accepted") || response.optBoolean("optedOut", true))
                            dao.acknowledgeControl(event.eventId)
                        }
                    }
                } catch (error: ApiFailure) {
                    if (error.status in listOf(400, 409, 422)) dao.blockControl(event.eventId) else throw error
                }
            }
            if (dao.pendingControls().isNotEmpty()) return@synchronized Result.retry()
            for (event in dao.pending()) {
                try {
                    api.post("/jobs/${event.jobId}/events", JSONObject().put("eventId", event.eventId).put("leaseId", event.leaseId).put("partIndex", 0).put("type", event.type))
                    dao.acknowledge(event.eventId)
                } catch (error: ApiFailure) {
                    if (error.status in listOf(400, 404, 409)) dao.block(event.eventId) else throw error
                }
            }
            secrets.get("fcmToken")?.let { token ->
                if (secrets.get("registeredFcmToken") != token) {
                    api.post("/fcm-token", JSONObject().put("token", token)); secrets.put("registeredFcmToken", token)
                }
            }
            val phone = PhoneState(applicationContext, secrets)
            val heartbeat = api.post("/heartbeat", phone.json())
            secrets.put("lastSync", "Server reached at ${Instant.now()}; ${if (heartbeat.getBoolean("paused")) "server paused" else "server enabled"}")
            if (heartbeat.getInt("subscriptionId") != phone.subscriptionId()) { secrets.paused = true; return@synchronized Result.success() }
            if (heartbeat.getBoolean("paused") || !phone.ready() || isStopped) return@synchronized Result.success()
            val response = api.post("/jobs/claim", phone.json())
            if (response.isNull("job")) return@synchronized Result.success()
            val job = response.getJSONObject("job")
            val id = UUID.fromString(job.getString("jobId")).toString()
            val lease = UUID.fromString(job.getString("leaseId")).toString()
            val to = job.getString("to"); val body = job.getString("body")
            val control = job.optString("controlCommand")
            val recipientHash = Protocol.hash(to.toByteArray())
            // A fresh server-approved normal/START job can reflect a CMS restore.
            // Never clear an unacknowledged STOP, including rejected uploads.
            if (control != "STOP") synchronized(GatewayApplication.sendLock) { dao.reconcileApprovedRecipient(recipientHash) }
            if (control != "STOP" && dao.locallyBlocked(recipientHash) == true) return@synchronized Result.success()
            val leaseDeadline = Instant.parse(job.getString("leaseExpiresAt")).toEpochMilli()
            val expiry = Instant.parse(job.getString("expiresAt")).toEpochMilli()
            val sms = SmsSender(applicationContext)
            require(to.matches(Regex("\\+92[0-9]{10}")) && body.length <= 160 && job.getInt("segments") == 1)
            require(Protocol.hash(body.toByteArray(Charsets.UTF_8)) == job.getString("bodyHash"))
            if (job.getInt("subscriptionId") != phone.subscriptionId() || !phone.ready() || !sms.singleSegment(phone.subscriptionId(), body) || !Protocol.deadlineValid(leaseDeadline, expiry, System.currentTimeMillis()) || isStopped) return@synchronized Result.success()
            val attempt = Attempt(id, lease, job.getString("bodyHash"), phone.subscriptionId(), System.currentTimeMillis(), UUID.randomUUID().toString())
            // INSERT is durable before authorization. Nothing ever clears this tombstone.
            if (dao.reserve(attempt) == -1L) return@synchronized Result.success()
            val start = SystemClock.elapsedRealtime()
            val authorization = api.post("/jobs/$id/authorize", JSONObject().put("leaseId", lease).put("readiness", phone.json()))
            val authorizedUntil = Instant.parse(authorization.getString("validUntil")).toEpochMilli()
            val validForMs = authorization.getLong("validForMs")
            require(validForMs in 1..60_000)
            if (!authorization.getBoolean("authorized") || authorization.getString("jobId") != id || authorization.getString("leaseId") != lease) return@synchronized Result.success()
            // Pause and send invocation share a short local lock; never hold it during network I/O.
            synchronized(GatewayApplication.sendLock) {
                val recipientAllowed = dao.pendingControls().isEmpty() && (control == "STOP" || dao.locallyBlocked(recipientHash) != true)
                if (recipientAllowed && !isStopped && phone.ready() && phone.subscriptionId() == attempt.subscriptionId && Protocol.monotonicAuthorizationValid(start, SystemClock.elapsedRealtime(), validForMs) && Protocol.deadlineValid(minOf(leaseDeadline, authorizedUntil), expiry, System.currentTimeMillis())) sms.send(attempt, to, body)
            }
            SyncScheduler.enqueue(applicationContext)
            Result.success()
        } catch (error: ApiFailure) {
            secrets.put("lastSync", "Server rejected a request (HTTP ${error.status})")
            if (error.status == 401) secrets.paused = true
            if (error.status == 429 || error.status >= 500) Result.retry() else Result.success()
        } catch (_: Exception) {
            secrets.put("lastSync", "Sync interrupted; check network, permissions and device configuration")
            // Network/telephony uncertainty never clears an attempt. A subsequent
            // sync can upload callbacks but cannot authorize this job again.
            Result.retry()
        }
    }
}
