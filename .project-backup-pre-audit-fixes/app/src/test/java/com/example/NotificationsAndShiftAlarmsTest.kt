package com.example

import android.Manifest
import android.app.AlarmManager
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.example.data.ShiftEntity
import com.example.data.ShiftManager
import com.example.notifications.CaptainNotificationManager
import com.example.notifications.ShiftNotificationScheduler
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import java.util.Calendar

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class NotificationsAndShiftAlarmsTest {

    private lateinit var appContext: Application
    private lateinit var notificationManager: NotificationManager
    private lateinit var alarmManager: AlarmManager

    @Before
    fun setUp() {
        appContext = ApplicationProvider.getApplicationContext()
        CaptainNotificationManager.clearNotificationState(appContext)
        ShiftNotificationScheduler.cancelAllShiftAlarms(appContext)
        notificationManager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        alarmManager = appContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    }

    @Test
    fun `computeTriggersForShifts schedules same-day, overnight, and skips day-off in Cairo timezone`() {
        val nowCal = Calendar.getInstance(ShiftManager.CAIRO_TIME_ZONE).apply {
            set(2026, Calendar.NOVEMBER, 15, 10, 0, 0) // Sunday 10:00 AM Cairo
            set(Calendar.MILLISECOND, 0)
        }
        val nowMs = nowCal.timeInMillis

        val shifts = listOf(
            ShiftEntity(
                id = "cap1_sun",
                captainUid = "cap1",
                dayOfWeek = Calendar.SUNDAY,
                dayNameArabic = "الأحد",
                startTime = "12:00",
                endTime = "20:00",
                isDayOff = false
            ),
            ShiftEntity(
                id = "cap1_thu",
                captainUid = "cap1",
                dayOfWeek = Calendar.THURSDAY,
                dayNameArabic = "الخميس",
                startTime = "22:00",
                endTime = "04:00",
                isDayOff = false
            ),
            ShiftEntity(
                id = "cap1_fri",
                captainUid = "cap1",
                dayOfWeek = Calendar.FRIDAY,
                dayNameArabic = "الجمعة",
                startTime = "12:00",
                endTime = "20:00",
                isDayOff = true
            )
        )

        val triggers = ShiftNotificationScheduler.computeTriggersForShifts(shifts, nowMs)
        // 2 active shifts => 4 triggers (start + end each), off-day skipped
        assertEquals(4, triggers.size)

        val sunStart = triggers.first { it.dayOfWeek == Calendar.SUNDAY && it.isStart }
        val sunEnd = triggers.first { it.dayOfWeek == Calendar.SUNDAY && !it.isStart }
        val sunStartCal = Calendar.getInstance(ShiftManager.CAIRO_TIME_ZONE).apply { timeInMillis = sunStart.triggerAtMillis }
        val sunEndCal = Calendar.getInstance(ShiftManager.CAIRO_TIME_ZONE).apply { timeInMillis = sunEnd.triggerAtMillis }

        assertEquals(Calendar.SUNDAY, sunStartCal.get(Calendar.DAY_OF_WEEK))
        assertEquals(12, sunStartCal.get(Calendar.HOUR_OF_DAY))
        assertEquals(Calendar.SUNDAY, sunEndCal.get(Calendar.DAY_OF_WEEK))
        assertEquals(20, sunEndCal.get(Calendar.HOUR_OF_DAY))

        // Overnight shift starting Thursday 22:00 must end Friday 04:00 Cairo time
        val thuStart = triggers.first { it.dayOfWeek == Calendar.THURSDAY && it.isStart }
        val thuEnd = triggers.first { it.dayOfWeek == Calendar.THURSDAY && !it.isStart }
        val thuStartCal = Calendar.getInstance(ShiftManager.CAIRO_TIME_ZONE).apply { timeInMillis = thuStart.triggerAtMillis }
        val thuEndCal = Calendar.getInstance(ShiftManager.CAIRO_TIME_ZONE).apply { timeInMillis = thuEnd.triggerAtMillis }

        assertEquals(Calendar.THURSDAY, thuStartCal.get(Calendar.DAY_OF_WEEK))
        assertEquals(22, thuStartCal.get(Calendar.HOUR_OF_DAY))
        assertEquals(Calendar.FRIDAY, thuEndCal.get(Calendar.DAY_OF_WEEK))
        assertEquals(4, thuEndCal.get(Calendar.HOUR_OF_DAY))
    }

    @Test
    fun `scheduleShiftNotifications registers AlarmManager triggers and cancelAllShiftAlarms removes them`() {
        val shifts = listOf(
            ShiftEntity(
                id = "cap1_sat",
                captainUid = "cap1",
                dayOfWeek = Calendar.SATURDAY,
                dayNameArabic = "السبت",
                startTime = "14:00",
                endTime = "22:00",
                isDayOff = false
            ),
            ShiftEntity(
                id = "cap1_sun",
                captainUid = "cap1",
                dayOfWeek = Calendar.SUNDAY,
                dayNameArabic = "الأحد",
                startTime = "14:00",
                endTime = "22:00",
                isDayOff = false
            )
        )

        ShiftNotificationScheduler.scheduleShiftNotifications(
            context = appContext,
            shifts = shifts,
            captainUid = "cap1"
        )

        val shadowAlarm = Shadows.shadowOf(alarmManager)
        assertEquals(4, shadowAlarm.scheduledAlarms.size)

        ShiftNotificationScheduler.cancelAllShiftAlarms(appContext)
        assertEquals(0, shadowAlarm.scheduledAlarms.size)
    }

    @Test
    fun `notification channels and order plus shift alerts respect permission and deduplicate`() {
        // Without POST_NOTIFICATIONS on Android 13+, posting is safely skipped
        Shadows.shadowOf(appContext).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val blockedResult = CaptainNotificationManager.showNewOrderNotification(
            context = appContext,
            orderKey = "ord_blocked",
            storeName = "مطعم التجربة",
            deliveryFee = 30.0
        )
        assertFalse(blockedResult)

        // Grant permission
        Shadows.shadowOf(appContext).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)

        // Ensure channels are registered with IMPORTANCE_HIGH
        CaptainNotificationManager.ensureNotificationChannels(appContext)
        val ordersChannel = notificationManager.getNotificationChannel(CaptainNotificationManager.CHANNEL_NEW_ORDERS_ID)
        val shiftsChannel = notificationManager.getNotificationChannel(CaptainNotificationManager.CHANNEL_SHIFT_ALERTS_ID)
        assertNotNull(ordersChannel)
        assertNotNull(shiftsChannel)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, ordersChannel.importance)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, shiftsChannel.importance)

        val shadowNotif = Shadows.shadowOf(notificationManager)
        notificationManager.cancelAll()

        // 1. New order notification
        val firstOrderPosted = CaptainNotificationManager.showNewOrderNotification(
            context = appContext,
            orderKey = "order_doc_abc",
            storeName = "كنتاكي",
            pickupAddress = "شارع التحرير",
            deliveryAddress = "مدينة نصر",
            deliveryFee = 35.0
        )
        assertTrue(firstOrderPosted)
        // Same order key deduplicated automatically
        val duplicateOrderPosted = CaptainNotificationManager.showNewOrderNotification(
            context = appContext,
            orderKey = "order_doc_abc",
            storeName = "كنتاكي",
            deliveryFee = 35.0
        )
        assertFalse(duplicateOrderPosted)

        // 2. Shift start & shift end notifications
        val startPosted = CaptainNotificationManager.showShiftStartNotification(
            context = appContext,
            dayNameArabic = "الأحد",
            startFormatted = "12:00 م",
            endFormatted = "8:00 م",
            dedupeKey = "2026-11-15_1_start"
        )
        val startDuplicate = CaptainNotificationManager.showShiftStartNotification(
            context = appContext,
            dayNameArabic = "الأحد",
            startFormatted = "12:00 م",
            endFormatted = "8:00 م",
            dedupeKey = "2026-11-15_1_start"
        )
        val endPosted = CaptainNotificationManager.showShiftEndNotification(
            context = appContext,
            dayNameArabic = "الأحد",
            endFormatted = "8:00 م",
            dedupeKey = "2026-11-15_1_end"
        )
        assertTrue(startPosted)
        assertFalse(startDuplicate)
        assertTrue(endPosted)

        val posted = shadowNotif.allNotifications
        assertEquals(3, posted.size)
        val titles = posted.map { it.extras.getString(Notification.EXTRA_TITLE).orEmpty() }
        assertTrue(titles.any { it.contains("طلب توصيل جديد") })
        assertTrue(titles.any { it.contains("بدأ شفت عملك") })
        assertTrue(titles.any { it.contains("انتهى شفت عملك") })
    }
}
