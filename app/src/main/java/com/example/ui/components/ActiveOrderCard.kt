package com.example.ui.components

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import com.example.ui.icons.Directions
import com.example.ui.icons.HourglassTop
import com.example.ui.icons.Link
import com.example.ui.icons.Map
import com.example.ui.icons.NearMe
import com.example.ui.icons.OpenInNew
import com.example.ui.icons.ReceiptLong
import com.example.ui.icons.Storefront
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.example.data.OrderEntity
import com.example.data.OrderStatus
import com.example.ui.theme.DarkSurface
import com.example.ui.theme.DarkSurfaceVariant
import com.example.ui.theme.ExpressRed
import com.example.ui.theme.HeroYellow
import com.example.ui.theme.StatusOnlineGreen

@Composable
fun ActiveOrderCard(
    order: OrderEntity,
    isLoading: Boolean = false,
    onMarkArrivedAtMerchant: (Long) -> Unit,
    onConfirmPickup: (Long) -> Unit,
    onOpenCustomerDataEntry: (OrderEntity) -> Unit,
    onCompleteDelivery: (OrderEntity) -> Unit,
    onSimulateMerchantConfirm: ((Long, Boolean) -> Unit)? = null,
    onRefreshMerchantLocation: ((OrderEntity) -> Unit)? = null
) {
    val context = LocalContext.current
    var showMerchantDirectionsDialog by remember(order.id) { mutableStateOf(false) }

    val statusTitle = when (order.status) {
        OrderStatus.ACCEPTED -> "١. في الطريق إلى مقر التاجر"
        OrderStatus.AT_STORE -> "٢. تم الوصول للتاجر - قم باستلام الطلب"
        OrderStatus.PICKED_UP -> "٣. تم الاستلام - أدخل بيانات العميل والإيصال"
        OrderStatus.ORDER_DATA_ENTERED,
        OrderStatus.AWAITING_MERCHANT_CONFIRMATION -> "٤. بانتظار تأكيد التاجر ومراجعته للبيانات"
        OrderStatus.MERCHANT_REJECTED -> "⚠️ تم رفض البيانات من التاجر - يرجى تصحيحها"
        OrderStatus.EN_ROUTE -> "٥. أكد التاجر بيانات الطلب - جاهز لتسليم الطلب للعميل"
        OrderStatus.DELIVERED -> "تم تسليم الطلب بنجاح وإغلاق المستحقات"
        else -> "الطلب قيد التنفيذ"
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .border(2.dp, ExpressRed, RoundedCornerShape(22.dp)),
        shape = RoundedCornerShape(22.dp),
        colors = CardDefaults.cardColors(containerColor = DarkSurface)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(18.dp)
        ) {
            // Header: Active Order Label & Fee
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.weight(1f)
                ) {
                    Box(
                        modifier = Modifier
                            .size(10.dp)
                            .clip(CircleShape)
                            .background(StatusOnlineGreen)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "طلب نشط",
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
                        color = Color.White,
                        maxLines = 1
                    )
                }

                Spacer(modifier = Modifier.width(8.dp))

                Text(
                    text = "${order.deliveryFee.toInt()} ج.م",
                    style = MaterialTheme.typography.titleLarge.copy(
                        fontWeight = FontWeight.Black,
                        fontSize = 20.sp
                    ),
                    color = HeroYellow,
                    maxLines = 1,
                    softWrap = false
                )
            }

            if (order.cleanOrderCode.isNotBlank()) {
                Spacer(modifier = Modifier.height(10.dp))
                OrderCodeBadge(
                    orderCode = order.cleanOrderCode,
                    modifier = Modifier.fillMaxWidth(),
                    badgeTag = "active_order_code_badge"
                )
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Stepper (5 phases):
            // 1. القبول والتوجه | 2. الوصول والاستلام | 3. بيانات العميل | 4. تأكيد التاجر | 5. التسليم
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(DarkSurfaceVariant, RoundedCornerShape(12.dp))
                    .padding(8.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                val step1Done = true
                val step2Done = order.status != OrderStatus.ACCEPTED && order.status != OrderStatus.PENDING
                val step3Done = order.status in listOf(
                    OrderStatus.ORDER_DATA_ENTERED,
                    OrderStatus.AWAITING_MERCHANT_CONFIRMATION,
                    OrderStatus.EN_ROUTE,
                    OrderStatus.DELIVERED
                )
                val step4Done = order.merchantConfirmed || order.status == OrderStatus.EN_ROUTE || order.status == OrderStatus.DELIVERED
                val step5Done = order.status == OrderStatus.DELIVERED

                StepBadgeMini("التاجر", step1Done)
                StepBadgeMini("الاستلام", step2Done)
                StepBadgeMini("البيانات", step3Done)
                StepBadgeMini("تأكيد التاجر", step4Done)
                StepBadgeMini("التسليم", step5Done)
            }

            Spacer(modifier = Modifier.height(14.dp))

            // Current Stage Status Banner
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(
                    containerColor = when (order.status) {
                        OrderStatus.MERCHANT_REJECTED -> ExpressRed.copy(alpha = 0.2f)
                        OrderStatus.EN_ROUTE, OrderStatus.DELIVERED -> StatusOnlineGreen.copy(alpha = 0.2f)
                        else -> HeroYellow.copy(alpha = 0.15f)
                    }
                ),
                shape = RoundedCornerShape(12.dp)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        imageVector = when (order.status) {
                            OrderStatus.MERCHANT_REJECTED -> Icons.Default.Warning
                            OrderStatus.EN_ROUTE, OrderStatus.DELIVERED -> Icons.Default.CheckCircle
                            OrderStatus.AWAITING_MERCHANT_CONFIRMATION -> Icons.Default.HourglassTop
                            else -> Icons.Default.Info
                        },
                        contentDescription = null,
                        tint = when (order.status) {
                            OrderStatus.MERCHANT_REJECTED -> ExpressRed
                            OrderStatus.EN_ROUTE, OrderStatus.DELIVERED -> StatusOnlineGreen
                            else -> HeroYellow
                        },
                        modifier = Modifier.size(22.dp)
                    )
                    Spacer(modifier = Modifier.width(10.dp))
                    Text(
                        text = statusTitle,
                        style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold),
                        color = Color.White
                    )
                }
            }

            Spacer(modifier = Modifier.height(14.dp))

            // Merchant / Location Details Card
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = DarkSurfaceVariant),
                shape = RoundedCornerShape(16.dp)
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(14.dp)
                ) {
                    // Merchant line
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                imageVector = Icons.Default.Storefront,
                                contentDescription = null,
                                tint = HeroYellow,
                                modifier = Modifier.size(20.dp)
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(
                                text = "التاجر: ${order.storeName}",
                                style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
                                color = Color.White
                            )
                        }

                        if (order.storePhone.isNotBlank()) {
                            IconButton(
                                onClick = {
                                    val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:${order.storePhone}"))
                                    context.startActivity(intent)
                                },
                                modifier = Modifier.size(32.dp)
                            ) {
                                Icon(Icons.Default.Call, contentDescription = "اتصال بالتاجر", tint = StatusOnlineGreen)
                            }
                        }
                    }

                    Text(
                        text = "العنوان: ${order.pickupAddress.ifBlank { "مقر التاجر" }}",
                        style = MaterialTheme.typography.bodySmall,
                        color = Color.LightGray
                    )

                    Spacer(modifier = Modifier.height(10.dp))

                    // Customer line
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                imageVector = Icons.Default.LocationOn,
                                contentDescription = null,
                                tint = ExpressRed,
                                modifier = Modifier.size(20.dp)
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(
                                text = "العميل: ${order.customerName}",
                                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold),
                                color = Color.White
                            )
                        }

                        if (order.customerPhone.isNotBlank()) {
                            IconButton(
                                onClick = {
                                    val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:${order.customerPhone}"))
                                    context.startActivity(intent)
                                },
                                modifier = Modifier.size(32.dp)
                            ) {
                                Icon(Icons.Default.Call, contentDescription = "اتصال بالعميل", tint = StatusOnlineGreen)
                            }
                        }
                    }

                    Text(
                        text = "عنوان التسليم: ${order.deliveryAddress}",
                        style = MaterialTheme.typography.bodySmall,
                        color = Color.LightGray
                    )
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            // Dynamic Action Button Sequence based on server lifecycle:
            when (order.status) {
                // 1. ACCEPTED: Show Merchant Map, Directions, Call, and "تم الوصول إلى التاجر"
                OrderStatus.ACCEPTED -> {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        // Open Merchant Location Link Dialog
                        OutlinedButton(
                            onClick = {
                                onRefreshMerchantLocation?.invoke(order)
                                showMerchantDirectionsDialog = true
                            },
                            modifier = Modifier
                                .weight(1f)
                                .height(50.dp)
                                .testTag("merchant_directions_button"),
                            shape = RoundedCornerShape(12.dp),
                            border = BorderStroke(1.dp, HeroYellow)
                        ) {
                            Icon(Icons.Default.Directions, contentDescription = null, tint = HeroYellow)
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("الاتجاهات", color = HeroYellow)
                        }

                        // Button: "تم الوصول إلى التاجر"
                        Button(
                            onClick = { onMarkArrivedAtMerchant(order.id) },
                            enabled = !isLoading,
                            modifier = Modifier
                                .weight(1.5f)
                                .height(50.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = ExpressRed),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Icon(Icons.Default.CheckCircle, contentDescription = null, tint = Color.White)
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("تم الوصول للتاجر 📍", fontWeight = FontWeight.Bold, color = Color.White)
                        }
                    }
                }

                // 2. AT_STORE: "استلام الطلب"
                OrderStatus.AT_STORE -> {
                    Button(
                        onClick = { onConfirmPickup(order.id) },
                        enabled = !isLoading,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(52.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = HeroYellow, contentColor = Color.Black),
                        shape = RoundedCornerShape(14.dp)
                    ) {
                        Icon(Icons.Default.Storefront, contentDescription = null, modifier = Modifier.size(22.dp))
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "استلام الطلب من التاجر 📦",
                            style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold)
                        )
                    }
                }

                // 3. PICKED_UP: "إدخال بيانات العميل وصورة الإيصال"
                OrderStatus.PICKED_UP -> {
                    Button(
                        onClick = { onOpenCustomerDataEntry(order) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(52.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = ExpressRed),
                        shape = RoundedCornerShape(14.dp)
                    ) {
                        Icon(Icons.Default.ReceiptLong, contentDescription = null, modifier = Modifier.size(22.dp))
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "تسجيل بيانات العميل والإيصال 📷",
                            style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
                            color = Color.White
                        )
                    }
                }

                // 4. AWAITING_MERCHANT_CONFIRMATION:
                // Cannot click delivered yet! Waiting for merchant to confirm on server
                OrderStatus.ORDER_DATA_ENTERED,
                OrderStatus.AWAITING_MERCHANT_CONFIRMATION -> {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(containerColor = DarkSurfaceVariant),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(14.dp),
                                horizontalAlignment = Alignment.CenterHorizontally
                            ) {
                                CircularProgressIndicator(color = HeroYellow, modifier = Modifier.size(28.dp), strokeWidth = 3.dp)
                                Spacer(modifier = Modifier.height(10.dp))
                                Text(
                                    text = "تم إرسال البيانات للتاجر، وبانتظار المراجعة والتأكيد",
                                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
                                    color = Color.White,
                                    textAlign = TextAlign.Center
                                )
                                Text(
                                    text = "لا يمكن تسليم الطلب قبل اعتماد التاجر لبيانات الإيصال من لوحة التحكم.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = Color.LightGray,
                                    textAlign = TextAlign.Center
                                )
                            }
                        }

                        // Simulation button for testing merchant confirmation if enabled
                        if (onSimulateMerchantConfirm != null) {
                            Spacer(modifier = Modifier.height(10.dp))
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                OutlinedButton(
                                    onClick = { onSimulateMerchantConfirm(order.id, true) },
                                    modifier = Modifier.weight(1f),
                                    shape = RoundedCornerShape(10.dp),
                                    border = androidx.compose.foundation.BorderStroke(1.dp, StatusOnlineGreen)
                                ) {
                                    Text("محاكاة: تأكيد التاجر ✓", color = StatusOnlineGreen, fontSize = 11.sp)
                                }
                                OutlinedButton(
                                    onClick = { onSimulateMerchantConfirm(order.id, false) },
                                    modifier = Modifier.weight(1f),
                                    shape = RoundedCornerShape(10.dp),
                                    border = androidx.compose.foundation.BorderStroke(1.dp, ExpressRed)
                                ) {
                                    Text("محاكاة: رفض التاجر ✕", color = ExpressRed, fontSize = 11.sp)
                                }
                            }
                        }
                    }
                }

                // 5. MERCHANT_REJECTED: Rejection reason shown, button to correct and re-submit
                OrderStatus.MERCHANT_REJECTED -> {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        Text(
                            text = "سبب الرفض: ${order.rejectionReason.ifBlank { "بيانات الإيصال غير مطابقة" }}",
                            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold),
                            color = ExpressRed
                        )
                        Spacer(modifier = Modifier.height(10.dp))
                        Button(
                            onClick = { onOpenCustomerDataEntry(order) },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(50.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = ExpressRed),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Icon(Icons.Default.Refresh, contentDescription = null)
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("تعديل وإعادة إرسال البيانات 📝", color = Color.White, fontWeight = FontWeight.Bold)
                        }
                    }
                }

                // 6. EN_ROUTE: Merchant confirmed! Direction to customer + "تسليم الطلب للعميل"
                OrderStatus.EN_ROUTE -> {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        OutlinedButton(
                            onClick = {
                                openDirections(context, null, null, order.deliveryAddress)
                            },
                            modifier = Modifier
                                .weight(1f)
                                .height(52.dp)
                                .testTag("customer_map_button"),
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp),
                            shape = RoundedCornerShape(12.dp),
                            border = androidx.compose.foundation.BorderStroke(1.dp, HeroYellow)
                        ) {
                            Icon(Icons.Default.Map, contentDescription = null, tint = HeroYellow, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text(
                                text = "خريطة العميل",
                                color = HeroYellow,
                                fontSize = 12.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                        }

                        Button(
                            onClick = { onCompleteDelivery(order) },
                            enabled = !isLoading,
                            modifier = Modifier
                                .weight(1.55f)
                                .height(52.dp)
                                .testTag("deliver_to_customer_button"),
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = StatusOnlineGreen),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Icon(Icons.Default.CheckCircle, contentDescription = null, tint = Color.White, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(
                                text = "تسليم الطلب للعميل 🏁",
                                fontWeight = FontWeight.Bold,
                                color = Color.White,
                                fontSize = 13.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                    }
                }

                // 7. DELIVERED
                OrderStatus.DELIVERED -> {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = StatusOnlineGreen.copy(alpha = 0.2f)),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(Icons.Default.CheckCircle, contentDescription = null, tint = StatusOnlineGreen)
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = "تم تسليم الطلب بنجاح وإضافة المستحقات لمحفظتك",
                                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold),
                                color = StatusOnlineGreen
                            )
                        }
                    }
                }

                else -> { /* Pending or Expired */ }
            }
        }
    }

    if (showMerchantDirectionsDialog) {
        MerchantDirectionsLinkDialog(
            storeName = order.storeName,
            pickupAddress = order.pickupAddress,
            locationUrl = order.effectiveStoreLocationUrl,
            latitude = order.restaurantLatitude,
            longitude = order.restaurantLongitude,
            onDismiss = { showMerchantDirectionsDialog = false },
            onOpenUrlInGoogleMaps = { url ->
                openGoogleMapsWithUrl(context, url)
            },
            onOpenFallbackInGoogleMaps = {
                openDirections(
                    context,
                    order.restaurantLatitude,
                    order.restaurantLongitude,
                    order.pickupAddress.ifBlank { order.storeName }
                )
            }
        )
    }
}

