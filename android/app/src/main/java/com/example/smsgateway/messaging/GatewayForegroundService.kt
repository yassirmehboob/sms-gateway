package com.example.smsgateway.messaging

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.*
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.example.smsgateway.GatewayApplication
import com.example.smsgateway.MainActivity
import com.example.smsgateway.security.SecretStore
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** User-enabled dedicated SMS gateway, with a visible, stoppable notification. */
class GatewayForegroundService : Service() {
    private val polling = Executors.newSingleThreadScheduledExecutor()
    @Volatile private var stopped = false
    private lateinit var wakeLock: PowerManager.WakeLock
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("gateway", "Gateway running", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val pause = PendingIntent.getService(this, 1, Intent(this, GatewayForegroundService::class.java).setAction("PAUSE"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(this, "gateway").setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("SMS gateway running").setContentText("Checking approved jobs every 30 seconds")
            .setOngoing(true).setContentIntent(open).addAction(0, "Pause gateway", pause).build()
        ServiceCompat.startForeground(this, 1001, notification, if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)
        wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sms-gateway:polling").apply { setReferenceCounted(false) }
        polling.scheduleWithFixedDelay({
            try {
                val secrets = SecretStore(this)
                if (secrets.paused || secrets.get("enrolled") != "true") { stopSelf(); return@scheduleWithFixedDelay }
                // Bounded and renewed while explicitly enabled; released on pause/destruction.
                wakeLock.acquire(10 * 60 * 1000L)
                GatewaySyncEngine(applicationContext) { stopped }.run()
            } catch (_: Exception) { /* Next tick retries; engine records sync errors. */ }
        }, 0, 30, TimeUnit.SECONDS)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "PAUSE") {
            synchronized(GatewayApplication.sendLock) { SecretStore(this).paused = true }
            stopSelf(); return START_NOT_STICKY
        }
        if (SecretStore(this).paused) { stopSelf(); return START_NOT_STICKY }
        return START_STICKY
    }
    override fun onDestroy() {
        stopped = true
        polling.shutdownNow()
        if (::wakeLock.isInitialized && wakeLock.isHeld) wakeLock.release()
        super.onDestroy()
    }
    override fun onBind(intent: Intent?) = null
    companion object {
        fun start(context: Context) = ContextCompat.startForegroundService(context, Intent(context, GatewayForegroundService::class.java))
        fun stop(context: Context) = context.stopService(Intent(context, GatewayForegroundService::class.java))
    }
}
