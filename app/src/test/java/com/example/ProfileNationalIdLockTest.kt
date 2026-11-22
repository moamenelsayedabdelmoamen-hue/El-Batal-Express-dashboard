package com.example

import android.content.Context
import android.net.Uri
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.example.data.AppDatabase
import com.example.data.CaptainCloudMetadataPort
import com.example.data.CaptainEntity
import com.example.data.CaptainRepository
import com.example.data.storage.AuthUidProvider
import com.example.data.storage.FirebaseStorageRepository
import com.example.data.storage.NetworkConnectivityChecker
import com.example.data.storage.StorageGateway
import com.example.ui.screens.ProfileScreen
import com.example.ui.theme.ElBatalTheme
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w411dp-h1400dp")
class ProfileNationalIdLockTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    private lateinit var db: AppDatabase
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun `nationalIdSection_whenUploadedAndSaved_locksEditButtonsAndShowsVerifiedCopy`() {
        val verifiedCaptain = CaptainEntity(
            id = 1,
            uid = "cap_verified_1",
            fullName = "أحمد محمد البطل",
            phoneNumber = "01012345678",
            isLoggedIn = true,
            idFrontImagePath = "https://example.com/id_front.jpg",
            idBackImagePath = "https://example.com/id_back.jpg"
        )

        composeTestRule.setContent {
            ElBatalTheme {
                ProfileScreen(
                    captain = verifiedCaptain,
                    onSaveProfile = { _, _, _, _, _, _ -> },
                    onLogout = {}
                )
            }
        }
        composeTestRule.waitForIdle()

        // 1. Updated header, security notice, completion strip, and bottom support note
        composeTestRule.onNodeWithTag("national_id_section_card").performScrollTo()
        composeTestRule.onNodeWithText("بياناتك ومستنداتك مشفرة ومحفوظة بأمان، ولا يمكن تعديلها بعد الاعتماد.").assertIsDisplayed()
        composeTestRule.onNodeWithText("مستنداتك محفوظة ومؤمّنة بالكامل. لا يمكن تغيير أو استبدال صور البطاقة الشخصية بعد رفعها.").assertIsDisplayed()
        composeTestRule.onNodeWithText("تم توثيق البطاقة الشخصية بنجاح (الوجه الأمامي والخلفي) — المستند مغلق للتعديل 🔒").assertIsDisplayed()

        composeTestRule.onAllNodesWithText("تم الحفظ والتوثيق بنجاح 🔒").assertCountEquals(2)
        composeTestRule.onAllNodesWithText("Firebase Storage", substring = true).assertCountEquals(0)

        // 2. Edit / re-capture / replace buttons MUST NOT exist after upload
        composeTestRule.onAllNodesWithTag("id_front_camera_button").assertCountEquals(0)
        composeTestRule.onAllNodesWithTag("id_front_gallery_button").assertCountEquals(0)
        composeTestRule.onAllNodesWithTag("id_back_camera_button").assertCountEquals(0)
        composeTestRule.onAllNodesWithTag("id_back_gallery_button").assertCountEquals(0)
        composeTestRule.onAllNodesWithText("إعادة تصوير").assertCountEquals(0)
        composeTestRule.onAllNodesWithText("استبدال").assertCountEquals(0)

        // 3. Locked banners & support note MUST be visible
        composeTestRule.onNodeWithTag("id_front_locked_banner").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithTag("id_back_locked_banner").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithTag("national_id_support_note").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("لتحديث بيانات البطاقة الشخصية، يرجى التواصل مع الدعم الفني.").assertIsDisplayed()
    }

    @Test
    fun `nationalIdSection_whenNotUploaded_showsInitialCaptureAndGalleryButtons`() {
        val newCaptain = CaptainEntity(
            id = 1,
            uid = "cap_new_1",
            fullName = "كابتن جديد",
            phoneNumber = "01099998888",
            isLoggedIn = true,
            idFrontImagePath = "",
            idBackImagePath = ""
        )

        composeTestRule.setContent {
            ElBatalTheme {
                ProfileScreen(
                    captain = newCaptain,
                    onSaveProfile = { _, _, _, _, _, _ -> },
                    onLogout = {}
                )
            }
        }
        composeTestRule.waitForIdle()

        composeTestRule.onNodeWithTag("id_front_camera_button").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithTag("id_front_gallery_button").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithTag("id_back_camera_button").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithTag("id_back_gallery_button").performScrollTo().assertIsDisplayed()
        composeTestRule.onAllNodesWithTag("id_front_locked_banner").assertCountEquals(0)
        composeTestRule.onAllNodesWithTag("id_back_locked_banner").assertCountEquals(0)
    }

    @Test
    fun `repository_rejectsOverwriteAfterIdFrontAndBackAreSaved`() = runBlocking {
        val dummyStorageGateway = object : StorageGateway {
            override suspend fun putBytesWithProgress(
                storagePath: String,
                bytes: ByteArray,
                contentType: String,
                customMetadata: Map<String, String>,
                requesterUid: String,
                onProgress: (Int) -> Unit
            ) {}

            override suspend fun getBytes(
                storagePath: String,
                maxDownloadBytes: Long,
                requesterUid: String
            ): ByteArray = ByteArray(0)
        }
        val dummyMetaPort = object : CaptainCloudMetadataPort {
            override fun currentAuthUid(): String = "cap_locked_1"
            override suspend fun saveCaptainImageMetadata(uid: String, fields: Map<String, Any>) {}
            override suspend fun fetchCaptainImageMetadata(uid: String): Map<String, String>? = null
            override suspend fun submitOrderReceiptDetails(
                orderDocId: String,
                customerName: String,
                customerPhone: String,
                receiptImagePath: String,
                notes: String
            ) = Result.success("")
        }
        val repo = CaptainRepository(
            captainDao = db.captainDao(),
            orderDao = db.orderDao(),
            shiftDao = db.shiftDao(),
            context = context,
            storageRepository = FirebaseStorageRepository(
                context = context,
                gateway = dummyStorageGateway,
                authUidProvider = AuthUidProvider { "cap_locked_1" },
                connectivityChecker = NetworkConnectivityChecker { true }
            ),
            cloudMetadataPortOverride = dummyMetaPort
        )

        db.captainDao().insertOrUpdate(
            CaptainEntity(
                id = 1,
                uid = "cap_locked_1",
                fullName = "كابتن موثق",
                phoneNumber = "01055554444",
                isLoggedIn = true,
                idFrontImagePath = "captains/cap_locked_1/documents/id_front.jpg",
                idBackImagePath = "captains/cap_locked_1/documents/id_back.jpg"
            )
        )

        val frontRetry = repo.uploadAndSaveIdFront(Uri.parse("file:///tmp/new_front.jpg"))
        val backRetry = repo.uploadAndSaveIdBack(Uri.parse("file:///tmp/new_back.jpg"))

        assertTrue("Front ID overwrite must be rejected once locked", frontRetry.isFailure)
        assertTrue("Back ID overwrite must be rejected once locked", backRetry.isFailure)
    }
}
