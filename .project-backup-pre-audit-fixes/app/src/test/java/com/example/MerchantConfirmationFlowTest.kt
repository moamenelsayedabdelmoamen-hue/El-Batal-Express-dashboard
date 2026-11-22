package com.example

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.example.data.CaptainEntity
import com.example.data.OrderEntity
import com.example.data.OrderStatus
import com.example.data.ShiftStatus
import com.example.data.extractMerchantConfirmedFromFieldsMap
import com.example.data.resolveOrderStatusFromFirestoreFields
import com.example.ui.screens.DashboardScreen
import com.example.ui.theme.ElBatalTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w411dp-h1200dp")
class MerchantConfirmationFlowTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun resolveOrderStatus_allMerchantConfirmedVariantsResolveToEnRouteNeverPending() {
        val confirmationStatuses = listOf(
            "en_route",
            "enRoute",
            "en-route",
            "on_way",
            "onTheWay",
            "out_for_delivery",
            "outForDelivery",
            "in_delivery",
            "delivering",
            "dispatched",
            "confirmed",
            "merchant_confirmed",
            "merchantConfirmed",
            "confirmed_by_merchant",
            "order_confirmed",
            "order_data_confirmed",
            "data_confirmed",
            "receipt_confirmed",
            "approved",
            "merchant_approved",
            "ready_for_delivery",
            "readyToDeliver",
            "تم التأكيد",
            "تم تأكيد التاجر",
            "تم تأكيد الطلب",
            "تم تأكيد بيانات الطلب",
            "مؤكد",
            "جاهز للتسليم",
            "جاري التوصيل"
        )

