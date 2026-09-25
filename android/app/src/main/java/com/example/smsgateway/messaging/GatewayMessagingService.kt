package com.example.smsgateway.messaging

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.example.smsgateway.security.SecretStore

class GatewayMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        SecretStore(this).put("fcmToken", token)
        SyncScheduler.enqueue(this)
    }
    override fun onMessageReceived(message: RemoteMessage) {
        val secrets = SecretStore(this)
        if (message.data["deviceId"] == secrets.get("deviceId") && message.data["jobAvailable"] == "true") SyncScheduler.enqueue(this)
    }
}
