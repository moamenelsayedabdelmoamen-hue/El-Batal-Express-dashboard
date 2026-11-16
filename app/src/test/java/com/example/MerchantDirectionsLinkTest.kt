package com.example

import android.app.Application
import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import com.example.data.OrderEntity
import com.example.data.OrderStatus
import com.example.data.extractMerchantLocationUrlFromFieldsMap
import com.example.data.normalizeLocationUrl
import com.example.ui.components.ActiveOrderCard
import com.example.ui.components.buildGoogleMapsViewIntent
import com.example.ui.theme.ElBatalTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w411dp-h1200dp")
class MerchantDirectionsLinkTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun extractMerchantLocationUrl_parsesDirectNestedAndPrefixedUrls() {
        val sampleShortUrl = "https://maps.app.goo.gl/XyZ123456"
        assertEquals(
            sampleShortUrl,
            extractMerchantLocationUrlFromFieldsMap(mapOf("locationUrl" to sampleShortUrl))
        )
        assertEquals(
            "https://maps.google.com/?q=30.0444,31.2357",
            extractMerchantLocationUrlFromFieldsMap(
                mapOf("merchant" to mapOf("googleMapsUrl" to "maps.google.com/?q=30.0444,31.2357"))
            )
        )
        assertEquals(
            sampleShortUrl,
            extractMerchantLocationUrlFromFieldsMap(
                mapOf("storeLocationLink" to mapOf("url" to "  $sampleShortUrl  "))
            )
        )
        // Plain street address in 'location' must NOT be treated as a map URL
        assertEquals(
            "",
            extractMerchantLocationUrlFromFieldsMap(mapOf("location" to "شارع التحرير، الدقي"))
        )
        assertEquals("", normalizeLocationUrl("null"))
    }

    @Test
    fun buildGoogleMapsViewIntent_targetsGoogleMapsAppWithNormalizedUrl() {
        val intent = buildGoogleMapsViewIntent("maps.app.goo.gl/ElBatalMerchant", forceMapsPackage = true)
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals("com.google.android.apps.maps", intent.`package`)
        assertEquals("https://maps.app.goo.gl/ElBatalMerchant", intent.dataString)
    }

    @Test
    fun pressingDirections_displaysMerchantLocationLinkDialogAndOpensGoogleMapsOnTap() {
        val merchantMapUrl = "https://maps.app.goo.gl/MerchantSpot99"
        val orderWithLink = OrderEntity(
            id = 77L,
            orderNumber = "UUID-77",
            orderCode = "ELB-77",
            customerName = "أحمد سامي",
            customerPhone = "01011223344",
            storeName = "مطعم الأبطال",
            pickupAddress = "شارع جامعة الدول العربية",
            deliveryAddress = "الزمالك",
            merchantId = "merch_77",
            storeLocationUrl = merchantMapUrl,
            itemsSummary = "وجبة",
            itemsCount = 1,
            orderTotalAmount = 250.0,
            deliveryFee = 35.0,
            distanceKm = 2.4,
            status = OrderStatus.ACCEPTED
        )

        var refreshCalled = false
        composeTestRule.setContent {
            ElBatalTheme {
                ActiveOrderCard(
                    order = orderWithLink,
                    onMarkArrivedAtMerchant = {},
                    onConfirmPickup = {},
                    onOpenCustomerDataEntry = {},
                    onCompleteDelivery = {},
                    onRefreshMerchantLocation = { refreshCalled = true }
                )
            }
        }

        // Before pressing Directions, dialog is closed
        assertTrue(
            composeTestRule.onAllNodesWithTag("merchant_location_link_dialog")
                .fetchSemanticsNodes()
                .isEmpty()
        )

        // Press "الاتجاهات"
        composeTestRule.onNodeWithTag("merchant_directions_button").performClick()

        assertTrue(refreshCalled)
        composeTestRule.onNodeWithTag("merchant_location_link_dialog").assertIsDisplayed()
        composeTestRule.onNodeWithTag("merchant_location_url_card").assertIsDisplayed()
        composeTestRule.onNodeWithText(merchantMapUrl).assertIsDisplayed()
        composeTestRule.onNodeWithTag("open_google_maps_button").assertIsDisplayed()

        // Tap the merchant location link card -> launches ACTION_VIEW with the merchant URL
        val app = ApplicationProvider.getApplicationContext<Application>()
        val shadowApp = Shadows.shadowOf(app)
        shadowApp.clearNextStartedActivities()

        composeTestRule.onNodeWithTag("merchant_location_url_card").performClick()

        val startedIntent = shadowApp.nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, startedIntent.action)
        assertEquals(merchantMapUrl, startedIntent.dataString)
        assertEquals("com.google.android.apps.maps", startedIntent.`package`)
    }

    @Test
    fun pressingDirections_whenMerchantHasNoUrl_showsMissingLinkNoticeAndFallbackButton() {
        val orderWithoutLink = OrderEntity(
            id = 88L,
            orderNumber = "UUID-88",
            customerName = "عميل",
            customerPhone = "01000000000",
            storeName = "مطعم الشام",
            pickupAddress = "مدينة نصر",
            deliveryAddress = "مصر الجديدة",
            storeLocationUrl = "",
            restaurantLatitude = 30.0561,
            restaurantLongitude = 31.3301,
            itemsSummary = "شاورما",
            itemsCount = 1,
            orderTotalAmount = 150.0,
            deliveryFee = 25.0,
            distanceKm = 3.0,
            status = OrderStatus.ACCEPTED
        )

        composeTestRule.setContent {
            ElBatalTheme {
                ActiveOrderCard(
                    order = orderWithoutLink,
                    onMarkArrivedAtMerchant = {},
                    onConfirmPickup = {},
                    onOpenCustomerDataEntry = {},
                    onCompleteDelivery = {}
                )
            }
        }

        composeTestRule.onNodeWithTag("merchant_directions_button").performClick()

        composeTestRule.onNodeWithTag("merchant_location_link_dialog").assertIsDisplayed()
        composeTestRule.onNodeWithTag("merchant_location_missing_notice").assertIsDisplayed()
        composeTestRule.onNodeWithTag("open_google_maps_fallback_button").assertIsDisplayed()
    }
}
