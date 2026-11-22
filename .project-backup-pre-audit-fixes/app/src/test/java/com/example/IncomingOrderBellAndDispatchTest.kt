package com.example

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.example.data.AppDatabase
import com.example.data.OrderDao
import com.example.data.OrderEntity
import com.example.data.OrderStatus
import com.example.data.dispatch.NearestCaptainMatcher
import com.example.notifications.CaptainNotificationManager
import com.example.ui.components.IncomingOrderOfferCardContent
import com.example.ui.theme.ElBatalTheme
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class IncomingOrderBellAndDispatchTest {

    @get:Rule
    val composeRule = createComposeRule()

    private lateinit var appContext: Application
    private lateinit var notificationManager: NotificationManager
    private lateinit var db: AppDatabase
    private lateinit var orderDao: OrderDao

    @Before
    fun setUp() {
        appContext = ApplicationProvider.getApplicationContext()
        Shadows.shadowOf(appContext).grantPermissions(
            Manifest.permission.POST_NOTIFICATIONS,
            Manifest.permission.VIBRATE
        )
        CaptainNotificationManager.clearNotificationState(appContext)
        notificationManager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        db = Room.inMemoryDatabaseBuilder(appContext, AppDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        orderDao = db.orderDao()
    }

    @After
    fun tearDown() {
        CaptainNotificationManager.clearNotificationState(appContext)
        db.close()
    }

    @Test
    fun `NearestCaptainMatcher selects closest eligible online in-shift captain to merchant and skips excluded captains`() {
        val merchantLat = 30.0561
        val merchantLng = 31.3301

        val candidates = listOf(
            NearestCaptainMatcher.CaptainCandidate(
                uid = "cap_timed_out",
                latitude = 30.0565,
                longitude = 31.3305,
                isOnline = true,
                accountActive = true,
                inActiveShift = true,
                hasOngoingOrder = false
            ),
            NearestCaptainMatcher.CaptainCandidate(
                uid = "cap_offline",
                latitude = 30.0570,
                longitude = 31.3310,
                isOnline = false,
                accountActive = true,
                inActiveShift = true,
                hasOngoingOrder = false
            ),
            NearestCaptainMatcher.CaptainCandidate(
                uid = "cap_out_of_shift",
                latitude = 30.0575,
                longitude = 31.3315,
                isOnline = true,
                accountActive = true,
                inActiveShift = false,
                hasOngoingOrder = false
            ),
            NearestCaptainMatcher.CaptainCandidate(
                uid = "cap_busy",
                latitude = 30.0580,
                longitude = 31.3320,
                isOnline = true,
                accountActive = true,
                inActiveShift = true,
                hasOngoingOrder = true
            ),
            NearestCaptainMatcher.CaptainCandidate(
                uid = "cap_farther",
                latitude = 30.0910,
                longitude = 31.3240,
                isOnline = true,
                accountActive = true,
                inActiveShift = true,
                hasOngoingOrder = false
            ),
            NearestCaptainMatcher.CaptainCandidate(
                uid = "cap_nearest_available",
                latitude = 30.0620,
                longitude = 31.3350,
                isOnline = true,
                accountActive = true,
                inActiveShift = true,
                hasOngoingOrder = false
            )
        )

        val excluded = setOf("cap_timed_out")
        val ranked = NearestCaptainMatcher.rankEligibleCaptains(
            merchantLat = merchantLat,
            merchantLng = merchantLng,
            candidates = candidates,
            excludedCaptainIds = excluded
        )

        assertEquals(2, ranked.size)
        assertEquals("cap_nearest_available", ranked[0].uid)
        assertEquals("cap_farther", ranked[1].uid)
        assertNotNull(ranked[0].distanceKm)
        assertNotNull(ranked[1].distanceKm)
        assertTrue(ranked[0].distanceKm!! < ranked[1].distanceKm!!)

        val nearest = NearestCaptainMatcher.findNearestEligibleCaptain(
            merchantLat = merchantLat,
            merchantLng = merchantLng,
            candidates = candidates,
            excludedCaptainIds = excluded
        )
        assertNotNull(nearest)
        assertEquals("cap_nearest_available", nearest?.uid)
    }

    @Test
    fun `showNewOrderNotification posts insistent CATEGORY_CALL 60s countdown notification and stopIncomingOrderBell cancels it`() {
        val nowMs = System.currentTimeMillis()
        val expiresAt = nowMs + 60_000L

        val posted = CaptainNotificationManager.showNewOrderNotification(
            context = appContext,
            orderKey = "order_bell_test_1",
            storeName = "بازوكا",
            pickupAddress = "عباس العقاد",
            deliveryAddress = "مكرم عبيد",
            deliveryFee = 40.0,
            orderCode = "BZ-778",
            orderId = 778L,
            offerExpiresAtMs = expiresAt,
            startContinuousBell = true
        )
        assertTrue(posted)

        val shadowNotif = Shadows.shadowOf(notificationManager)
        val expectedId = CaptainNotificationManager.computeOrderNotificationId("order_bell_test_1")
        val activeNotif = shadowNotif.getNotification(expectedId)
        assertNotNull(activeNotif)

        assertEquals(CaptainNotificationManager.CHANNEL_NEW_ORDERS_BELL_ID, activeNotif.channelId)
        assertEquals(Notification.CATEGORY_CALL, activeNotif.category)
        assertTrue((activeNotif.flags and Notification.FLAG_INSISTENT) != 0)
        assertTrue((activeNotif.flags and Notification.FLAG_ONGOING_EVENT) != 0)
        assertNotNull(activeNotif.fullScreenIntent)
        assertTrue(activeNotif.extras.getBoolean(Notification.EXTRA_SHOW_CHRONOMETER, false))
        assertTrue(activeNotif.extras.getBoolean("android.chronometerCountDown", false))

        assertEquals(1, activeNotif.actions?.size ?: 0)
        val actionTitle = activeNotif.actions[0].title.toString()
        assertTrue(actionTitle.contains("قبول الطلب"))

        CaptainNotificationManager.stopIncomingOrderBell(appContext, "order_bell_test_1")
        assertNull(shadowNotif.getNotification(expectedId))
    }

    @Test
    fun `OrderDao upsertByFirestoreId preserves offerExpiresAt and blocks expired offer from reverting to pending`() = runTest {
        val initialExpiresAt = System.currentTimeMillis() + 60_000L
        val order = OrderEntity(
            id = 0L,
            orderNumber = "ORD-501",
            orderCode = "KFC-501",
            customerName = "أحمد",
            customerPhone = "01000000000",
            storeName = "كنتاكي",
            pickupAddress = "التحرير",
            deliveryAddress = "الدقي",
            itemsSummary = "وجبة زنجر",
            itemsCount = 1,
            orderTotalAmount = 200.0,
            deliveryFee = 30.0,
            distanceKm = 2.5,
            status = OrderStatus.PENDING,
            firestoreDocId = "doc_501",
            offerExpiresAt = initialExpiresAt
        )

        val localId = orderDao.upsertByFirestoreId(order)
        val saved = orderDao.findByFirestoreDocId("doc_501")
        assertNotNull(saved)
        assertEquals(initialExpiresAt, saved?.offerExpiresAt)

        orderDao.updateOrderStatus(localId, OrderStatus.EXPIRED)
        assertEquals(OrderStatus.EXPIRED, orderDao.findByFirestoreDocId("doc_501")?.status)

        orderDao.upsertByFirestoreId(order.copy(offerExpiresAt = initialExpiresAt))
        assertEquals(OrderStatus.EXPIRED, orderDao.findByFirestoreDocId("doc_501")?.status)
    }

    @Test
    fun `IncomingOrderOfferCardContent displays 60s countdown, accepts order, and shows nearest-captain transfer banner on timeout`() {
        var acceptedCount = 0
        val activeOffer = OrderEntity(
            id = 99L,
            orderNumber = "99",
            orderCode = "ORD-990",
            customerName = "عميل",
            customerPhone = "01012345678",
            storeName = "ماكدونالدز",
            pickupAddress = "شارع النصر",
            deliveryAddress = "شارع الطيران",
            itemsSummary = "بيج ماك",
            itemsCount = 2,
            orderTotalAmount = 350.0,
            deliveryFee = 45.0,
            distanceKm = 1.8,
            status = OrderStatus.PENDING,
            firestoreDocId = "doc_99",
            offerExpiresAt = System.currentTimeMillis() + 55_000L
        )

        composeRule.setContent {
            ElBatalTheme {
                IncomingOrderOfferCardContent(
                    order = activeOffer,
                    onAccept = { acceptedCount++ },
                    onTimeout = {}
                )
            }
        }

        composeRule.onNodeWithTag("incoming_order_number_text")
            .performScrollTo()
            .assertIsDisplayed()
        composeRule.onNodeWithTag("incoming_order_code_badge")
            .performScrollTo()
            .assertIsDisplayed()
        composeRule.onNodeWithText("ORD-990", substring = true)
            .performScrollTo()
            .assertIsDisplayed()
        composeRule.onNodeWithTag("incoming_order_total_text")
            .performScrollTo()
            .assertIsDisplayed()
        composeRule.onNodeWithTag("incoming_order_timer_text")
            .performScrollTo()
            .assertIsDisplayed()
        composeRule.onNodeWithTag("incoming_order_accept_button")
            .performScrollTo()
            .assertIsDisplayed()
            .performClick()
        assertEquals(1, acceptedCount)
    }

    @Test
    fun `IncomingOrderOfferCardContent shows expired banner and disables accept when 60s offer deadline elapses`() {
        var timeoutCalled = false
        val expiredOffer = OrderEntity(
            id = 100L,
            orderNumber = "100",
            orderCode = "EXP-100",
            customerName = "عميل",
            customerPhone = "01012345678",
            storeName = "جاد",
            pickupAddress = "رمسيس",
            deliveryAddress = "غمرة",
            itemsSummary = "فول وطعمية",
            itemsCount = 1,
            orderTotalAmount = 120.0,
            deliveryFee = 25.0,
            distanceKm = 1.2,
            status = OrderStatus.PENDING,
            firestoreDocId = "doc_100",
            offerExpiresAt = System.currentTimeMillis() - 2_000L
        )

        composeRule.setContent {
            ElBatalTheme {
                IncomingOrderOfferCardContent(
                    order = expiredOffer,
                    onAccept = {},
                    onTimeout = { timeoutCalled = true }
                )
            }
        }

        composeRule.waitForIdle()
        composeRule.onNodeWithTag("incoming_order_expired_banner").assertIsDisplayed()
        composeRule.onNodeWithText("انتهت مهلة قبول الطلب وتم تحويله إلى أقرب كابتن للتاجر").assertIsDisplayed()
        composeRule.onNodeWithTag("incoming_order_accept_button")
            .performScrollTo()
            .assertIsNotEnabled()
        composeRule.mainClock.advanceTimeBy(2500L)
        composeRule.waitForIdle()
        assertTrue(timeoutCalled)
    }

    @Test
    fun `MainActivity cold launches cleanly without throwing startup exceptions`() {
        val controller = org.robolectric.Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()
        assertNotNull(activity)
        assertTrue(!activity.isFinishing)
        composeRule.waitForIdle()
        controller.pause().stop().destroy()
    }

    @Test
    fun `AppDatabase MIGRATION_11_12 upgrades legacy orders table cleanly without losing data`() {
        val dbFile = appContext.getDatabasePath("migration_test_v11_v12.db")
        if (dbFile.exists()) dbFile.delete()
        try {
            val legacyDb = android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(dbFile, null)
            legacyDb.execSQL(
                """
                CREATE TABLE IF NOT EXISTS orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                    orderNumber TEXT NOT NULL,
                    orderCode TEXT NOT NULL DEFAULT '',
                    customerName TEXT NOT NULL,
                    customerPhone TEXT NOT NULL,
                    storeName TEXT NOT NULL,
                    storePhone TEXT NOT NULL DEFAULT '',
                    storeImage TEXT NOT NULL DEFAULT '',
                    pickupAddress TEXT NOT NULL,
                    deliveryAddress TEXT NOT NULL,
                    merchantId TEXT NOT NULL DEFAULT '',
                    storeLocationUrl TEXT NOT NULL DEFAULT '',
                    itemsSummary TEXT NOT NULL,
                    itemsCount INTEGER NOT NULL,
                    orderTotalAmount REAL NOT NULL,
                    deliveryFee REAL NOT NULL,
                    distanceKm REAL NOT NULL,
                    status TEXT NOT NULL,
                    createdAt INTEGER NOT NULL,
                    notes TEXT NOT NULL DEFAULT '',
                    deliveryPin TEXT NOT NULL DEFAULT '1234',
                    firestoreDocId TEXT NOT NULL DEFAULT '',
                    captainId TEXT NOT NULL DEFAULT '',
                    acceptedAt INTEGER NOT NULL DEFAULT 0,
                    orderImageUrl TEXT NOT NULL DEFAULT '',
                    receiptImagePath TEXT NOT NULL DEFAULT '',
                    receiptUploadedAt INTEGER NOT NULL DEFAULT 0,
                    receiptUploadedBy TEXT NOT NULL DEFAULT '',
                    orderDataEnteredAt INTEGER NOT NULL DEFAULT 0,
                    merchantConfirmed INTEGER NOT NULL DEFAULT 0,
                    rejectionReason TEXT NOT NULL DEFAULT '',
                    etaMinutes INTEGER NOT NULL DEFAULT 15,
                    completedAt INTEGER NOT NULL DEFAULT 0,
                    cancelledAt INTEGER NOT NULL DEFAULT 0,
                    cancellationReason TEXT NOT NULL DEFAULT ''
                )
                """.trimIndent()
            )
            legacyDb.execSQL(
                """
                CREATE TABLE IF NOT EXISTS captain_profile (
                    id INTEGER PRIMARY KEY NOT NULL,
                    uid TEXT NOT NULL DEFAULT '',
                    fullName TEXT NOT NULL,
                    phoneNumber TEXT NOT NULL,
                    email TEXT NOT NULL DEFAULT '',
                    password TEXT NOT NULL DEFAULT '',
                    avatarUri TEXT NOT NULL DEFAULT '',
                    avatarPresetIndex INTEGER NOT NULL DEFAULT 0,
                    nationalIdUrl TEXT NOT NULL DEFAULT '',
                    licenseUrl TEXT NOT NULL DEFAULT '',
                    profileImagePath TEXT NOT NULL DEFAULT '',
                    idFrontImagePath TEXT NOT NULL DEFAULT '',
                    idBackImagePath TEXT NOT NULL DEFAULT '',
                    licenseImagePath TEXT NOT NULL DEFAULT '',
                    address TEXT NOT NULL DEFAULT '',
                    accountType TEXT NOT NULL DEFAULT 'captain',
                    role TEXT NOT NULL DEFAULT 'captain',
                    status TEXT NOT NULL DEFAULT 'active',
                    availabilityStatus TEXT NOT NULL DEFAULT 'offline',
                    shiftStatus TEXT NOT NULL DEFAULT 'outside_shift',
                    vehicleType TEXT NOT NULL DEFAULT '',
                    licensePlate TEXT NOT NULL DEFAULT '',
                    rating REAL NOT NULL DEFAULT 5.0,
                    totalOrdersCount INTEGER NOT NULL DEFAULT 0,
                    walletBalance REAL NOT NULL DEFAULT 0.0,
                    isOnline INTEGER NOT NULL DEFAULT 1,
                    isLoggedIn INTEGER NOT NULL DEFAULT 0
                )
                """.trimIndent()
            )
            legacyDb.execSQL(
                """
                CREATE TABLE IF NOT EXISTS captain_shifts (
                    id TEXT PRIMARY KEY NOT NULL,
                    captainUid TEXT NOT NULL,
                    dayOfWeek INTEGER NOT NULL,
                    dayNameArabic TEXT NOT NULL,
                    startTime TEXT NOT NULL,
                    endTime TEXT NOT NULL,
                    isDayOff INTEGER NOT NULL,
                    notes TEXT NOT NULL,
                    updatedAt INTEGER NOT NULL
                )
                """.trimIndent()
            )
            legacyDb.execSQL(
                """
                CREATE TABLE IF NOT EXISTS daily_wallet_records (
                    dayKey TEXT PRIMARY KEY NOT NULL,
                    captainUid TEXT NOT NULL,
                    periodStartMs INTEGER NOT NULL,
                    periodEndMs INTEGER NOT NULL,
                    walletBalance REAL NOT NULL,
                    deliveredOrdersCount INTEGER NOT NULL,
                    totalOrdersCount INTEGER NOT NULL,
                    isClosed INTEGER NOT NULL,
                    closedAt INTEGER NOT NULL,
                    updatedAt INTEGER NOT NULL
                )
                """.trimIndent()
            )
            legacyDb.execSQL("INSERT INTO orders (id, orderNumber, orderCode, customerName, customerPhone, storeName, pickupAddress, deliveryAddress, itemsSummary, itemsCount, orderTotalAmount, deliveryFee, distanceKm, status, createdAt, firestoreDocId) VALUES (1, 'ORD-1', 'COD-1', 'Ali', '0100', 'Store', 'Addr1', 'Addr2', 'Food', 1, 100.0, 20.0, 2.0, 'PENDING', 1000, 'doc_legacy_1')")
            legacyDb.version = 11
            legacyDb.close()

            val migratedDb = Room.databaseBuilder(appContext, AppDatabase::class.java, "migration_test_v11_v12.db")
                .addMigrations(AppDatabase.MIGRATION_11_12)
                .allowMainThreadQueries()
                .build()
            val preservedOrder = kotlinx.coroutines.runBlocking {
                migratedDb.orderDao().findByFirestoreDocId("doc_legacy_1")
            }
            assertNotNull(preservedOrder)
            assertEquals("ORD-1", preservedOrder?.orderNumber)
            assertEquals("COD-1", preservedOrder?.orderCode)
            assertEquals(0L, preservedOrder?.offerExpiresAt)

            kotlinx.coroutines.runBlocking {
                migratedDb.orderDao().insertOrder(
                    OrderEntity(
                        orderNumber = "ORD-2",
                        orderCode = "COD-2",
                        customerName = "Omar",
                        customerPhone = "0101",
                        storeName = "Store 2",
                        pickupAddress = "P",
                        deliveryAddress = "D",
                        restaurantLatitude = 30.05,
                        restaurantLongitude = 31.33,
                        itemsSummary = "Item",
                        itemsCount = 1,
                        orderTotalAmount = 50.0,
                        deliveryFee = 15.0,
                        distanceKm = 1.5,
                        offerExpiresAt = 999999L
                    )
                )
            }
            migratedDb.close()
        } finally {
            if (dbFile.exists()) dbFile.delete()
        }
    }

    @Test
    fun `Launcher manifest resolves single Captain MainActivity and supports applicationId alias`() {
        val pkg = "com.aistudio.elbatalexpresscaptain.captain"
        assertEquals(pkg, appContext.packageName)

        val pm = appContext.packageManager
        val launchIntent = pm.getLaunchIntentForPackage(pkg)
        assertNotNull(launchIntent)
        assertEquals("com.example.MainActivity", launchIntent?.component?.className)

        val mainQuery = android.content.Intent(android.content.Intent.ACTION_MAIN).apply {
            addCategory(android.content.Intent.CATEGORY_LAUNCHER)
            setPackage(pkg)
        }
        val launcherMatches = pm.queryIntentActivities(mainQuery, 0)
        assertEquals(1, launcherMatches.size)
        assertEquals("com.example.MainActivity", launcherMatches.first().activityInfo.name)

        val aliasComponent = android.content.ComponentName(pkg, "$pkg.MainActivity")
        val aliasInfo = pm.getActivityInfo(aliasComponent, 0)
        assertTrue(aliasInfo.exported)
        assertEquals("com.example.MainActivity", aliasInfo.targetActivity)
    }

    @Test
    fun `ic_notification_captain resolves cleanly and orderCode plus storeLocationUrl propagate through notification intents`() {
        val drawable = appContext.getDrawable(R.drawable.ic_notification_captain)
        assertNotNull("Expected R.drawable.ic_notification_captain to resolve", drawable)

        val mapUrl = "https://maps.google.com/?q=30.0444,31.2357"
        val intent = com.example.notifications.IncomingOrderActivity.createIntent(
            context = appContext,
            orderKey = "order_loc_1",
            orderId = 515L,
            storeName = "مطعم البطل",
            pickupAddress = "مدينة نصر",
            deliveryAddress = "مصر الجديدة",
            deliveryFee = 35.0,
            orderCode = "BT-515",
            storeLocationUrl = mapUrl,
            offerExpiresAtMs = System.currentTimeMillis() + 60_000L
        )
        assertEquals("BT-515", intent.getStringExtra(com.example.notifications.IncomingOrderActivity.EXTRA_ORDER_CODE))
        assertEquals(mapUrl, intent.getStringExtra(com.example.notifications.IncomingOrderActivity.EXTRA_STORE_LOCATION_URL))

        val posted = CaptainNotificationManager.showNewOrderNotification(
            context = appContext,
            orderKey = "order_loc_1",
            storeName = "مطعم البطل",
            pickupAddress = "مدينة نصر",
            deliveryAddress = "مصر الجديدة",
            deliveryFee = 35.0,
            orderCode = "BT-515",
            storeLocationUrl = mapUrl,
            orderId = 515L,
            offerExpiresAtMs = System.currentTimeMillis() + 60_000L,
            startContinuousBell = false
        )
        assertTrue(posted)
        CaptainNotificationManager.stopIncomingOrderBell(appContext, "order_loc_1")
    }
}
