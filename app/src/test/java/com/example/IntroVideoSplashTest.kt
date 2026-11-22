package com.example

import android.app.Application
import android.net.Uri
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.example.data.AppDatabase
import com.example.data.AuthUserSnapshot
import com.example.data.CaptainAuthBackendPort
import com.example.data.CaptainRepository
import com.example.data.StartupSessionState
import com.example.ui.CaptainViewModel
import com.example.ui.navigation.AppNavigation
import com.example.ui.navigation.ScreenRoute
import com.example.ui.screens.SplashScreen
import com.example.ui.screens.SplashVideoPlaybackMode
import com.example.ui.screens.buildIntroVideoUri
import com.example.ui.theme.ElBatalTheme
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w411dp-h900dp")
class IntroVideoSplashTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    private lateinit var app: Application
    private lateinit var db: AppDatabase

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        db = Room.inMemoryDatabaseBuilder(app, AppDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() {
        db.close()
    }

    private class FakeAuthBackend(
        var user: AuthUserSnapshot? = null,
        var captainDoc: Map<String, Any?>? = null
    ) : CaptainAuthBackendPort {
        override fun currentUser(): AuthUserSnapshot? = user
        override suspend fun createUserWithEmailAndPassword(email: String, password: String): AuthUserSnapshot =
            error("Not needed")
        override suspend fun sendEmailVerification() = Unit
        override suspend fun reloadCurrentUser(): AuthUserSnapshot? = user
        override suspend fun updateDisplayName(displayName: String) = Unit
        override suspend fun signInWithEmailAndPassword(email: String, password: String): AuthUserSnapshot =
            error("Not needed")
        override fun signOut() { user = null }
        override suspend fun sendPasswordResetEmail(email: String) = Unit
        override suspend fun createCaptainDoc(uid: String, data: Map<String, Any>) = Unit
        override suspend fun getCaptainDoc(uid: String): Map<String, Any?>? = captainDoc
        override suspend fun updateCaptainDoc(uid: String, data: Map<String, Any>) = Unit
        override suspend fun queryCaptainEmailByPhoneVariants(
            variants: List<String>,
            numericVariants: List<Long>,
            normalizedLocal: String
        ): String? = null
    }

    @Test
    fun introVideoRawResource_existsAndMatchesOriginalOfflineAsset() {
        assertNotEquals("R.raw.intro must exist", 0, R.raw.intro)
        val uri = buildIntroVideoUri(app)
        assertTrue(
            "Intro video URI must be local offline resource URI (got $uri)",
            uri.scheme == "rawresource" || uri.scheme == "android.resource"
        )
        app.resources.openRawResource(R.raw.intro).use { stream ->
            val bytes = stream.readBytes()
            assertTrue("intro.mp4 must contain the original bundled video (>1MB), got ${bytes.size}", bytes.size > 1_000_000)
        }
    }

    @Test
    fun introVideoPlayer_isStrictlyMutedOnCreation() {
        val uri = buildIntroVideoUri(app)
        val player = com.example.ui.screens.createMutedIntroExoPlayer(app, uri)
        try {
            assertEquals("Intro video player volume must be strictly 0.0f", 0f, player.volume, 0f)
            assertEquals(com.example.ui.screens.INTRO_VIDEO_MUTED_VOLUME, player.volume, 0f)
        } finally {
            player.release()
        }
    }

    // Scenario 1: كابتن مسجل الدخول
    @Test
    fun scenario1_authenticatedCaptain_afterIntroVideo_navigatesToMainScreen() {
        val fakeAuth = FakeAuthBackend(
            user = AuthUserSnapshot("cap_01", "captain1@elbatal.com", isEmailVerified = true, displayName = "كابتن أحمد"),
            captainDoc = mapOf(
                "uid" to "cap_01",
                "accountType" to "captain",
                "status" to "active",
                "name" to "كابتن أحمد",
                "phone" to "01011223344",
                "email" to "captain1@elbatal.com"
            )
        )
        val repo = CaptainRepository(
            captainDao = db.captainDao(),
            orderDao = db.orderDao(),
            shiftDao = db.shiftDao(),
            context = app,
            authBackendOverride = fakeAuth
        )
        val resolvedState = runBlocking { repo.resolveStartupSessionState() }
        assertEquals(StartupSessionState.Authenticated, resolvedState)

        val viewModel = CaptainViewModel(app).apply {
            startupSessionResolverOverride = { resolvedState }
        }

        composeTestRule.setContent {
            ElBatalTheme {
                AppNavigation(
                    viewModel = viewModel,
                    splashPlaybackMode = SplashVideoPlaybackMode.SimulateEnded
                )
            }
        }
        composeTestRule.waitUntil(timeoutMillis = 5_000L) {
            viewModel.currentRoute.value == ScreenRoute.Main.route
        }
        composeTestRule.waitForIdle()

        assertTrue(viewModel.hasCompletedIntroSplash.value)
        assertEquals(ScreenRoute.Main.route, viewModel.currentRoute.value)
        composeTestRule.onNodeWithTag("captain_bottom_navigation_bar").assertIsDisplayed()
    }

    // Scenario 2: كابتن غير مسجل الدخول
    @Test
    fun scenario2_unauthenticatedCaptain_afterIntroVideo_navigatesToLoginScreen() {
        val fakeAuth = FakeAuthBackend(user = null)
        val repo = CaptainRepository(
            captainDao = db.captainDao(),
            orderDao = db.orderDao(),
            shiftDao = db.shiftDao(),
            context = app,
            authBackendOverride = fakeAuth
        )
        val resolvedState = runBlocking { repo.resolveStartupSessionState() }
        assertEquals(StartupSessionState.Unauthenticated, resolvedState)

        val viewModel = CaptainViewModel(app).apply {
            startupSessionResolverOverride = { resolvedState }
        }

        composeTestRule.setContent {
            ElBatalTheme {
                AppNavigation(
                    viewModel = viewModel,
                    splashPlaybackMode = SplashVideoPlaybackMode.SimulateEnded
                )
            }
        }
        composeTestRule.waitUntil(timeoutMillis = 5_000L) {
            viewModel.currentRoute.value == ScreenRoute.Login.route
        }
        composeTestRule.waitForIdle()

        assertTrue(viewModel.hasCompletedIntroSplash.value)
        assertEquals(ScreenRoute.Login.route, viewModel.currentRoute.value)
        composeTestRule.onNodeWithTag("login_submit_button").assertIsDisplayed()
    }

    // Scenario 3: كابتن لم يكمل التسجيل + كابتن في انتظار مراجعة الحساب
    @Test
    fun scenario3_incompleteRegistrationAndPendingReview_preservesExistingFlowWithoutBypass() {
        // 3A: Signed up in Firebase Auth but email not yet verified -> VerifyEmail route
        val unverifiedAuth = FakeAuthBackend(
            user = AuthUserSnapshot("cap_unverified", "pending.cap@elbatal.com", isEmailVerified = false)
        )
        val unverifiedRepo = CaptainRepository(
            captainDao = db.captainDao(),
            orderDao = db.orderDao(),
            shiftDao = db.shiftDao(),
            context = app,
            authBackendOverride = unverifiedAuth
        )
        val unverifiedState = runBlocking { unverifiedRepo.resolveStartupSessionState() }
        assertEquals(StartupSessionState.NeedsEmailVerification("pending.cap@elbatal.com"), unverifiedState)

        val viewModel = CaptainViewModel(app).apply {
            startupSessionResolverOverride = { unverifiedState }
        }

        composeTestRule.setContent {
            ElBatalTheme {
                AppNavigation(
                    viewModel = viewModel,
                    splashPlaybackMode = SplashVideoPlaybackMode.SimulateEnded
                )
            }
        }
        composeTestRule.waitUntil(timeoutMillis = 5_000L) {
            viewModel.currentRoute.value == ScreenRoute.VerifyEmail.route
        }
        composeTestRule.waitForIdle()

        assertEquals(ScreenRoute.VerifyEmail.route, viewModel.currentRoute.value)
        assertEquals("pending.cap@elbatal.com", viewModel.unverifiedEmail.value)
        composeTestRule.onNodeWithTag("verify_email_text").assertIsDisplayed()

        // 3B: Verified captain whose Firestore doc status is "pending" (waiting review) -> keeps pending status intact
        val pendingReviewAuth = FakeAuthBackend(
            user = AuthUserSnapshot("cap_pending", "review@elbatal.com", isEmailVerified = true),
            captainDoc = mapOf(
                "uid" to "cap_pending",
                "accountType" to "captain",
                "status" to "pending",
                "name" to "كابتن قيد المراجعة",
                "phone" to "01055667788",
                "email" to "review@elbatal.com"
            )
        )
        val pendingReviewRepo = CaptainRepository(
            captainDao = db.captainDao(),
            orderDao = db.orderDao(),
            shiftDao = db.shiftDao(),
            context = app,
            authBackendOverride = pendingReviewAuth
        )
        val reviewState = runBlocking { pendingReviewRepo.resolveStartupSessionState() }
        val savedCaptain = runBlocking { db.captainDao().getCaptain() }
        assertEquals(StartupSessionState.Authenticated, reviewState)
        assertEquals("pending", savedCaptain?.status)
    }

    // Scenario 4: فشل تشغيل الفيديو
    @Test
    fun scenario4_videoPlaybackError_automaticallyFallsBackToAuthCheck() {
        var authChecks = 0
        val viewModel = CaptainViewModel(app).apply {
            startupSessionResolverOverride = {
                authChecks++
                StartupSessionState.Authenticated
            }
        }

        composeTestRule.setContent {
            ElBatalTheme {
                AppNavigation(
                    viewModel = viewModel,
                    splashPlaybackMode = SplashVideoPlaybackMode.SimulateError("Decoder unavailable")
                )
            }
        }
        composeTestRule.waitUntil(timeoutMillis = 5_000L) {
            viewModel.currentRoute.value == ScreenRoute.Main.route
        }
        composeTestRule.waitForIdle()

        assertEquals(1, authChecks)
        assertTrue(viewModel.hasCompletedIntroSplash.value)
        assertEquals(ScreenRoute.Main.route, viewModel.currentRoute.value)
    }

    @Test
    fun scenario4b_invalidVideoUriInRealExoPlayerMode_recoversAndCallsNavigateNextOnce() {
        var callbackCount = 0
        composeTestRule.setContent {
            ElBatalTheme {
                SplashScreen(
                    isLoggedIn = false,
                    videoUriOverride = Uri.parse("file:///non_existent_intro_video.mp4"),
                    playbackMode = SplashVideoPlaybackMode.ExoPlayerDefault,
                    safetyTimeoutMs = 800L,
                    onNavigateNext = { callbackCount++ }
                )
            }
        }

        composeTestRule.waitUntil(timeoutMillis = 4_000L) { callbackCount == 1 }
        assertEquals("Splash fallback must invoke auth navigation exactly once", 1, callbackCount)
    }

    // Scenario 5: الانتقال إلى الخلفية والعودة للتطبيق (عدم إعادة الفيديو)
    @Test
    fun scenario5_backgroundAndResume_doesNotReplayIntroVideo() {
        var authChecks = 0
        val viewModel = CaptainViewModel(app).apply {
            startupSessionResolverOverride = {
                authChecks++
                StartupSessionState.Authenticated
            }
        }
        val isForeground = mutableStateOf(true)

        composeTestRule.setContent {
            ElBatalTheme {
                if (isForeground.value) {
                    AppNavigation(
                        viewModel = viewModel,
                        splashPlaybackMode = SplashVideoPlaybackMode.SimulateEnded
                    )
                }
            }
        }

        composeTestRule.waitUntil(timeoutMillis = 5_000L) {
            viewModel.currentRoute.value == ScreenRoute.Main.route
        }
        assertEquals(1, authChecks)
        assertTrue(viewModel.hasCompletedIntroSplash.value)

        // Simulate app moving to background (UI disposed/stopped) and returning to foreground
        composeTestRule.runOnIdle { isForeground.value = false }
        composeTestRule.waitForIdle()
        composeTestRule.runOnIdle { isForeground.value = true }
        composeTestRule.waitForIdle()

        // Guard also prevents returning to Splash after already completed in this process
        viewModel.navigateTo(ScreenRoute.Splash.route)
        viewModel.onIntroSplashFinished()
        composeTestRule.waitForIdle()

        assertEquals("Intro video must NOT replay on resume", 1, authChecks)
        assertEquals(ScreenRoute.Main.route, viewModel.currentRoute.value)
        composeTestRule.onNodeWithTag("captain_bottom_navigation_bar").assertIsDisplayed()
    }

    // Scenario 6: إغلاق التطبيق وإعادة فتحه (تشغيل الفيديو مرة واحدة عند التشغيل الجديد)
    @Test
    fun scenario6_coldRestart_createsFreshSessionAndPlaysIntroVideoOnce() {
        // First app session
        val firstSessionVm = CaptainViewModel(app).apply {
            startupSessionResolverOverride = { StartupSessionState.Unauthenticated }
        }
        assertFalse(firstSessionVm.hasCompletedIntroSplash.value)
        assertEquals(ScreenRoute.Splash.route, firstSessionVm.currentRoute.value)

        firstSessionVm.onIntroSplashFinished()
        composeTestRule.waitUntil(timeoutMillis = 5_000L) {
            firstSessionVm.hasCompletedIntroSplash.value
        }
        assertEquals(ScreenRoute.Login.route, firstSessionVm.currentRoute.value)

        // Simulated full close & cold reopen (new process -> new ViewModel instance)
        var coldStartAuthChecks = 0
        val restartedSessionVm = CaptainViewModel(app).apply {
            startupSessionResolverOverride = {
                coldStartAuthChecks++
                StartupSessionState.Authenticated
            }
        }

        // Before video finishes, fresh launch starts on Splash with hasCompletedIntroSplash == false
        assertFalse(restartedSessionVm.hasCompletedIntroSplash.value)
        assertEquals(ScreenRoute.Splash.route, restartedSessionVm.currentRoute.value)

        composeTestRule.setContent {
            ElBatalTheme {
                AppNavigation(
                    viewModel = restartedSessionVm,
                    splashPlaybackMode = SplashVideoPlaybackMode.SimulateEnded
                )
            }
        }
        composeTestRule.waitUntil(timeoutMillis = 5_000L) {
            restartedSessionVm.currentRoute.value == ScreenRoute.Main.route
        }

        assertEquals(1, coldStartAuthChecks)
        assertTrue(restartedSessionVm.hasCompletedIntroSplash.value)
        assertEquals(ScreenRoute.Main.route, restartedSessionVm.currentRoute.value)
    }
}
