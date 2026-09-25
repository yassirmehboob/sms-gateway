package com.example.smsgateway.messaging

import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

object SyncScheduler {
    private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
    fun enqueue(context: Context) = WorkManager.getInstance(context).enqueueUniqueWork("gateway-sync", ExistingWorkPolicy.APPEND_OR_REPLACE,
        OneTimeWorkRequestBuilder<GatewaySyncWorker>().setConstraints(network).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
    fun periodic(context: Context) = WorkManager.getInstance(context).enqueueUniquePeriodicWork("gateway-periodic", ExistingPeriodicWorkPolicy.KEEP,
        PeriodicWorkRequestBuilder<GatewaySyncWorker>(15, TimeUnit.MINUTES).setConstraints(network).build())
}
