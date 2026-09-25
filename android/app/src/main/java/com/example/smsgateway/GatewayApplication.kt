package com.example.smsgateway

import android.app.Application
import com.example.smsgateway.messaging.SyncScheduler
import java.util.concurrent.Executors

class GatewayApplication : Application() {
    override fun onCreate() { super.onCreate(); SyncScheduler.periodic(this) }
    companion object {
        val executor = Executors.newSingleThreadExecutor()
        val syncLock = Any()
        val sendLock = Any()
    }
}
