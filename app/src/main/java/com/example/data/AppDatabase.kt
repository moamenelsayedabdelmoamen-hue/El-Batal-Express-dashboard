package com.example.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [CaptainEntity::class, OrderEntity::class, ShiftEntity::class, DailyWalletEntity::class],
    version = 12,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun captainDao(): CaptainDao
    abstract fun orderDao(): OrderDao
    abstract fun shiftDao(): ShiftDao
    abstract fun dailyWalletDao(): DailyWalletDao

    companion object {
        private fun ensureColumnExists(
            db: SupportSQLiteDatabase,
            tableName: String,
            columnName: String,
            columnDefinitionSql: String
        ) {
            var exists = false
            db.query("PRAGMA table_info($tableName)").use { cursor ->
                val nameIndex = cursor.getColumnIndex("name")
                while (cursor.moveToNext()) {
                    if (nameIndex >= 0 && cursor.getString(nameIndex) == columnName) {
                        exists = true
                        break
                    }
                }
            }
            if (!exists) {
                db.execSQL("ALTER TABLE $tableName ADD COLUMN $columnName $columnDefinitionSql")
            }
        }

        val MIGRATION_7_8 = object : Migration(7, 8) {
            override fun migrate(db: SupportSQLiteDatabase) {
                ensureColumnExists(db, "orders", "cancelledAt", "INTEGER NOT NULL DEFAULT 0")
                ensureColumnExists(db, "orders", "cancellationReason", "TEXT NOT NULL DEFAULT ''")
            }
        }

        val MIGRATION_8_9 = object : Migration(8, 9) {
            override fun migrate(db: SupportSQLiteDatabase) {
                ensureColumnExists(db, "orders", "orderCode", "TEXT NOT NULL DEFAULT ''")
            }
        }

        val MIGRATION_9_10 = object : Migration(9, 10) {
            override fun migrate(db: SupportSQLiteDatabase) {
                ensureColumnExists(db, "orders", "merchantId", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "orders", "storeLocationUrl", "TEXT NOT NULL DEFAULT ''")
            }
        }

        val MIGRATION_10_11 = object : Migration(10, 11) {
            override fun migrate(db: SupportSQLiteDatabase) {
                ensureColumnExists(db, "captain_profile", "address", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "captain_profile", "accountType", "TEXT NOT NULL DEFAULT 'captain'")
                ensureColumnExists(db, "captain_profile", "availabilityStatus", "TEXT NOT NULL DEFAULT 'offline'")
                ensureColumnExists(db, "captain_profile", "shiftStatus", "TEXT NOT NULL DEFAULT 'outside_shift'")
            }
        }

        val MIGRATION_11_12 = object : Migration(11, 12) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `captain_shifts` (
                        `id` TEXT NOT NULL,
                        `captainUid` TEXT NOT NULL,
                        `dayOfWeek` INTEGER NOT NULL,
                        `dayNameArabic` TEXT NOT NULL,
                        `startTime` TEXT NOT NULL,
                        `endTime` TEXT NOT NULL,
                        `isDayOff` INTEGER NOT NULL,
                        `notes` TEXT NOT NULL,
                        `updatedAt` INTEGER NOT NULL,
                        PRIMARY KEY(`id`)
                    )
                    """.trimIndent()
                )
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `daily_wallet_records` (
                        `dayKey` TEXT NOT NULL,
                        `captainUid` TEXT NOT NULL,
                        `periodStartMs` INTEGER NOT NULL,
                        `periodEndMs` INTEGER NOT NULL,
                        `walletBalance` REAL NOT NULL,
                        `deliveredOrdersCount` INTEGER NOT NULL,
                        `totalOrdersCount` INTEGER NOT NULL,
                        `isClosed` INTEGER NOT NULL,
                        `closedAt` INTEGER NOT NULL,
                        `updatedAt` INTEGER NOT NULL,
                        PRIMARY KEY(`dayKey`)
                    )
                    """.trimIndent()
                )
                ensureColumnExists(db, "orders", "orderCode", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "orders", "storePhone", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "orders", "storeImage", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "orders", "merchantId", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "orders", "storeLocationUrl", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "orders", "restaurantLatitude", "REAL")
                ensureColumnExists(db, "orders", "restaurantLongitude", "REAL")
                ensureColumnExists(db, "orders", "receiptImagePath", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "orders", "receiptUploadedAt", "INTEGER NOT NULL DEFAULT 0")
                ensureColumnExists(db, "orders", "receiptUploadedBy", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "orders", "orderDataEnteredAt", "INTEGER NOT NULL DEFAULT 0")
                ensureColumnExists(db, "orders", "offerExpiresAt", "INTEGER NOT NULL DEFAULT 0")
                ensureColumnExists(db, "orders", "merchantConfirmed", "INTEGER NOT NULL DEFAULT 0")
                ensureColumnExists(db, "orders", "rejectionReason", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "orders", "etaMinutes", "INTEGER NOT NULL DEFAULT 15")
                ensureColumnExists(db, "orders", "completedAt", "INTEGER NOT NULL DEFAULT 0")
                ensureColumnExists(db, "orders", "cancelledAt", "INTEGER NOT NULL DEFAULT 0")
                ensureColumnExists(db, "orders", "cancellationReason", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "captain_profile", "profileImagePath", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "captain_profile", "idFrontImagePath", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "captain_profile", "idBackImagePath", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "captain_profile", "licenseImagePath", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "captain_profile", "address", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "captain_profile", "accountType", "TEXT NOT NULL DEFAULT 'captain'")
                ensureColumnExists(db, "captain_profile", "role", "TEXT NOT NULL DEFAULT 'captain'")
                ensureColumnExists(db, "captain_profile", "status", "TEXT NOT NULL DEFAULT 'active'")
                ensureColumnExists(db, "captain_profile", "availabilityStatus", "TEXT NOT NULL DEFAULT 'offline'")
                ensureColumnExists(db, "captain_profile", "shiftStatus", "TEXT NOT NULL DEFAULT 'outside_shift'")
            }
        }

        val ALL_MIGRATIONS: Array<Migration> = arrayOf(
            MIGRATION_7_8,
            MIGRATION_8_9,
            MIGRATION_9_10,
            MIGRATION_10_11,
            MIGRATION_11_12
        )

        @Volatile
        private var INSTANCE: AppDatabase? = null

        fun getDatabase(context: Context): AppDatabase {
            return INSTANCE ?: synchronized(this) {
                val instance = Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "elbatal_captain_db"
                )
                    .addMigrations(*ALL_MIGRATIONS)
                    .build()
                INSTANCE = instance
                instance
            }
        }
    }
}
