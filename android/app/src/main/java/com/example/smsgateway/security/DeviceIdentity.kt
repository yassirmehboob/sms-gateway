package com.example.smsgateway.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

class DeviceIdentity {
    private val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    fun ensureKey(): Unit = synchronized(DeviceIdentity::class.java) {
        if (!store.containsAlias(ALIAS)) KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
            initialize(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN).setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build())
        }.generateKeyPair()
    }
    fun publicPem(): String { ensureKey(); return "-----BEGIN PUBLIC KEY-----\n" + Base64.encodeToString(store.getCertificate(ALIAS).publicKey.encoded, Base64.NO_WRAP).chunked(64).joinToString("\n") + "\n-----END PUBLIC KEY-----\n" }
    fun sign(bytes: ByteArray): String {
        ensureKey()
        return Signature.getInstance("SHA256withECDSA").run { initSign(store.getKey(ALIAS, null) as PrivateKey); update(bytes); Base64.encodeToString(sign(), Base64.NO_WRAP) }
    }
    companion object { private const val ALIAS = "gateway-identity-v1" }
}