@Composable
private fun MerchantDirectionsLinkDialog(
    storeName: String,
    pickupAddress: String,
    locationUrl: String,
    latitude: Double?,
    longitude: Double?,
    onDismiss: () -> Unit,
    onOpenUrlInGoogleMaps: (String) -> Unit,
    onOpenFallbackInGoogleMaps: () -> Unit
) {
    val cleanUrl = locationUrl.trim()
    val hasCoordinates = latitude != null && longitude != null && latitude != 0.0 && longitude != 0.0
    val hasAddress = pickupAddress.isNotBlank() && pickupAddress != "عنوان المتجر"

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .border(1.5.dp, HeroYellow.copy(alpha = 0.65f), RoundedCornerShape(22.dp))
                .testTag("merchant_location_link_dialog"),
            shape = RoundedCornerShape(22.dp),
            color = DarkSurface,
            tonalElevation = 12.dp
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(20.dp)
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Box(
                        modifier = Modifier
                            .size(44.dp)
                            .clip(CircleShape)
                            .background(HeroYellow.copy(alpha = 0.16f)),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            imageVector = Icons.Default.LocationOn,
                            contentDescription = null,
                            tint = HeroYellow,
                            modifier = Modifier.size(24.dp)
                        )
                    }
                    Spacer(modifier = Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "موقع التاجر: $storeName",
                            style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
                            color = Color.White,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis
                        )
                        if (pickupAddress.isNotBlank()) {
                            Text(
                                text = pickupAddress,
                                style = MaterialTheme.typography.bodySmall,
                                color = Color.LightGray,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                if (cleanUrl.isNotBlank()) {
                    Text(
                        text = "رابط الموقع المضاف من حساب التاجر:",
                        style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Bold),
                        color = StatusOnlineGreen
                    )
                    Spacer(modifier = Modifier.height(8.dp))

                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .minimumInteractiveComponentSize()
                            .clip(RoundedCornerShape(14.dp))
                            .clickable { onOpenUrlInGoogleMaps(cleanUrl) }
                            .testTag("merchant_location_url_card"),
                        shape = RoundedCornerShape(14.dp),
                        color = DarkSurfaceVariant,
                        border = BorderStroke(1.dp, StatusOnlineGreen.copy(alpha = 0.6f))
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(14.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(
                                imageVector = Icons.Default.Link,
                                contentDescription = null,
                                tint = StatusOnlineGreen,
                                modifier = Modifier.size(22.dp)
                            )
                            Spacer(modifier = Modifier.width(10.dp))
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = cleanUrl,
                                    style = MaterialTheme.typography.bodyMedium.copy(
                                        fontWeight = FontWeight.SemiBold,
                                        textDecoration = TextDecoration.Underline
                                    ),
                                    color = HeroYellow,
                                    maxLines = 3,
                                    overflow = TextOverflow.Ellipsis
                                )
                                Spacer(modifier = Modifier.height(4.dp))
                                Text(
                                    text = "اضغط على الرابط لفتح موقع التاجر في خرائط جوجل",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = Color.LightGray
                                )
                            }
                            Spacer(modifier = Modifier.width(8.dp))
                            Icon(
                                imageVector = Icons.Default.OpenInNew,
                                contentDescription = "فتح الرابط في خرائط جوجل",
                                tint = HeroYellow,
                                modifier = Modifier.size(20.dp)
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(16.dp))

                    Button(
                        onClick = { onOpenUrlInGoogleMaps(cleanUrl) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(50.dp)
                            .testTag("open_google_maps_button"),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = StatusOnlineGreen,
                            contentColor = Color.White
                        ),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Icon(Icons.Default.Map, contentDescription = null, tint = Color.White)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "فتح الموقع في خرائط جوجل",
                            style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold)
                        )
                    }
                } else {
                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("merchant_location_missing_notice"),
                        shape = RoundedCornerShape(14.dp),
                        color = DarkSurfaceVariant,
                        border = BorderStroke(1.dp, HeroYellow.copy(alpha = 0.45f))
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(14.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(
                                imageVector = Icons.Default.Info,
                                contentDescription = null,
                                tint = HeroYellow,
                                modifier = Modifier.size(22.dp)
                            )
                            Spacer(modifier = Modifier.width(10.dp))
                            Text(
                                text = "لم يضف التاجر رابط موقع في حسابه حتى الآن." +
                                    if (hasCoordinates || hasAddress) {
                                        " يمكنك تحديد موقع التاجر باستخدام العنوان أو الإحداثيات المسجلة على خرائط جوجل."
                                    } else {
                                        ""
                                    },
                                style = MaterialTheme.typography.bodySmall,
                                color = Color.LightGray
                            )
                        }
                    }

                    if (hasCoordinates || hasAddress || storeName.isNotBlank()) {
                        Spacer(modifier = Modifier.height(14.dp))
                        Button(
                            onClick = onOpenFallbackInGoogleMaps,
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(50.dp)
                                .testTag("open_google_maps_fallback_button"),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = HeroYellow,
                                contentColor = Color.Black
                            ),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Icon(Icons.Default.Directions, contentDescription = null, tint = Color.Black)
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = "تحديد الموقع في خرائط جوجل",
                                style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold)
                            )
                        }
                    }
                }

                Spacer(modifier = Modifier.height(8.dp))

                TextButton(
                    onClick = onDismiss,
                    modifier = Modifier
                        .align(Alignment.End)
                        .minimumInteractiveComponentSize()
                        .testTag("close_merchant_directions_dialog")
                ) {
                    Text(
                        text = "إغلاق",
                        color = Color.LightGray,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }
        }
    }
}

