package com.example.smsgateway

import com.example.smsgateway.telephony.InboundParser
import org.junit.Assert.*
import org.junit.Test

class InboundParserTest {
    @Test fun onlyStandaloneStopAndStartAreCommands() {
        assertEquals("STOP", InboundParser.command(" stop\n"))
        assertEquals("START", InboundParser.command("Start"))
        for (text in listOf("hello", "STOP now", "START STOP", "", "STOP!")) assertNull(InboundParser.command(text))
    }
    @Test fun onlyPakistanMobileSendersAreNormalized() {
        for (number in listOf("+923001234567", "923001234567", "03001234567")) assertEquals("+923001234567", InboundParser.number(number))
        for (number in listOf("BANK", "12345", "+12025550123", "+922112345678", "call 03001234567")) assertNull(InboundParser.number(number))
    }
}
