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
                db.execSQL("ALTER TABLE orders ADD COLUMN cancelledAt INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE orders ADD COLUMN cancellationReason TEXT NOT NULL DEFAULT ''")
            }
        }

        val MIGRATION_8_9 = object : Migration(8, 9) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE orders ADD COLUMN orderCode TEXT NOT NULL DEFAULT ''")
            }
        }

        val MIGRATION_9_10 = object : Migration(9, 10) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE orders ADD COLUMN merchantId TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE orders ADD COLUMN storeLocationUrl TEXT NOT NULL DEFAULT ''")
            }
        }

        val MIGRATION_10_11 = object : Migration(10, 11) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE captain_profile ADD COLUMN address TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE captain_profile ADD COLUMN accountType TEXT NOT NULL DEFAULT 'captain'")
                db.execSQL("ALTER TABLE captain_profile ADD COLUMN availabilityStatus TEXT NOT NULL DEFAULT 'offline'")
                db.execSQL("ALTER TABLE captain_profile ADD COLUMN shiftStatus TEXT NOT NULL DEFAULT 'outside_shift'")
            }
        }

        val MIGRATION_11_12 = object : Migration(11, 12) {
            override fun migrate(db: SupportSQLiteDatabase) {
                ensureColumnExists(db, "orders", "orderCode", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "orders", "merchantId", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "orders", "storeLocationUrl", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "orders", "restaurantLatitude", "REAL")
                ensureColumnExists(db, "orders", "restaurantLongitude", "REAL")
                ensureColumnExists(db, "orders", "offerExpiresAt", "INTEGER NOT NULL DEFAULT 0")
                ensureColumnExists(db, "orders", "offerId", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "orders", "cancelledAt", "INTEGER NOT NULL DEFAULT 0")
                ensureColumnExists(db, "orders", "cancellationReason", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "captain_profile", "address", "TEXT NOT NULL DEFAULT ''")
                ensureColumnExists(db, "captain_profile", "accountType", "TEXT NOT NULL DEFAULT 'captain'")
                ensureColumnExists(db, "captain_profile", "availabilityStatus", "TEXT NOT NULL DEFAULT 'offline'")
                ensureColumnExists(db, "captain_profile", "shiftStatus", "TEXT NOT NULL DEFAULT 'outside_shift'")
            }
        }

        @Volatile
        private var INSTANCE: AppDatabase? = null

        fun getDatabase(context: Context): AppDatabase {
            return INSTANCE ?: synchronized(this) {
                val instance = Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "elbatal_captain_db"
                )
                    .addMigrations(
                        MIGRATION_7_8,
                        MIGRATION_8_9,
                        MIGRATION_9_10,
                        MIGRATION_10_11,
                        MIGRATION_11_12
                    )
                    .fallbackToDestructiveMigration()
                    .build()
                INSTANCE = instance
                instance
            }
        }
    }
}
