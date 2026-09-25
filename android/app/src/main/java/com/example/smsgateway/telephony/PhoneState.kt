package com.example.smsgateway.telephony

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.telephony.SubscriptionManager
import androidx.core.content.ContextCompat
import com.example.smsgateway.security.SecretStore
import org.json.JSONObject

class PhoneState(private val context: Context, private val secrets: SecretStore) {
    fun subscriptions() = try {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) {
            context.getSystemService(SubscriptionManager::class.java).activeSubscriptionInfoList.orEmpty()
        } else emptyList()
    } catch (_: SecurityException) {
        // Permission can be revoked between the check and the subscription query.
        emptyList()
    }
    fun granted(permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
    fun subscriptionId() = secrets.get("subscriptionId")?.toIntOrNull() ?: -1
    fun ready(): Boolean {
        val id = subscriptionId()
        val selected = subscriptions().firstOrNull { it.subscriptionId == id } ?: return false
        return !secrets.paused && granted(Manifest.permission.SEND_SMS) && granted(Manifest.permission.RECEIVE_SMS) && selected.simSlotIndex.toString() == secrets.get("simSlot") && selected.carrierId.toString() == secrets.get("carrierId")
    }
    fun json(): JSONObject = JSONObject().put("subscriptionId", subscriptionId().coerceAtLeast(0)).put("canSendSms", ready()).put("locallyPaused", secrets.paused)
}