        for (rawStatus in confirmationStatuses) {
            val resolved = resolveOrderStatusFromFirestoreFields(
                rawStatus = rawStatus,
                captainId = "cap_123",
                merchantConfirmedFlag = false,
                hasReceiptOrOrderData = true,
                hasAcceptedAt = true
            )
            assertEquals("Status '$rawStatus' should resolve to EN_ROUTE", OrderStatus.EN_ROUTE, resolved.status)
            assertTrue("Status '$rawStatus' should mark merchantConfirmed=true", resolved.merchantConfirmed)
            assertNotEquals(OrderStatus.PENDING, resolved.status)
        }
    }

    @Test
    fun resolveOrderStatus_merchantConfirmedBooleanOrReadyWithReceiptPromotesToEnRoute() {
        // Even if status text remains awaiting_merchant_confirmation or pending, merchantConfirmed=true promotes to EN_ROUTE
        val fromAwaiting = resolveOrderStatusFromFirestoreFields(
            rawStatus = "awaiting_merchant_confirmation",
            captainId = "cap_123",
            merchantConfirmedFlag = true,
            hasReceiptOrOrderData = true
        )
        assertEquals(OrderStatus.EN_ROUTE, fromAwaiting.status)
        assertTrue(fromAwaiting.merchantConfirmed)

        val fromPendingStatusWithFlag = resolveOrderStatusFromFirestoreFields(
            rawStatus = "pending",
            captainId = "cap_123",
            merchantConfirmedFlag = true,
            hasReceiptOrOrderData = true
        )
        assertEquals(OrderStatus.EN_ROUTE, fromPendingStatusWithFlag.status)
        assertTrue(fromPendingStatusWithFlag.merchantConfirmed)

        // Assigned order that already has receipt data and merchant sets status="ready" must advance to EN_ROUTE (not PENDING)
        val readyWithReceipt = resolveOrderStatusFromFirestoreFields(
            rawStatus = "ready",
            captainId = "cap_123",
            merchantConfirmedFlag = false,
            hasReceiptOrOrderData = true
        )
        assertEquals(OrderStatus.EN_ROUTE, readyWithReceipt.status)
        assertTrue(readyWithReceipt.merchantConfirmed)

        // Meanwhile unassigned pending/ready order stays PENDING for pickup
        val unassignedReady = resolveOrderStatusFromFirestoreFields(
            rawStatus = "ready",
            captainId = "",
            merchantConfirmedFlag = false,
            hasReceiptOrOrderData = false
        )
        assertEquals(OrderStatus.PENDING, unassignedReady.status)
        assertFalse(unassignedReady.merchantConfirmed)
    }

    @Test
    fun extractMerchantConfirmedFromFieldsMap_detectsSnakeCamelStatusAndTimestamp() {
        assertTrue(extractMerchantConfirmedFromFieldsMap(mapOf("merchantConfirmed" to true)))
        assertTrue(extractMerchantConfirmedFromFieldsMap(mapOf("merchant_confirmed" to true)))
        assertTrue(extractMerchantConfirmedFromFieldsMap(mapOf("isMerchantConfirmed" to "true")))
        assertTrue(extractMerchantConfirmedFromFieldsMap(mapOf("confirmedByMerchant" to 1L)))
        assertTrue(extractMerchantConfirmedFromFieldsMap(mapOf("merchantApproved" to true)))
        assertTrue(extractMerchantConfirmedFromFieldsMap(mapOf("confirmationStatus" to "confirmed")))
        assertTrue(extractMerchantConfirmedFromFieldsMap(mapOf("merchantStatus" to "تم التأكيد")))
        assertTrue(extractMerchantConfirmedFromFieldsMap(mapOf("merchantConfirmedAt" to 1730000000000L)))

        assertFalse(extractMerchantConfirmedFromFieldsMap(mapOf("merchantConfirmed" to false)))
        assertFalse(extractMerchantConfirmedFromFieldsMap(mapOf("merchantStatus" to "rejected")))
        assertFalse(extractMerchantConfirmedFromFieldsMap(emptyMap()))
    }

    @Test
    fun dashboardScreen_whenMerchantConfirmsOrderData_transitionsToDeliverToCustomerButtonWithoutNewOrderUi() {
        val captain = CaptainEntity(
            id = 1,
            uid = "cap_1",
            fullName = "كابتن أحمد",
            phoneNumber = "01000000001",
            isOnline = true,
            isLoggedIn = true,
            status = "active"
        )
        val initialAwaitingOrder = OrderEntity(
            id = 9001L,
            orderNumber = "UUID-9001",
            orderCode = "ELB-9001",
            customerName = "محمود حسن",
            customerPhone = "01099887766",
            storeName = "مطعم الشرق",
            pickupAddress = "شارع التحرير",
            deliveryAddress = "مدينة نصر، عباس العقاد",
            itemsSummary = "وجبة غداء",
            itemsCount = 1,
            orderTotalAmount = 320.0,
            deliveryFee = 40.0,
            distanceKm = 4.2,
            status = OrderStatus.AWAITING_MERCHANT_CONFIRMATION,
            captainId = "cap_1",
            receiptImagePath = "orders/UUID-9001/receipts/r1.jpg",
            merchantConfirmed = false
        )

        var currentActiveOrder by mutableStateOf<OrderEntity?>(initialAwaitingOrder)
        var deliverClickedOrderId: Long? = null

        composeTestRule.setContent {
            ElBatalTheme {
                DashboardScreen(
                    captain = captain,
                    activeOrder = currentActiveOrder,
                    availableOrders = emptyList(),
                    pendingIncomingOrder = null,
                    completedCount = 3,
                    totalEarnings = 120.0,
                    shiftStatus = ShiftStatus.NoSchedule(),
                    onToggleOnline = {},
                    onAcceptOrder = {},
                    onAdvanceOrderStatus = { order ->
                        deliverClickedOrderId = order.id
                    }
                )
            }
        }

        // Step 1: Waiting for merchant confirmation -> no deliver button yet, waiting message displayed
        composeTestRule.onNodeWithText("تم إرسال البيانات للتاجر، وبانتظار المراجعة والتأكيد")
            .assertIsDisplayed()
        assertTrue(
            composeTestRule.onAllNodesWithText("قبول الطلب", substring = true)
                .fetchSemanticsNodes()
                .isEmpty()
        )

        // Step 2: Merchant presses "تأكيد بيانات الطلب" -> resolved via repository helper to EN_ROUTE
        val resolved = resolveOrderStatusFromFirestoreFields(
            rawStatus = "confirmed",
            captainId = "cap_1",
            merchantConfirmedFlag = true,
            hasReceiptOrOrderData = true
        )
        currentActiveOrder = initialAwaitingOrder.copy(
            status = resolved.status,
            merchantConfirmed = resolved.merchantConfirmed
        )
        composeTestRule.waitForIdle()

        // Step 3: Captain sees "تسليم الطلب للعميل 🏁" button immediately (NOT new order alert)
        composeTestRule.onNodeWithText("٥. أكد التاجر بيانات الطلب - جاهز لتسليم الطلب للعميل")
            .assertIsDisplayed()
        composeTestRule.onNodeWithTag("deliver_to_customer_button").assertIsDisplayed()
        composeTestRule.onNodeWithText("تسليم الطلب للعميل 🏁").assertIsDisplayed()
        assertTrue(
            composeTestRule.onAllNodesWithText("قبول الطلب", substring = true)
                .fetchSemanticsNodes()
                .isEmpty()
        )

        // Step 4: Captain clicks deliver button -> triggers delivery completion flow
        composeTestRule.onNodeWithTag("deliver_to_customer_button").performClick()
        assertEquals(9001L, deliverClickedOrderId)
    }
}
