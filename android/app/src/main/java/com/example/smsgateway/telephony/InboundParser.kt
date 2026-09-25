package com.example.smsgateway.telephony

import java.util.Locale

object InboundParser {
    fun command(body: String): String? = body.trim().uppercase(Locale.ROOT).takeIf { it == "STOP" || it == "START" }
    fun number(raw: String): String? {
        val text = raw.trim()
        return when {
            text.matches(Regex("\\+923[0-9]{9}")) -> text
            text.matches(Regex("923[0-9]{9}")) -> "+$text"
            text.matches(Regex("03[0-9]{9}")) -> "+92${text.drop(1)}"
            else -> null
        }
    }
}
