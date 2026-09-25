package com.example.smsgateway.data

import android.content.Context
import androidx.room.*
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

// Outbound rows never persist numbers/bodies; inbound command payloads are encrypted separately.
@Entity(tableName = "attempts")
data class Attempt(@PrimaryKey val jobId: String, val leaseId: String, val bodyHash: String, val subscriptionId: Int, val startedAt: Long, val callbackId: String)
@Entity(tableName = "events")
data class DeviceEvent(@PrimaryKey val eventId: String, val jobId: String, val leaseId: String, val type: String, val createdAt: Long, val blocked: Boolean = false)
@Entity(tableName = "inbound_controls")
data class InboundControl(@PrimaryKey val eventId: String, val encryptedPayload: String?, val createdAt: Long, val blocked: Boolean = false)
@Entity(tableName = "local_recipients")
data class LocalRecipient(@PrimaryKey val numberHash: String, val blocked: Boolean, val lastEventId: String)
@Dao interface JournalDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE) fun reserve(attempt: Attempt): Long
    @Query("SELECT * FROM attempts WHERE jobId=:id") fun attempt(id: String): Attempt?
    @Insert(onConflict = OnConflictStrategy.IGNORE) fun addEvent(event: DeviceEvent): Long
    @Query("SELECT * FROM events WHERE blocked=0 ORDER BY createdAt,eventId LIMIT 20") fun pending(): List<DeviceEvent>
    @Query("DELETE FROM events WHERE eventId=:id") fun acknowledge(id: String)
    @Query("UPDATE events SET blocked=1 WHERE eventId=:id") fun block(id: String)
    @Query("SELECT COUNT(*) FROM attempts") fun count(): Int
    @Query("SELECT COUNT(*) FROM events WHERE blocked=1") fun blockedCount(): Int
    @Insert(onConflict = OnConflictStrategy.IGNORE) fun addControl(event: InboundControl): Long
    @Query("SELECT * FROM inbound_controls WHERE encryptedPayload IS NOT NULL AND blocked=0 ORDER BY createdAt,rowid LIMIT 20") fun pendingControls(): List<InboundControl>
    @Query("UPDATE inbound_controls SET encryptedPayload=NULL WHERE eventId=:id") fun acknowledgeControl(id: String)
    @Query("UPDATE inbound_controls SET blocked=1 WHERE eventId=:id") fun blockControl(id: String)
    @Query("SELECT COUNT(*) FROM inbound_controls WHERE encryptedPayload IS NOT NULL") fun controlCount(): Int
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun setLocalRecipient(recipient: LocalRecipient)
    @Query("SELECT blocked FROM local_recipients WHERE numberHash=:hash") fun locallyBlocked(hash: String): Boolean?
    @Query("UPDATE local_recipients SET blocked=:blocked WHERE numberHash=:hash AND lastEventId=:eventId") fun reconcileLocal(hash: String, eventId: String, blocked: Boolean)
    @Query("UPDATE local_recipients SET blocked=0 WHERE numberHash=:hash AND lastEventId IN (SELECT eventId FROM inbound_controls WHERE encryptedPayload IS NULL)") fun reconcileApprovedRecipient(hash: String)
}
@Database(entities = [Attempt::class, DeviceEvent::class, InboundControl::class, LocalRecipient::class], version = 2, exportSchema = true)
abstract class Journal : RoomDatabase() {
    abstract fun dao(): JournalDao
    companion object {
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS inbound_controls (eventId TEXT NOT NULL PRIMARY KEY, encryptedPayload TEXT, createdAt INTEGER NOT NULL, blocked INTEGER NOT NULL)")
                db.execSQL("CREATE TABLE IF NOT EXISTS local_recipients (numberHash TEXT NOT NULL PRIMARY KEY, blocked INTEGER NOT NULL, lastEventId TEXT NOT NULL)")
            }
        }
        @Volatile private var instance: Journal? = null
        fun get(context: Context): Journal = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context.applicationContext, Journal::class.java, "gateway-journal.db").addMigrations(MIGRATION_1_2).build().also { instance = it }
        }
    }
}
