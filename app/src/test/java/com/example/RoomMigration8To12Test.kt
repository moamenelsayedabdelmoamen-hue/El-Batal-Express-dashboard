package com.example

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.example.data.AppDatabase
import com.example.data.OrderEntity
import com.example.data.OrderStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * Verifies non-destructive Room migration from legacy schema v8 to v12:
 * - Preserves all rows in orders, captain_profile, captain_shifts, and daily_wallet_records.
 * - Ensures zero duplicate columns and exact Room schema validation without destructive fallback.
 * - Verifies OrderDao.upsertByFirestoreId preserves existing valid values on partial updates.
 * - Verifies deleteAllPendingOrders removes only PENDING cache rows and preserves active/delivered rows.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class RoomMigration8To12Test {

    private lateinit var context: Context
    private lateinit var dbFile: File
    private var appDb: AppDatabase? = null

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        dbFile = File(context.cacheDir, "migration_v8_to_v12_${System.nanoTime()}.db")
        if (dbFile.exists()) dbFile.delete()
    }

    @After
    fun tearDown() {
        appDb?.close()
        appDb = null
        if (dbFile.exists()) dbFile.delete()
        File("${dbFile.absolutePath}-wal").delete()
        File("${dbFile.absolutePath}-shm").delete()
    }

    private fun seedLegacyVersion8Database() {
        val rawDb = SQLiteDatabase.openOrCreateDatabase(dbFile, null)
        rawDb.use { db ->
            // Legacy v8 captain_profile (missing address, accountType, availabilityStatus, shiftStatus)
            db.execSQL(
                """
                CREATE TABLE `captain_profile` (
                    `id` INTEGER NOT NULL,
                    `uid` TEXT NOT NULL,
                    `fullName` TEXT NOT NULL,
                    `phoneNumber` TEXT NOT NULL,
                    `email` TEXT NOT NULL,
                    `password` TEXT NOT NULL,
                    `avatarUri` TEXT NOT NULL,
                    `avatarPresetIndex` INTEGER NOT NULL,
                    `nationalIdUrl` TEXT NOT NULL,
                    `licenseUrl` TEXT NOT NULL,
                    `profileImagePath` TEXT NOT NULL,
                    `idFrontImagePath` TEXT NOT NULL,
                    `idBackImagePath` TEXT NOT NULL,
                    `licenseImagePath` TEXT NOT NULL,
                    `role` TEXT NOT NULL,
                    `status` TEXT NOT NULL,
                    `vehicleType` TEXT NOT NULL,
                    `licensePlate` TEXT NOT NULL,
                    `rating` REAL NOT NULL,
                    `totalOrdersCount` INTEGER NOT NULL,
                    `walletBalance` REAL NOT NULL,
                    `isOnline` INTEGER NOT NULL,
                    `isLoggedIn` INTEGER NOT NULL,
                    PRIMARY KEY(`id`)
                )
                """.trimIndent()
            )

            // Legacy v8 orders (already has restaurantLatitude, restaurantLongitude, offerExpiresAt,
            // cancelledAt, cancellationReason; missing orderCode, merchantId, storeLocationUrl)
            db.execSQL(
                """
                CREATE TABLE `orders` (
                    `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                    `orderNumber` TEXT NOT NULL,
                    `customerName` TEXT NOT NULL,
                    `customerPhone` TEXT NOT NULL,
                    `storeName` TEXT NOT NULL,
                    `storePhone` TEXT NOT NULL,
                    `storeImage` TEXT NOT NULL,
                    `pickupAddress` TEXT NOT NULL,
                    `deliveryAddress` TEXT NOT NULL,
                    `restaurantLatitude` REAL,
                    `restaurantLongitude` REAL,
                    `itemsSummary` TEXT NOT NULL,
                    `itemsCount` INTEGER NOT NULL,
                    `orderTotalAmount` REAL NOT NULL,
                    `deliveryFee` REAL NOT NULL,
                    `distanceKm` REAL NOT NULL,
                    `status` TEXT NOT NULL,
                    `createdAt` INTEGER NOT NULL,
                    `notes` TEXT NOT NULL,
                    `deliveryPin` TEXT NOT NULL,
                    `firestoreDocId` TEXT NOT NULL,
                    `captainId` TEXT NOT NULL,
                    `acceptedAt` INTEGER NOT NULL,
                    `orderImageUrl` TEXT NOT NULL,
                    `receiptImagePath` TEXT NOT NULL,
                    `receiptUploadedAt` INTEGER NOT NULL,
                    `receiptUploadedBy` TEXT NOT NULL,
                    `orderDataEnteredAt` INTEGER NOT NULL,
                    `offerExpiresAt` INTEGER NOT NULL,
                    `merchantConfirmed` INTEGER NOT NULL,
                    `rejectionReason` TEXT NOT NULL,
                    `etaMinutes` INTEGER NOT NULL,
                    `completedAt` INTEGER NOT NULL,
                    `cancelledAt` INTEGER NOT NULL,
                    `cancellationReason` TEXT NOT NULL
                )
                """.trimIndent()
            )

            db.execSQL(
                """
                CREATE TABLE `captain_shifts` (
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
                CREATE TABLE `daily_wallet_records` (
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

            // Seed v8 rows across all 4 tables
            db.execSQL(
                """
                INSERT INTO captain_profile VALUES (
                    1, 'cap_uid_8', 'كابتن كريم', '01099887766', 'karim@elbatal.com', '',
                    '', 2, '', '', 'captains/cap_uid_8/profile/profile.jpg',
                    'captains/cap_uid_8/documents/id_front.jpg',
                    'captains/cap_uid_8/documents/id_back.jpg',
                    '', 'captain', 'active', 'دراجة نارية', 'س ط ع 4 5 6',
                    4.9, 42, 650.5, 1, 1
                )
                """.trimIndent()
            )

            db.execSQL(
                """
                INSERT INTO orders VALUES (
                    101, 'ORD-V8-DEL', 'أحمد علي', '01112223334', 'مطعم البركة', '01200001111', '',
                    'مدينة نصر', 'المعادي', 30.0561, 31.3301, '2 شاورما', 2, 180.0, 35.0, 4.2,
                    'DELIVERED', 1730000000000, 'بدون بصل', '1234', 'doc_v8_del', 'cap_uid_8',
                    1730000010000, '', 'orders/doc_v8_del/receipts/r1.jpg', 1730000050000, 'cap_uid_8',
                    1730000050000, 1730000060000, 1, '', 15, 1730000900000, 0, ''
                )
                """.trimIndent()
            )

            db.execSQL(
                """
                INSERT INTO orders VALUES (
                    102, 'ORD-V8-PEND', 'سارة حسن', '01012345678', 'بيتزا السلطان', '01299998888', '',
                    'مصر الجديدة', 'العباسية', 30.0911, 31.3242, 'بيتزا كبيرة', 1, 210.0, 30.0, 2.5,
                    'PENDING', 1730001000000, '', '5678', 'doc_v8_pend', '',
                    0, '', '', 0, '', 0, 1730001060000, 0, '', 12, 0, 0, ''
                )
                """.trimIndent()
            )

            db.execSQL(
                """
                INSERT INTO captain_shifts VALUES (
                    'cap_uid_8_day_1', 'cap_uid_8', 1, 'الأحد', '12:00', '22:00', 0, 'شفت أساسي', 1730000000000
                )
                """.trimIndent()
            )

            db.execSQL(
                """
                INSERT INTO daily_wallet_records VALUES (
                    '2026-11-17', 'cap_uid_8', 1763377200000, 1763463599999, 420.0, 12, 13, 1, 1763463600000, 1763463600000
                )
                """.trimIndent()
            )

            db.version = 8
        }
    }

    @Test
    fun migrateVersion8To12_preservesAllFourTablesWithoutDataLossOrSchemaMismatch() = runTest {
        seedLegacyVersion8Database()

        val db = Room.databaseBuilder(context, AppDatabase::class.java, dbFile.absolutePath)
            .addMigrations(*AppDatabase.ALL_MIGRATIONS)
            .allowMainThreadQueries()
            .build()
        appDb = db

        // Verify captain_profile migrated safely with defaults and preserved legacy values
        val captain = db.captainDao().getCaptain()
        assertNotNull("Captain profile row must survive v8 -> v12 migration", captain)
        assertEquals("cap_uid_8", captain?.uid)
        assertEquals("كابتن كريم", captain?.fullName)
        assertEquals(650.5, captain?.walletBalance ?: 0.0, 0.001)
        assertEquals(42, captain?.totalOrdersCount)
        assertEquals("captain", captain?.accountType)
        assertEquals("", captain?.address)
        assertEquals("offline", captain?.availabilityStatus)
        assertEquals("outside_shift", captain?.shiftStatus)

        // Verify orders survived with existing coordinates & offerExpiresAt intact
        val orders = db.orderDao().getAllOrdersFlow().first()
        assertEquals(2, orders.size)
        val delivered = orders.first { it.firestoreDocId == "doc_v8_del" }
        assertEquals(OrderStatus.DELIVERED, delivered.status)
        assertEquals(30.0561, delivered.restaurantLatitude ?: 0.0, 0.0001)
        assertEquals(31.3301, delivered.restaurantLongitude ?: 0.0, 0.0001)
        assertEquals(1730000060000L, delivered.offerExpiresAt)
        assertEquals("", delivered.orderCode)
        assertEquals("", delivered.merchantId)
        assertEquals("", delivered.storeLocationUrl)

        // Verify shifts & daily_wallet_records preserved verbatim
        val shifts = db.shiftDao().getAllShiftsFlow().first()
        assertEquals(1, shifts.size)
        assertEquals("12:00", shifts[0].startTime)
        assertEquals("22:00", shifts[0].endTime)

        val wallets = db.dailyWalletDao().getAllDailyWallets()
        assertEquals(1, wallets.size)
        assertEquals("2026-11-17", wallets[0].dayKey)
        assertEquals(420.0, wallets[0].walletBalance, 0.001)
        assertEquals(12, wallets[0].deliveredOrdersCount)
        assertTrue(wallets[0].isClosed)

        // Verify zero duplicate column names in PRAGMA table_info across orders & captain_profile
        val sqlite = db.openHelper.readableDatabase
        for (table in listOf("orders", "captain_profile", "captain_shifts", "daily_wallet_records")) {
            val cols = mutableListOf<String>()
            sqlite.query("PRAGMA table_info($table)").use { c ->
                val idx = c.getColumnIndex("name")
                while (c.moveToNext()) cols.add(c.getString(idx))
            }
            assertEquals("Duplicate column detected in $table", cols.size, cols.toSet().size)
        }
    }

    @Test
    fun upsertByFirestoreId_preservesValidFieldsOnPartialUpdate_andDeletePendingKeepsActiveOrders() = runTest {
        val db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        appDb = db
        val dao = db.orderDao()

        // 1. Insert rich order with full metadata
        val initialId = dao.upsertByFirestoreId(
            OrderEntity(
                orderNumber = "ORD-100",
                orderCode = "ELB-7788",
                customerName = "محمود",
                customerPhone = "01011112222",
                storeName = "مطعم الأصيل",
                storePhone = "01222223333",
                pickupAddress = "شارع التحرير",
                deliveryAddress = "الدقي",
                merchantId = "merch_99",
                storeLocationUrl = "https://maps.google.com/?q=30.0444,31.2357",
                restaurantLatitude = 30.0444,
                restaurantLongitude = 31.2357,
                itemsSummary = "وجبة مشاوي",
                itemsCount = 1,
                orderTotalAmount = 250.0,
                deliveryFee = 35.0,
                distanceKm = 3.1,
                status = OrderStatus.ACCEPTED,
                firestoreDocId = "fs_ord_100",
                captainId = "cap_1",
                offerExpiresAt = 1765000060000L
            )
        )

        // 2. Partial/stale update arrives with empty orderCode/merchantId/storeLocationUrl and null coords
        val updatedId = dao.upsertByFirestoreId(
            OrderEntity(
                orderNumber = "ORD-100",
                orderCode = "",
                customerName = "محمود",
                customerPhone = "01011112222",
                storeName = "مطعم الأصيل",
                pickupAddress = "شارع التحرير",
                deliveryAddress = "الدقي",
                merchantId = "",
                storeLocationUrl = "",
                restaurantLatitude = null,
                restaurantLongitude = null,
                itemsSummary = "وجبة مشاوي",
                itemsCount = 1,
                orderTotalAmount = 250.0,
                deliveryFee = 35.0,
                distanceKm = 3.1,
                status = OrderStatus.AT_STORE,
                firestoreDocId = "fs_ord_100",
                captainId = "",
                offerExpiresAt = 0L
            )
        )

        assertEquals(initialId, updatedId)
        val merged = dao.findByFirestoreDocId("fs_ord_100")
        assertNotNull(merged)
        assertEquals(OrderStatus.AT_STORE, merged?.status)
        assertEquals("ELB-7788", merged?.orderCode)
        assertEquals("ELB-7788", merged?.cleanOrderCode)
        assertEquals(1765000060000L, merged?.offerExpiresAt)
        assertEquals("merch_99", merged?.merchantId)
        assertEquals("https://maps.google.com/?q=30.0444,31.2357", merged?.storeLocationUrl)
        assertEquals("https://maps.google.com/?q=30.0444,31.2357", merged?.effectiveStoreLocationUrl)
        assertEquals(30.0444, merged?.restaurantLatitude ?: 0.0, 0.0001)
        assertEquals(31.2357, merged?.restaurantLongitude ?: 0.0, 0.0001)
        assertEquals("cap_1", merged?.captainId)

        // 3. Insert a local PENDING order and verify deleteAllPendingOrders leaves ACCEPTED/AT_STORE intact
        dao.upsertByFirestoreId(
            OrderEntity(
                orderNumber = "ORD-PEND",
                customerName = "عميل",
                customerPhone = "01000000000",
                storeName = "كشري التحرير",
                pickupAddress = "وسط البلد",
                deliveryAddress = "الزمالك",
                itemsSummary = "كشري",
                itemsCount = 1,
                orderTotalAmount = 80.0,
                deliveryFee = 20.0,
                distanceKm = 2.0,
                status = OrderStatus.PENDING,
                firestoreDocId = "fs_ord_pend"
            )
        )
        dao.deleteAllPendingOrders()
        val remaining = dao.getAllOrdersFlow().first()
        assertEquals(1, remaining.size)
        assertEquals("fs_ord_100", remaining[0].firestoreDocId)
    }
}
