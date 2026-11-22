package com.example

import android.app.Application
import android.content.Context
import android.net.Uri
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.example.data.AppDatabase
import com.example.data.AuthUserSnapshot
import com.example.data.CaptainAuthBackendPort
import com.example.data.CaptainCloudMetadataPort
import com.example.data.CaptainEntity
import com.example.data.CaptainRepository
import com.example.data.LoginOutcome
import com.example.data.OrderEntity
import com.example.data.OrderStatus
import com.example.data.remote.CloudFunctionsOrderClient
import com.example.data.remote.OrderCallableGateway
import com.example.data.storage.AuthUidProvider
import com.example.data.storage.FirebaseStorageRepository
import com.example.data.storage.NetworkConnectivityChecker
import com.example.data.storage.StorageGateway
import com.example.ui.screens.AccountStatusGateScreen
import com.example.ui.theme.ElBatalTheme
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w411dp-h1400dp")
class CaptainAccountApprovalGateTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    private lateinit var appContext: Application
    private lateinit var db: AppDatabase

    @Before
    fun setUp() {
        appContext = ApplicationProvider.getApplicationContext()
        appContext.getSharedPreferences("elbatal_phone_auth_registry", Context.MODE_PRIVATE)
            .edit().clear().commit()
        db = Room.inMemoryDatabaseBuilder(appContext, AppDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() {
        db.close()
    }

    private class GateFakeBackend : CaptainAuthBackendPort {
        val users = mutableMapOf<String, AuthUserSnapshot>()
        val passwords = mutableMapOf<String, String>()
        val captains = mutableMapOf<String, MutableMap<String, Any?>>()
        var currentUid: String? = null
        private var seq = 1

        override fun currentUser(): AuthUserSnapshot? = currentUid?.let { users[it] }

        override suspend fun createUserWithEmailAndPassword(email: String, password: String): AuthUserSnapshot {
            val uid = "gate_cap_${seq++}"
            val snap = AuthUserSnapshot(uid = uid, email = email.trim().lowercase(), isEmailVerified = false)
            users[uid] = snap
            passwords[uid] = password
            currentUid = uid
            return snap
        }

        override suspend fun sendEmailVerification() {}

        override suspend fun reloadCurrentUser(): AuthUserSnapshot? = currentUser()

        override suspend fun updateDisplayName(displayName: String) {
            val uid = currentUid ?: return
            val existing = users[uid] ?: return
            users[uid] = existing.copy(displayName = displayName)
        }

        override suspend fun signInWithEmailAndPassword(email: String, password: String): AuthUserSnapshot {
            val normalized = email.trim().lowercase()
            val entry = users.values.firstOrNull { it.email == normalized }
                ?: throw IllegalArgumentException("User not found")
            if (passwords[entry.uid] != password) throw IllegalArgumentException("Wrong password")
            currentUid = entry.uid
            return entry
        }

        override fun signOut() {
            currentUid = null
        }

        override suspend fun sendPasswordResetEmail(email: String) {}

        override suspend fun createCaptainDoc(uid: String, data: Map<String, Any>) {
            captains[uid] = data.toMutableMap()
        }

        override suspend fun getCaptainDoc(uid: String): Map<String, Any?>? = captains[uid]?.toMap()

        override suspend fun updateCaptainDoc(uid: String, data: Map<String, Any>) {
            val doc = captains[uid] ?: return
            data.forEach { (k, v) -> doc[k] = v }
        }

        override suspend fun queryCaptainEmailByPhoneVariants(
            variants: List<String>,
            numericVariants: List<Long>,
            normalizedLocal: String
        ): String? = null
    }

    private fun buildRepo(backend: GateFakeBackend): CaptainRepository {
        val storageRepo = FirebaseStorageRepository(
            context = appContext,
            gateway = object : StorageGateway {
                override suspend fun putBytesWithProgress(
                    storagePath: String,
                    bytes: ByteArray,
                    contentType: String,
                    customMetadata: Map<String, String>,
                    requesterUid: String,
                    onProgress: (Int) -> Unit
                ) = onProgress(100)

                override suspend fun getBytes(storagePath: String, maxDownloadBytes: Long, requesterUid: String): ByteArray =
                    ByteArray(8)
            },
            authUidProvider = AuthUidProvider { backend.currentUid ?: "" },
            connectivityChecker = NetworkConnectivityChecker { true },
            maxAutoRetries = 1
        )
        val metaPort = object : CaptainCloudMetadataPort {
            override fun currentAuthUid(): String? = backend.currentUid
            override suspend fun saveCaptainImageMetadata(uid: String, fields: Map<String, Any>) {
                backend.updateCaptainDoc(uid, fields)
            }
            override suspend fun fetchCaptainImageMetadata(uid: String): Map<String, String>? = null
            override suspend fun submitOrderReceiptDetails(
                orderDocId: String,
                customerName: String,
                customerPhone: String,
                receiptImagePath: String,
                notes: String
            ): Result<String> = Result.success("ok")
        }
        val cfClient = CloudFunctionsOrderClient(
            firebaseAuth = null,
            callableGateway = object : OrderCallableGateway {
                override suspend fun callFunction(
                    functionName: String,
                    payload: Map<String, Any?>
                ): Map<String, Any?> = mapOf("success" to true)
            },
            authUidProvider = { backend.currentUid ?: "anon" }
        )
        return CaptainRepository(
            captainDao = db.captainDao(),
            orderDao = db.orderDao(),
            shiftDao = db.shiftDao(),
            context = appContext,
            storageRepository = storageRepo,
            cloudMetadataPortOverride = metaPort,
            cloudFunctionsClientOverride = cfClient,
            authBackendOverride = backend
        )
    }

    @Test
    fun newSignupIsPendingAndOffline_blocksOrdersUntilAdminApproves_thenServerRefreshUnlocks() = runBlocking {
        val backend = GateFakeBackend()
        val repo = buildRepo(backend)

        val regRes = repo.registerCaptainWithEmailVerification(
            fullName = "كابتن جديد للمراجعة",
            phone = "01044556677",
            email = "pending.cap@elbatal.com",
            pass = "Pass1234",
            address = "القاهرة"
        )
        assertTrue(regRes.isSuccess)
        val uid = backend.currentUid!!

        val firestoreDoc = backend.captains[uid]!!
        assertEquals("pending", firestoreDoc["accountStatus"])
        assertEquals(false, firestoreDoc["isApproved"])
        assertEquals("pending", firestoreDoc["status"])

        // Simulate verifying email & logging in while still pending review
        backend.users[uid] = backend.users[uid]!!.copy(isEmailVerified = true)
        val loginRes = repo.login("pending.cap@elbatal.com", "Pass1234")
        assertTrue(loginRes is LoginOutcome.Success)

        val pendingCaptain = db.captainDao().getCaptain()!!
        assertEquals("pending", pendingCaptain.effectiveAccountStatus)
        assertFalse(pendingCaptain.isAccountApproved)
        assertFalse("Pending captain must remain offline", pendingCaptain.isOnline)

        // Accepting orders while pending must be rejected
        db.orderDao().insertOrder(
            OrderEntity(
                id = 505L,
                orderNumber = "ORD-505",
                customerName = "عميل",
                customerPhone = "01000000000",
                storeName = "متجر",
                pickupAddress = "مدينة نصر",
                deliveryAddress = "المعادي",
                itemsSummary = "طلب",
                itemsCount = 1,
                orderTotalAmount = 100.0,
                deliveryFee = 25.0,
                distanceKm = 2.0,
                status = OrderStatus.PENDING,
                firestoreDocId = "ord_505"
            )
        )
        val pendingAccept = repo.acceptOrder(505L)
        assertTrue(pendingAccept.isFailure)

        // Simulate admin rejecting, suspending, blocking, then approving via server refresh
        backend.captains[uid]!!["accountStatus"] = "rejected"
        backend.captains[uid]!!["isApproved"] = false
        backend.captains[uid]!!["status"] = "rejected"
        backend.captains[uid]!!["rejectionReason"] = "صورة البطاقة غير واضحة"
        val rejectedRefresh = repo.refreshCaptainProfileFromServer().getOrNull()!!
        assertEquals("rejected", rejectedRefresh.effectiveAccountStatus)
        assertEquals("صورة البطاقة غير واضحة", rejectedRefresh.rejectionReason)
        assertFalse(rejectedRefresh.isAccountApproved)

        backend.captains[uid]!!["accountStatus"] = "approved"
        backend.captains[uid]!!["isApproved"] = true
        backend.captains[uid]!!["status"] = "active"
        backend.captains[uid]!!["rejectionReason"] = ""
        val approvedRefresh = repo.refreshCaptainProfileFromServer().getOrNull()!!
        assertEquals("approved", approvedRefresh.effectiveAccountStatus)
        assertTrue(approvedRefresh.isAccountApproved)
    }

    @Test
    fun resolveAccountStatus_preservesLegacyCaptainsWithoutNewModerationFields() {
        val legacyDoc = mapOf<String, Any?>(
            "uid" to "legacy_1",
            "accountType" to "captain",
            "role" to "captain",
            "status" to "active"
        )
        assertEquals("approved", CaptainRepository.resolveAccountStatus(legacyDoc))

        val minimalLegacyDoc = mapOf<String, Any?>(
            "uid" to "legacy_2",
            "accountType" to "captain"
        )
        assertEquals("approved", CaptainRepository.resolveAccountStatus(minimalLegacyDoc))

        assertEquals(
            "suspended",
            CaptainRepository.resolveAccountStatus(mapOf("accountStatus" to "suspended", "isApproved" to false))
        )
        assertEquals(
            "blocked",
            CaptainRepository.resolveAccountStatus(mapOf("isBlocked" to true))
        )
    }

    @Test
    fun accountStatusGateScreen_rendersStatusesAndReasonAndCallbacks() {
        var refreshCount = 0
        var logoutCount = 0

        val rejectedCaptain = CaptainEntity(
            uid = "cap_rej",
            fullName = "كابتن أحمد",
            phoneNumber = "01011112222",
            email = "ahmed@elbatal.com",
            status = "rejected",
            accountStatus = "rejected",
            isApproved = false,
            rejectionReason = "البطاقة منتهية الصلاحية",
            isOnline = false,
            isLoggedIn = true
        )

        composeTestRule.setContent {
            ElBatalTheme {
                AccountStatusGateScreen(
                    captain = rejectedCaptain,
                    isRefreshing = false,
                    onRefreshStatus = { refreshCount++ },
                    onLogout = { logoutCount++ }
                )
            }
        }
        composeTestRule.waitForIdle()

        composeTestRule.onNodeWithTag("account_status_gate_screen").assertIsDisplayed()
        composeTestRule.onNodeWithText("تم رفض طلب التسجيل").assertIsDisplayed()
        composeTestRule.onNodeWithText("البطاقة منتهية الصلاحية").assertIsDisplayed()
        composeTestRule.onNodeWithTag("gate_refresh_button").performScrollTo().performClick()
        composeTestRule.onNodeWithTag("gate_logout_button").performScrollTo().performClick()

        assertEquals(1, refreshCount)
        assertEquals(1, logoutCount)
    }
}
