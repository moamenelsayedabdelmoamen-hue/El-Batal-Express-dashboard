package com.example.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.HourglassTop
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.PauseCircle
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.CaptainEntity
import com.example.ui.theme.DarkBackground
import com.example.ui.theme.DarkCardBorder
import com.example.ui.theme.DarkSurface
import com.example.ui.theme.DarkSurfaceVariant
import com.example.ui.theme.ExpressRed
import com.example.ui.theme.HeroYellow
import com.example.ui.theme.StatusOnlineGreen
import com.example.ui.theme.TextMutedDark
import com.example.ui.theme.TextPrimaryDark
import com.example.ui.theme.TextSecondaryDark

private data class GateStatusUiConfig(
    val title: String,
    val badgeLabel: String,
    val description: String,
    val reasonTitle: String,
    val reasonText: String,
    val accentColor: Color,
    val icon: ImageVector
)

@Composable
fun AccountStatusGateScreen(
    captain: CaptainEntity?,
    isRefreshing: Boolean = false,
    onRefreshStatus: () -> Unit,
    onLogout: () -> Unit
) {
    val status = captain?.effectiveAccountStatus ?: "pending"

    val config = when (status) {
        "rejected" -> GateStatusUiConfig(
            title = "تم رفض طلب التسجيل",
            badgeLabel = "طلب مرفوض",
            description = "لم تتم الموافقة على طلب انضمامك ككابتن في الوقت الحالي. يرجى مراجعة سبب الرفض أدناه أو التواصل مع إدارة البطل إكسبريس.",
            reasonTitle = "سبب الرفض",
            reasonText = captain?.rejectionReason?.trim().orEmpty(),
            accentColor = ExpressRed,
            icon = Icons.Default.Cancel
        )
        "suspended" -> GateStatusUiConfig(
            title = "تم إيقاف حسابك مؤقتاً",
            badgeLabel = "حساب موقوف",
            description = "حسابك موقوف مؤقتاً من قبل الإدارة ولا يمكنك استقبال أو توصيل الطلبات حتى تتم إعادة التفعيل.",
            reasonTitle = "سبب الإيقاف",
            reasonText = captain?.suspensionReason?.trim().orEmpty(),
            accentColor = HeroYellow,
            icon = Icons.Default.PauseCircle
        )
        "blocked" -> GateStatusUiConfig(
            title = "تم حظر الحساب نهائياً",
            badgeLabel = "حساب محظور",
            description = "تم حظر هذا الحساب إدارياً ولا يمكن استخدامه لاستقبال الطلبات. للاستفسار يرجى التواصل مع الإدارة.",
            reasonTitle = "سبب الحظر",
            reasonText = captain?.blockReason?.trim().orEmpty(),
            accentColor = ExpressRed,
            icon = Icons.Default.Block
        )
        else -> GateStatusUiConfig(
            title = "حسابك قيد المراجعة",
            badgeLabel = "بانتظار الموافقة",
            description = "شكراً لتسجيلك في البطل إكسبريس! يقوم فريق الإدارة حالياً بمراجعة بياناتك ومستنداتك. سيتم فتح لوحة العمل تلقائياً فور اعتماد حسابك.",
            reasonTitle = "",
            reasonText = "",
            accentColor = HeroYellow,
            icon = Icons.Default.HourglassTop
        )
    }

    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(DarkBackground)
                .testTag("account_status_gate_screen")
                .padding(horizontal = 20.dp, vertical = 24.dp),
            contentAlignment = Alignment.Center
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Box(
                    modifier = Modifier
                        .size(88.dp)
                        .clip(CircleShape)
                        .background(config.accentColor.copy(alpha = 0.16f)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = config.icon,
                        contentDescription = config.title,
                        tint = config.accentColor,
                        modifier = Modifier.size(44.dp)
                    )
                }

                Surface(
                    shape = RoundedCornerShape(999.dp),
                    color = config.accentColor.copy(alpha = 0.16f),
                    border = BorderStroke(1.dp, config.accentColor.copy(alpha = 0.45f))
                ) {
                    Text(
                        text = config.badgeLabel,
                        color = config.accentColor,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp)
                    )
                }

                Text(
                    text = config.title,
                    color = TextPrimaryDark,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.ExtraBold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.testTag("gate_status_title")
                )

                Text(
                    text = config.description,
                    color = TextSecondaryDark,
                    fontSize = 14.sp,
                    lineHeight = 22.sp,
                    textAlign = TextAlign.Center
                )

                if (config.reasonTitle.isNotBlank() && config.reasonText.isNotBlank()) {
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("gate_reason_card"),
                        shape = RoundedCornerShape(16.dp),
                        colors = CardDefaults.cardColors(containerColor = DarkSurface),
                        border = BorderStroke(1.dp, config.accentColor.copy(alpha = 0.45f))
                    ) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            Text(
                                text = config.reasonTitle,
                                color = config.accentColor,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Text(
                                text = config.reasonText,
                                color = TextPrimaryDark,
                                fontSize = 14.sp,
                                lineHeight = 21.sp,
                                modifier = Modifier.testTag("gate_reason_text")
                            )
                        }
                    }
                }

                if (captain != null) {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(16.dp),
                        colors = CardDefaults.cardColors(containerColor = DarkSurfaceVariant),
                        border = BorderStroke(1.dp, DarkCardBorder)
                    ) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Text(
                                text = "ملخص بيانات الحساب",
                                color = TextSecondaryDark,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Text(text = "الاسم", color = TextMutedDark, fontSize = 13.sp)
                                Text(
                                    text = captain.fullName.ifBlank { "كابتن البطل" },
                                    color = TextPrimaryDark,
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.SemiBold
                                )
                            }
                            if (captain.phoneNumber.isNotBlank()) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Text(text = "الهاتف", color = TextMutedDark, fontSize = 13.sp)
                                    Text(
                                        text = captain.phoneNumber,
                                        color = TextPrimaryDark,
                                        fontSize = 13.sp,
                                        fontWeight = FontWeight.SemiBold
                                    )
                                }
                            }
                            if (captain.email.isNotBlank()) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Text(text = "البريد الإلكتروني", color = TextMutedDark, fontSize = 13.sp)
                                    Text(
                                        text = captain.email,
                                        color = TextPrimaryDark,
                                        fontSize = 12.sp
                                    )
                                }
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.height(4.dp))

                Button(
                    onClick = onRefreshStatus,
                    enabled = !isRefreshing,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(50.dp)
                        .testTag("gate_refresh_button"),
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = StatusOnlineGreen,
                        contentColor = Color.Black
                    )
                ) {
                    if (isRefreshing) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            color = Color.Black,
                            strokeWidth = 2.dp
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                    } else {
                        Icon(
                            imageVector = Icons.Default.Refresh,
                            contentDescription = null,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                    }
                    Text(
                        text = "تحديث حالة الحساب",
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold
                    )
                }

                OutlinedButton(
                    onClick = onLogout,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(48.dp)
                        .testTag("gate_logout_button"),
                    shape = RoundedCornerShape(14.dp),
                    border = BorderStroke(1.dp, DarkCardBorder),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = TextPrimaryDark)
                ) {
                    Icon(
                        imageVector = Icons.Default.Logout,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "تسجيل الخروج",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }
        }
    }
}