@Composable
private fun StepBadgeMini(label: String, isDone: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .size(18.dp)
                .clip(CircleShape)
                .background(if (isDone) StatusOnlineGreen else Color.DarkGray),
            contentAlignment = Alignment.Center
        ) {
            if (isDone) {
                Icon(
                    imageVector = Icons.Default.Check,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(12.dp)
                )
            }
        }
        Spacer(modifier = Modifier.width(4.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall.copy(
                fontWeight = if (isDone) FontWeight.Bold else FontWeight.Normal,
                fontSize = 10.sp
            ),
            color = if (isDone) Color.White else Color.Gray
        )
    }
}

internal fun buildGoogleMapsViewIntent(rawUrl: String, forceMapsPackage: Boolean = true): Intent {
    val cleanUrl = rawUrl.trim().let { u ->
        val lower = u.lowercase()
        if (lower.startsWith("http://") ||
            lower.startsWith("https://") ||
            lower.startsWith("geo:") ||
            lower.startsWith("google.navigation:")
        ) {
            u
        } else {
            "https://$u"
        }
    }
    return Intent(Intent.ACTION_VIEW, Uri.parse(cleanUrl)).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (forceMapsPackage) {
            setPackage("com.google.android.apps.maps")
        }
    }
}

private fun openGoogleMapsWithUrl(context: Context, rawUrl: String) {
    try {
        val mapsIntent = buildGoogleMapsViewIntent(rawUrl, forceMapsPackage = true)
        context.startActivity(mapsIntent)
    } catch (_: ActivityNotFoundException) {
        try {
            val fallbackIntent = buildGoogleMapsViewIntent(rawUrl, forceMapsPackage = false)
            context.startActivity(fallbackIntent)
        } catch (_: Exception) {
            Toast.makeText(context, "تعذر فتح رابط موقع التاجر على الخرائط", Toast.LENGTH_SHORT).show()
        }
    } catch (_: Exception) {
        try {
            val fallbackIntent = buildGoogleMapsViewIntent(rawUrl, forceMapsPackage = false)
            context.startActivity(fallbackIntent)
        } catch (_: Exception) {
            Toast.makeText(context, "تعذر فتح رابط موقع التاجر على الخرائط", Toast.LENGTH_SHORT).show()
        }
    }
}

private fun openDirections(context: Context, lat: Double?, lng: Double?, addressQuery: String) {
    try {
        val mapUri = if (lat != null && lng != null && lat != 0.0 && lng != 0.0) {
            Uri.parse("google.navigation:q=$lat,$lng")
        } else {
            Uri.parse("geo:0,0?q=${Uri.encode(addressQuery)}")
        }
        val intent = Intent(Intent.ACTION_VIEW, mapUri).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            setPackage("com.google.android.apps.maps")
        }
        try {
            context.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            intent.setPackage(null)
            context.startActivity(intent)
        }
    } catch (e: Exception) {
        try {
            val fallbackUri = if (lat != null && lng != null && lat != 0.0 && lng != 0.0) {
                Uri.parse("https://www.google.com/maps/search/?api=1&query=$lat,$lng")
            } else {
                Uri.parse("https://www.google.com/maps/search/?api=1&query=${Uri.encode(addressQuery)}")
            }
            context.startActivity(Intent(Intent.ACTION_VIEW, fallbackUri).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            })
        } catch (e2: Exception) {
            Toast.makeText(context, "تعذر فتح تطبيق الخرائط", Toast.LENGTH_SHORT).show()
        }
    }
}
