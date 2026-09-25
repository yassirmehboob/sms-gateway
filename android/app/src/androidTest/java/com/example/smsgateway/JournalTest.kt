package com.example.smsgateway

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.room.Room
import com.example.smsgateway.data.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class JournalTest {
    @Test fun migrationRetainsAttemptsAndInboundAcknowledgementCannotClearNewStop() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "migration-test-${UUID.randomUUID()}.db"
        try {
            val legacy = context.openOrCreateDatabase(name, 0, null)
            try {
                legacy.execSQL("CREATE TABLE attempts (jobId TEXT NOT NULL PRIMARY KEY, leaseId TEXT NOT NULL, bodyHash TEXT NOT NULL, subscriptionId INTEGER NOT NULL, startedAt INTEGER NOT NULL, callbackId TEXT NOT NULL)")
                legacy.execSQL("CREATE TABLE events (eventId TEXT NOT NULL PRIMARY KEY, jobId TEXT NOT NULL, leaseId TEXT NOT NULL, type TEXT NOT NULL, createdAt INTEGER NOT NULL, blocked INTEGER NOT NULL)")
                legacy.execSQL("INSERT INTO attempts VALUES ('job','lease','hash',1,1,'callback')")
                legacy.version = 1
            } finally { legacy.close() }
            val migrated = Room.databaseBuilder(context, Journal::class.java, name).addMigrations(Journal.MIGRATION_1_2).build()
            try {
                assertEquals(1, migrated.dao().count())
                assertEquals(-1L, migrated.dao().reserve(Attempt("job", "new-lease", "hash", 1, 2, "new-callback")))
                val first = InboundControl("start", "encrypted", 1)
                assertNotEquals(-1L, migrated.dao().addControl(first))
                migrated.dao().acknowledgeControl("start")
                assertEquals(-1L, migrated.dao().addControl(first))
                assertTrue(migrated.dao().pendingControls().isEmpty())
                migrated.dao().setLocalRecipient(LocalRecipient("numberHash", true, "new-stop"))
                migrated.dao().reconcileLocal("numberHash", "old-start", false)
                assertEquals(true, migrated.dao().locallyBlocked("numberHash"))
                migrated.dao().addControl(InboundControl("new-stop", "encrypted", 2))
                migrated.dao().reconcileApprovedRecipient("numberHash")
                assertEquals(true, migrated.dao().locallyBlocked("numberHash"))
                migrated.dao().acknowledgeControl("new-stop")
                migrated.dao().reconcileApprovedRecipient("numberHash")
                assertEquals(false, migrated.dao().locallyBlocked("numberHash"))
            } finally { migrated.close() }
        } finally { context.deleteDatabase(name) }
    }
    @Test fun reopeningDatabaseDoesNotPermitAnotherAttempt() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "journal-test-${UUID.randomUUID()}.db"
        val attempt = Attempt(UUID.randomUUID().toString(), UUID.randomUUID().toString(), "hash", 1, 1, "callback")
        fun open() = Room.databaseBuilder(context, Journal::class.java, name).build()
        try {
            val first = open()
            try { assertNotEquals(-1L, first.dao().reserve(attempt)) } finally { first.close() }
            val reopened = open()
            try { assertEquals(-1L, reopened.dao().reserve(attempt.copy(leaseId = UUID.randomUUID().toString()))); assertEquals(1, reopened.dao().count()) } finally { reopened.close() }
        } finally { context.deleteDatabase(name) }
    }
}
