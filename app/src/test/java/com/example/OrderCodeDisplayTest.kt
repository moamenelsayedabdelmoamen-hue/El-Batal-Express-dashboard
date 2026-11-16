package com.example

import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.example.data.OrderEntity
import com.example.data.OrderHistoryHelper
import com.example.data.OrderHistoryTab
import com.example.data.OrderStatus
import com.example.data.extractOrderCodeFromFieldsMap
import com.example.ui.components.ActiveOrderCard
import com.example.ui.components.AvailableTripCard
import com.example.ui.components.IncomingOrderAlert
import com.example.ui.screens.OrdersScreen
import com.example.ui.theme.ElBatalTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w411dp-h1400dp")
class OrderCodeDisplayTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun extractOrderCodeFromFieldsMap_handlesFirestoreVariationsAndArrays() {
        assertEquals(
            "ORD-7788",
            extractOrderCodeFromFieldsMap(mapOf("Ordar codes" to "ORD-7788"))
        )
        assertEquals(
            "CODE-101 • CODE-102",
            extractOrderCodeFromFieldsMap(mapOf("orderCodes" to listOf("CODE-101", "CODE-102", "CODE-101")))
        )
        assertEquals(
            "54321",
            extractOrderCodeFromFieldsMap(mapOf("order_codes" to 54321.0))
        )
        assertEquals(
            "TRK-99",
            extractOrderCodeFromFieldsMap(mapOf("orderCode" to "#TRK-99"))
        )
        assertEquals(
            "",
            extractOrderCodeFromFieldsMap(mapOf("Ordar codes" to "null", "order_code" to "  "))
        )
    }

    @Test
    fun orderCards_displayFirestoreOrderCodeWhileHidingUuidOrderNumber() {
        val uuidOrderNumber = "f791e123-8abc-4def-9012-abcdef123456"
        val activeOrder = OrderEntity(
            id = 10L,
            orderNumber = uuidOrderNumber,
            orderCode = "ELB-401",
            customerName = "عميل اختبار",
            customerPhone = "01012345678",
            storeName = "مطعم البطل",
            pickupAddress = "شارع التحرير",
            deliveryAddress = "المهندسين",
            itemsSummary = "وجبة مشويات",
            itemsCount = 1,
            orderTotalAmount = 220.0,
            deliveryFee = 35.0,
            distanceKm = 3.2,
            status = OrderStatus.ACCEPTED
        )
        val availableOrder = activeOrder.copy(
            id = 11L,
            orderNumber = "INTERNAL-UUID-22",
            orderCode = "ELB-502 • ELB-503",
            status = OrderStatus.PENDING,
            deliveryFee = 40.0
        )

        composeTestRule.setContent {
            ElBatalTheme {
                Column {
                    ActiveOrderCard(
                        order = activeOrder,
                        onMarkArrivedAtMerchant = {},
                        onConfirmPickup = {},
                        onOpenCustomerDataEntry = {},
                        onCompleteDelivery = {}
                    )
                    AvailableTripCard(
                        order = availableOrder,
                        onAcceptOrder = {}
                    )
                }
            }
        }

        composeTestRule.onNodeWithTag("active_order_code_badge").assertIsDisplayed()
        composeTestRule.onNodeWithText("كود الطلب: ELB-401").assertIsDisplayed()
        composeTestRule.onNodeWithTag("available_order_code_badge").assertIsDisplayed()
        composeTestRule.onNodeWithText("كود الطلب: ELB-502 • ELB-503").assertIsDisplayed()

        assertTrue(
            composeTestRule.onAllNodesWithText(uuidOrderNumber, substring = true)
                .fetchSemanticsNodes()
                .isEmpty()
        )
        assertTrue(
            composeTestRule.onAllNodesWithText("INTERNAL-UUID-22", substring = true)
                .fetchSemanticsNodes()
                .isEmpty()
        )
    }

    @Test
    fun incomingOrderAlert_displaysOrderCodeBadgeWhenPresent() {
        val offer = OrderEntity(
            id = 20L,
            orderNumber = "UUID-99",
            orderCode = "ORD-909",
            customerName = "أحمد علي",
            customerPhone = "01099998888",
            storeName = "KFC",
            pickupAddress = "فرع المعادي",
            deliveryAddress = "دجلة المعادي",
            itemsSummary = "وجبة عائلية",
            itemsCount = 2,
            orderTotalAmount = 350.0,
            deliveryFee = 45.0,
            distanceKm = 4.1,
            status = OrderStatus.PENDING,
            offerExpiresAt = System.currentTimeMillis() + 50_000L
        )

        composeTestRule.setContent {
            ElBatalTheme {
                IncomingOrderAlert(
                    order = offer,
                    onAccept = {}
                )
            }
        }

        composeTestRule.onNodeWithTag("incoming_order_code_badge").assertIsDisplayed()
        composeTestRule.onNodeWithText("كود الطلب: ORD-909").assertIsDisplayed()
    }

    @Test
    fun archivedOrdersScreen_displaysOrderCodeInCardAndDetailsSheet() {
        val now = System.currentTimeMillis()
        val todayKey = OrderHistoryHelper.getTodayDateKey()
        val completedOrder = OrderEntity(
            id = 30L,
            orderNumber = "HIST-30",
            orderCode = "CODE-888",
            customerName = "سارة حسن",
            customerPhone = "01122334455",
            storeName = "برجر كينج",
            pickupAddress = "مدينة نصر",
            deliveryAddress = "مصر الجديدة",
            itemsSummary = "كومبو",
            itemsCount = 1,
            orderTotalAmount = 190.0,
            deliveryFee = 30.0,
            distanceKm = 2.8,
            status = OrderStatus.DELIVERED,
            captainId = "cap_1",
            completedAt = now
        )

        composeTestRule.setContent {
            ElBatalTheme {
                OrdersScreen(
                    orders = listOf(completedOrder),
                    captainUid = "cap_1",
                    selectedDateKey = todayKey,
                    todayDateKey = todayKey,
                    selectedTab = OrderHistoryTab.COMPLETED
                )
            }
        }

        composeTestRule.onNodeWithTag("history_order_card_30").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithTag("archived_order_code_badge", useUnmergedTree = true).assertIsDisplayed()
        composeTestRule.onNodeWithText("كود الطلب: CODE-888").assertIsDisplayed()
        assertTrue(
            composeTestRule.onAllNodesWithText("HIST-30", substring = true)
                .fetchSemanticsNodes()
                .isEmpty()
        )

        composeTestRule.onNodeWithTag("history_order_card_30").performClick()
        composeTestRule.onNodeWithTag("archived_sheet_order_code_badge").assertIsDisplayed()
        composeTestRule.onNodeWithText("تفاصيل الطلب").assertIsDisplayed()
        assertTrue(
            composeTestRule.onAllNodesWithText("HIST-30", substring = true)
                .fetchSemanticsNodes()
                .isEmpty()
        )
    }

    @Test
    fun orderCards_omitCodeBadgeWhenOrderCodeBlank() {
        val orderWithoutCode = OrderEntity(
            id = 40L,
            orderNumber = "UUID-ONLY",
            orderCode = "",
            customerName = "محمود",
            customerPhone = "01000000001",
            storeName = "بيتزا هت",
            pickupAddress = "وسط البلد",
            deliveryAddress = "الزمالك",
            itemsSummary = "بيتزا",
            itemsCount = 1,
            orderTotalAmount = 200.0,
            deliveryFee = 25.0,
            distanceKm = 2.0,
            status = OrderStatus.PENDING
        )

        composeTestRule.setContent {
            ElBatalTheme {
                AvailableTripCard(
                    order = orderWithoutCode,
                    onAcceptOrder = {}
                )
            }
        }

        assertTrue(
            composeTestRule.onAllNodesWithTag("available_order_code_badge")
                .fetchSemanticsNodes()
                .isEmpty()
        )
    }
}
