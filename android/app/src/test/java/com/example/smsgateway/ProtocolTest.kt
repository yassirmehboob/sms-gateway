package com.example.smsgateway

import com.example.smsgateway.security.Protocol
import org.junit.Assert.*
import org.junit.Test

class ProtocolTest {
    @Test fun requestSignatureHasExactFraming() {
        val bytes = "{}".toByteArray()
        val value = Protocol.signingText("device", 1790000000, "nonce", "/v1/device/heartbeat", bytes)
        assertEquals("sms-gateway-device-v1\ndevice\n1790000000\nnonce\nPOST\n/v1/device/heartbeat\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", value)
        assertFalse(value.endsWith("\n"))
        assertNotEquals(value, Protocol.signingText("device", 1790000000, "nonce", "/v1/device/jobs/claim", bytes))
    }
    @Test fun baseUrlAllowsSubfoldersAndRejectsAmbiguousPaths() {
        assertEquals("https://gateway.example", Protocol.origin("https://gateway.example/"))
        assertEquals("https://gateway.example/sms-gateway", Protocol.origin("https://gateway.example/sms-gateway/"))
        assertEquals("/sms-gateway/v1/device/heartbeat", Protocol.devicePath("https://gateway.example/sms-gateway", "/heartbeat"))
        assertEquals("/v1/device/heartbeat", Protocol.devicePath("https://gateway.example", "/heartbeat"))
        for (bad in listOf("http://gateway.example", "https://user:pass@gateway.example", "https://gateway.example/a/../b", "https://gateway.example//api", "https://gateway.example/a%2fb", "https://gateway.example?token=secret", "https://gateway.example/api#fragment")) {
            assertThrows(IllegalArgumentException::class.java) { Protocol.origin(bad) }
        }
    }
    @Test fun deadlinesHaveSafetyMargin() {
        assertFalse(Protocol.deadlineValid(10000, 9000, 5000))
        assertTrue(Protocol.deadlineValid(20000, 15000, 5000))
        assertFalse(Protocol.monotonicAuthorizationValid(1000, 11000, 8000))
        assertTrue(Protocol.monotonicAuthorizationValid(1000, 2000, 10000))
        assertFalse(Protocol.monotonicAuthorizationValid(1000, 500, 10000))
    }
    @Test fun debugHttpRequiresPrivateIpv4() {
        for (host in listOf("192.168.1.10", "10.0.2.2", "172.16.0.5", "172.31.255.1")) {
            val origin = "http://$host:3000"
            assertEquals(origin, Protocol.origin(origin, true))
            assertThrows(IllegalArgumentException::class.java) { Protocol.origin(origin, false) }
        }
        assertEquals("http://192.168.1.10/api", Protocol.origin("http://192.168.1.10/api", true))
        for (bad in listOf("http://example.com", "http://8.8.8.8", "http://172.32.0.1", "http://192.168.1.10/a/../b", "http://user@192.168.1.10", "http://192.168.1.10:99999")) {
            assertThrows(IllegalArgumentException::class.java) { Protocol.origin(bad, true) }
        }
    }
}
