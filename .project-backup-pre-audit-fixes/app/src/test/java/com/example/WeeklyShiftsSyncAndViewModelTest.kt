package com.example

import android.app.Application
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.example.data.AppDatabase
import com.example.data.CaptainRepository
import com.example.data.ShiftEntity
import com.example.data.ShiftManager
import com.example.data.ShiftStatus
import com.example.ui.CaptainViewModel
import com.google.firebase.firestore.ListenerRegistration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Calendar

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class WeeklyShiftsSyncAndViewModelTest {

    private lateinit var appContext: Application
    private lateinit var viewModelStore: ViewModelStore
    private lateinit var viewModel: CaptainViewModel
    private lateinit var appDb: AppDatabase
    private lateinit var inMemoryDb: AppDatabase

    @Before
    fun setUp() {
        appContext = ApplicationProvider.getApplicationContext()
        appDb = AppDatabase.getDatabase(appContext)
        runBlocking {
            appDb.shiftDao().clearAll()
        }

        viewModelStore = ViewModelStore()
        viewModel = ViewModelProvider(
            viewModelStore,
            ViewModelProvider.AndroidViewModelFactory.getInstance(appContext)
        )[CaptainViewModel::class.java]

        inMemoryDb = Room.inMemoryDatabaseBuilder(appContext, AppDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() {
        viewModel.detachShiftSnapshotListeners()
        viewModelStore.clear()
        runBlocking {
            appDb.shiftDao().clearAll()
        }
        inMemoryDb.close()
    }

    private fun sampleWeeklyScheduleDoc(uid: String): Map<String, Any?> = mapOf(
        "captainId" to uid,
        "weeklySchedule" to mapOf(
            "saturday" to mapOf(
                "day" to "saturday",
                "dayNameAr" to "السبت",
                "isDayOff" to false,
                "shifts" to listOf(
                    mapOf("id" to "shift_sat_1", "startTime" to "06:00", "endTime" to "12:00"),
                    mapOf("id" to "shift_sat_2", "startTime" to "14:00", "endTime" to "22:00")
                )
            ),
            "sunday" to mapOf(
                "day" to "sunday",
                "dayNameAr" to "الأحد",
                "isDayOff" to false,
                "shifts" to listOf(
                    mapOf("id" to "shift_sun_1", "startTime" to "14:00", "endTime" to "12:00")
                )
            )
        )
    )

    // 1. تفريغ _liveShifts والواجهة عند حذف المستند الأساسي captain_schedules/{uid}
    @Test
    fun canonicalSnapshotDeleted_emptiesLiveShiftsUiFlowAndDeletesRoomShifts() = runBlocking {
        val uid = "captain_deleted_doc"

        // First apply a valid canonical schedule
        viewModel.applyCanonicalShiftSnapshot(
            uid = uid,
            exists = true,
            docData = sampleWeeklyScheduleDoc(uid)
        )
        assertEquals(3, viewModel.liveShiftsState.value.size)
        assertEquals(3, appDb.shiftDao().getShiftsForCaptainFlow(uid).first().size)

        // Now simulate deletion of captain_schedules/{uid}
        viewModel.applyCanonicalShiftSnapshot(
            uid = uid,
            exists = false,
            docData = null
        )

        assertTrue("Expected _liveShifts to be empty after doc deletion", viewModel.liveShiftsState.value.isEmpty())
        assertTrue("Expected ShiftStatus.NoSchedule after doc deletion", viewModel.shiftStatus.value is ShiftStatus.NoSchedule)
        assertFalse(viewModel.shiftStatus.value.isAvailableForOrders)

        val uiShifts = withTimeout(3000L) {
            viewModel.shifts.first { it.isEmpty() }
        }
        assertTrue("Expected UI shifts flow to emit empty list after deletion", uiShifts.isEmpty())

        val roomShifts = appDb.shiftDao().getShiftsForCaptainFlow(uid).first()
        assertTrue("Expected Room shifts to be cleared after canonical doc deletion", roomShifts.isEmpty())
    }

    // 2. تفريغ _liveShifts عند وجود المستند مع weeklySchedule فارغ أو بدون ورديات
    @Test
    fun canonicalSnapshotWithEmptyWeeklySchedule_emptiesLiveShiftsAndClearsRoom() = runBlocking {
        val uid = "captain_empty_schedule"

        viewModel.applyCanonicalShiftSnapshot(
            uid = uid,
            exists = true,
            docData = sampleWeeklyScheduleDoc(uid)
        )
        assertEquals(3, viewModel.liveShiftsState.value.size)

        // Case 2a: weeklySchedule is completely empty map
        viewModel.applyCanonicalShiftSnapshot(
            uid = uid,
            exists = true,
            docData = mapOf(
                "captainId" to uid,
                "weeklySchedule" to emptyMap<String, Any?>()
            )
        )

        assertTrue("Expected _liveShifts empty on empty weeklySchedule", viewModel.liveShiftsState.value.isEmpty())
        assertTrue(viewModel.shiftStatus.value is ShiftStatus.NoSchedule)
        assertTrue(appDb.shiftDao().getShiftsForCaptainFlow(uid).first().isEmpty())
        val uiShiftsAfterEmptyMap = withTimeout(3000L) {
            viewModel.shifts.first { it.isEmpty() }
        }
        assertTrue(uiShiftsAfterEmptyMap.isEmpty())

        // Re-populate and test Case 2b: days present in weeklySchedule but all shift arrays empty
        viewModel.applyCanonicalShiftSnapshot(
            uid = uid,
            exists = true,
            docData = sampleWeeklyScheduleDoc(uid)
        )
        assertEquals(3, viewModel.liveShiftsState.value.size)

        viewModel.applyCanonicalShiftSnapshot(
            uid = uid,
            exists = true,
            docData = mapOf(
                "captainId" to uid,
                "weeklySchedule" to mapOf(
                    "saturday" to mapOf(
                        "day" to "saturday",
                        "isDayOff" to false,
                        "shifts" to emptyList<Map<String, Any?>>()
                    )
                )
            )
        )

        assertTrue("Expected _liveShifts empty when day has zero shifts", viewModel.liveShiftsState.value.isEmpty())
        assertTrue(viewModel.shiftStatus.value is ShiftStatus.NoSchedule)
        assertTrue(appDb.shiftDao().getShiftsForCaptainFlow(uid).first().isEmpty())
    }

    // 3. حذف الورديات القديمة من Room بعد الحذف أو الفراغ وعدم رجوع الواجهة لبيانات قديمة
    @Test
    fun staleRoomShiftsAreRemovedAtomicallyAndUiDoesNotFallbackToOldRoomRows() = runBlocking {
        val uid = "captain_stale_room"
        val staleShift = ShiftEntity(
            id = "stale_shift_legacy_1",
            captainUid = uid,
            dayOfWeek = Calendar.MONDAY,
            dayNameArabic = "الإثنين",
            startTime = "09:00",
            endTime = "17:00",
            isDayOff = false
        )
        appDb.shiftDao().atomicReplaceCaptainShifts(uid, listOf(staleShift))
        assertEquals(1, appDb.shiftDao().getShiftsForCaptainFlow(uid).first().size)

        // Apply empty canonical snapshot
        viewModel.applyCanonicalShiftSnapshot(
            uid = uid,
            exists = true,
            docData = mapOf("weeklySchedule" to emptyMap<String, Any?>())
        )

        // Verify Room no longer holds the stale row
        val remainingInRoom = appDb.shiftDao().getShiftsForCaptainFlow(uid).first()
        assertTrue("Stale Room shifts must be atomically removed", remainingInRoom.isEmpty())

        // Even if a stray row existed in Room while canonical live snapshot is active and empty,
        // the UI shifts flow must honor the canonical empty snapshot instead of falling back to stale Room data.
        appDb.shiftDao().insertShift(staleShift)
        val uiShifts = withTimeout(3000L) {
            viewModel.shifts.first { it.isEmpty() }
        }
        assertTrue("UI must not fall back to stale Room shifts once canonical snapshot is empty", uiShifts.isEmpty())
    }

    // 4. عدم وجود مستمع مكرر أو قديم يعيد إدخال بيانات محذوفة
    @Test
    fun noDuplicateOrLegacyShiftListenersExistInViewModelAndLegacyDataIsNotReinserted() = runBlocking {
        val declaredFieldNames = CaptainViewModel::class.java.declaredFields.map { it.name }.toSet()
        assertTrue("Canonical shiftDocListener must exist", declaredFieldNames.contains("shiftDocListener"))
        assertFalse("Duplicate shiftQueryListener must be removed", declaredFieldNames.contains("shiftQueryListener"))
        assertFalse("Legacy captainDocListener must be removed", declaredFieldNames.contains("captainDocListener"))

        val shiftListenerFields = CaptainViewModel::class.java.declaredFields.filter { field ->
            ListenerRegistration::class.java.isAssignableFrom(field.type) &&
                field.name.contains("shift", ignoreCase = true)
        }
        assertEquals(
            "CaptainViewModel must hold exactly one canonical shift ListenerRegistration",
            1,
            shiftListenerFields.size
        )

        // Behavioral check: when canonical doc exists with empty schedule, legacy candidates are ignored and never re-inserted
        val uid = "captain_no_legacy_reinsert"
        val repo = CaptainRepository(
            captainDao = inMemoryDb.captainDao(),
            orderDao = inMemoryDb.orderDao(),
            shiftDao = inMemoryDb.shiftDao(),
            context = appContext
        )
        val oldLegacyShifts = listOf(
            ShiftEntity(
                id = "legacy_reinsert_1",
                captainUid = uid,
                dayOfWeek = Calendar.TUESDAY,
                dayNameArabic = "الثلاثاء",
                startTime = "08:00",
                endTime = "16:00",
                isDayOff = false,
                updatedAt = 999_999L
            )
        )
        repo.saveShiftsLocally(uid, oldLegacyShifts)
        assertEquals(1, inMemoryDb.shiftDao().getShiftsForCaptainFlow(uid).first().size)

        val result = repo.syncShiftsUsingResolvedSources(
            uid = uid,
            canonicalDocExists = true,
            canonicalDocData = mapOf("weeklySchedule" to emptyMap<String, Any?>()),
            legacyCandidateLists = listOf(oldLegacyShifts)
        )
        assertTrue("Canonical empty doc must win over stale legacy candidates", result.isEmpty())
        assertTrue(
            "Room must stay empty and legacy candidates must NOT be re-inserted",
            inMemoryDb.shiftDao().getShiftsForCaptainFlow(uid).first().isEmpty()
        )
    }

    // 5. جمع ساعات جميع ورديات العمل في اليوم الواحد (مع تجاهل الإجازات ودعم الورديات الممتدة > 12 ساعة)
    @Test
    fun dailyWorkHoursSumsAllNonDayOffShiftsIncludingMultipleAndLongOvernight() {
        val saturdayCal = Calendar.getInstance(ShiftManager.CAIRO_TIME_ZONE).apply {
            set(Calendar.DAY_OF_WEEK, Calendar.SATURDAY)
            set(Calendar.HOUR_OF_DAY, 10)
            set(Calendar.MINUTE, 0)
        }
        val saturdayShifts = listOf(
            ShiftEntity(
                id = "sat_1",
                captainUid = "c1",
                dayOfWeek = Calendar.SATURDAY,
                dayNameArabic = "السبت",
                startTime = "06:00",
                endTime = "12:00", // 6.0h
                isDayOff = false
            ),
            ShiftEntity(
                id = "sat_2",
                captainUid = "c1",
                dayOfWeek = Calendar.SATURDAY,
                dayNameArabic = "السبت",
                startTime = "14:00",
                endTime = "22:00", // 8.0h
                isDayOff = false
            ),
            ShiftEntity(
                id = "sat_off",
                captainUid = "c1",
                dayOfWeek = Calendar.SATURDAY,
                dayNameArabic = "السبت",
                startTime = "00:00",
                endTime = "08:00",
                isDayOff = true // Must be ignored
            ),
            ShiftEntity(
                id = "sun_other_day",
                captainUid = "c1",
                dayOfWeek = Calendar.SUNDAY,
                dayNameArabic = "الأحد",
                startTime = "10:00",
                endTime = "18:00",
                isDayOff = false // Different day; must be ignored
            )
        )
        assertEquals(14.0, CaptainViewModel.calculateDailyWorkHours(saturdayShifts, saturdayCal), 0.01)

        // Overnight shift exceeding 12 hours (14:00 -> 12:00 next day = 22.0h)
        val sundayCal = Calendar.getInstance(ShiftManager.CAIRO_TIME_ZONE).apply {
            set(Calendar.DAY_OF_WEEK, Calendar.SUNDAY)
            set(Calendar.HOUR_OF_DAY, 15)
            set(Calendar.MINUTE, 0)
        }
        val longOvernightShifts = listOf(
            ShiftEntity(
                id = "sun_long",
                captainUid = "c1",
                dayOfWeek = Calendar.SUNDAY,
                dayNameArabic = "الأحد",
                startTime = "14:00",
                endTime = "12:00", // 22.0h
                isDayOff = false
            )
        )
        assertEquals(22.0, CaptainViewModel.calculateDailyWorkHours(longOvernightShifts, sundayCal), 0.01)

        // Multiple shifts including an overnight shift on the same day (3.5h + 14.0h = 17.5h)
        val multiWithOvernight = listOf(
            ShiftEntity(
                id = "sun_morning",
                captainUid = "c1",
                dayOfWeek = Calendar.SUNDAY,
                dayNameArabic = "الأحد",
                startTime = "08:00",
                endTime = "11:30", // 3.5h
                isDayOff = false
            ),
            ShiftEntity(
                id = "sun_overnight",
                captainUid = "c1",
                dayOfWeek = Calendar.SUNDAY,
                dayNameArabic = "الأحد",
                startTime = "18:00",
                endTime = "08:00", // 14.0h
                isDayOff = false
            )
        )
        assertEquals(17.5, CaptainViewModel.calculateDailyWorkHours(multiWithOvernight, sundayCal), 0.01)

        // Day off only -> 0.0h
        val dayOffOnly = listOf(
            ShiftEntity(
                id = "fri_off",
                captainUid = "c1",
                dayOfWeek = Calendar.SUNDAY,
                dayNameArabic = "الأحد",
                startTime = "09:00",
                endTime = "17:00",
                isDayOff = true
            )
        )
        assertEquals(0.0, CaptainViewModel.calculateDailyWorkHours(dayOffOnly, sundayCal), 0.01)
    }

    // 6. دقة حالة الوردية الممتدة بعد منتصف الليل (> 12 ساعة)
    @Test
    fun longOvernightShiftStatusRemainsAccurateAfterMidnight() {
        val sundayOvernight = ShiftEntity(
            id = "shift_sun_22h",
            captainUid = "captain_overnight",
            dayOfWeek = Calendar.SUNDAY,
            dayNameArabic = "الأحد",
            startTime = "14:00",
            endTime = "12:00", // 22 hours, ends Monday 12:00
            isDayOff = false
        )
        val schedule = listOf(sundayOvernight)

        fun cairoCal(dayOfWeek: Int, hour: Int, minute: Int): Calendar =
            Calendar.getInstance(ShiftManager.CAIRO_TIME_ZONE).apply {
                set(Calendar.DAY_OF_WEEK, dayOfWeek)
                set(Calendar.HOUR_OF_DAY, hour)
                set(Calendar.MINUTE, minute)
                set(Calendar.SECOND, 0)
                set(Calendar.MILLISECOND, 0)
            }

        // Before midnight on Sunday (23:30) -> Active
        val beforeMidnight = ShiftManager.calculateShiftStatus(schedule, cairoCal(Calendar.SUNDAY, 23, 30))
        assertTrue("Expected Active before midnight", beforeMidnight is ShiftStatus.Active)
        assertTrue(beforeMidnight.isAvailableForOrders)

        // Just after midnight on Monday (00:15) -> Active
        val justAfterMidnight = ShiftManager.calculateShiftStatus(schedule, cairoCal(Calendar.MONDAY, 0, 15))
        assertTrue("Expected Active at 00:15 after midnight", justAfterMidnight is ShiftStatus.Active)
        assertEquals("shift_sun_22h", (justAfterMidnight as ShiftStatus.Active).shift.id)

        // Early morning Monday (03:00) -> Active
        val at3Am = ShiftManager.calculateShiftStatus(schedule, cairoCal(Calendar.MONDAY, 3, 0))
        assertTrue("Expected Active at 03:00 after midnight", at3Am is ShiftStatus.Active)

        // Late morning Monday (11:59, 1 minute before actual end) -> Active
        val oneMinBeforeEnd = ShiftManager.calculateShiftStatus(schedule, cairoCal(Calendar.MONDAY, 11, 59))
        assertTrue("Expected Active at 11:59 before 12:00 end", oneMinBeforeEnd is ShiftStatus.Active)

        // After shift end on Monday (12:05) -> OutsideShift
        val afterEnd = ShiftManager.calculateShiftStatus(schedule, cairoCal(Calendar.MONDAY, 12, 5))
        assertTrue("Expected OutsideShift after 12:00 end", afterEnd is ShiftStatus.OutsideShift)
        assertFalse(afterEnd.isAvailableForOrders)
    }

    // 7. تفريغ Room في المزامنة اليدوية عند غياب المستند الأساسي وعدم وجود Fallback صالح
    @Test
    fun manualSyncClearsRoomWhenCanonicalDocAbsentAndNoValidLegacyFallback() = runBlocking(Dispatchers.IO) {
        val uid = "captain_manual_sync"
        val repo = CaptainRepository(
            captainDao = inMemoryDb.captainDao(),
            orderDao = inMemoryDb.orderDao(),
            shiftDao = inMemoryDb.shiftDao(),
            context = appContext
        )

        val existingRoomShifts = listOf(
            ShiftEntity(
                id = "old_room_1",
                captainUid = uid,
                dayOfWeek = Calendar.WEDNESDAY,
                dayNameArabic = "الأربعاء",
                startTime = "09:00",
                endTime = "17:00",
                isDayOff = false,
                updatedAt = 1_000L
            )
        )
        repo.saveShiftsLocally(uid, existingRoomShifts)
        assertEquals(1, inMemoryDb.shiftDao().getShiftsForCaptainFlow(uid).first().size)

        // Canonical doc absent AND no valid legacy candidates -> MUST clear Room
        val syncedEmpty = repo.syncShiftsUsingResolvedSources(
            uid = uid,
            canonicalDocExists = false,
            canonicalDocData = null,
            legacyCandidateLists = listOf(emptyList())
        )
        assertTrue("Manual sync must return empty list when no canonical or legacy shifts exist", syncedEmpty.isEmpty())
        assertTrue(
            "Manual sync must clear old Room shifts when canonical doc is absent and no valid legacy fallback exists",
            inMemoryDb.shiftDao().getShiftsForCaptainFlow(uid).first().isEmpty()
        )

        // Backward compatibility: canonical doc absent WITH valid legacy fallback -> saves newest valid legacy fallback
        val olderLegacy = listOf(
            ShiftEntity(
                id = "legacy_old",
                captainUid = uid,
                dayOfWeek = Calendar.THURSDAY,
                dayNameArabic = "الخميس",
                startTime = "08:00",
                endTime = "14:00",
                isDayOff = false,
                updatedAt = 2_000L
            )
        )
        val newerLegacy = listOf(
            ShiftEntity(
                id = "legacy_new",
                captainUid = uid,
                dayOfWeek = Calendar.THURSDAY,
                dayNameArabic = "الخميس",
                startTime = "10:00",
                endTime = "20:00",
                isDayOff = false,
                updatedAt = 5_000L
            )
        )
        val syncedLegacy = repo.syncShiftsUsingResolvedSources(
            uid = uid,
            canonicalDocExists = false,
            canonicalDocData = null,
            legacyCandidateLists = listOf(olderLegacy, newerLegacy)
        )
        assertEquals(1, syncedLegacy.size)
        assertEquals("legacy_new", syncedLegacy.first().id)
        val storedAfterLegacy = inMemoryDb.shiftDao().getShiftsForCaptainFlow(uid).first()
        assertEquals(1, storedAfterLegacy.size)
        assertEquals("legacy_new", storedAfterLegacy.first().id)
    }
}
