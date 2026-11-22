package com.example.ui.icons

import androidx.compose.material.icons.Icons
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * Lightweight subset of Material Design 24dp vector icons used across the Captain app.
 * Replaces the full `material-icons-extended` dependency (~11,398 classes / ~43 MB DEX)
 * while preserving exact icon geometry, sizing, tinting, and visual design.
 */
private fun captainIcon(
    name: String,
    pathData: String,
    fillType: PathFillType = PathFillType.NonZero
): ImageVector = ImageVector.Builder(
    name = "CaptainIcons.$name",
    defaultWidth = 24.dp,
    defaultHeight = 24.dp,
    viewportWidth = 24f,
    viewportHeight = 24f
).addPath(
    pathData = addPathNodes(pathData),
    pathFillType = fillType,
    fill = SolidColor(Color.Black),
    strokeLineCap = StrokeCap.Butt,
    strokeLineJoin = StrokeJoin.Bevel
).build()

private val _AccessTime by lazy {
    captainIcon(
        "AccessTime",
        "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"
    )
}
val Icons.Filled.AccessTime: ImageVector get() = _AccessTime

private val _AccountBalanceWallet by lazy {
    captainIcon(
        "AccountBalanceWallet",
        "M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"
    )
}
val Icons.Filled.AccountBalanceWallet: ImageVector get() = _AccountBalanceWallet

private val _AddAPhoto by lazy {
    captainIcon(
        "AddAPhoto",
        "M3 4V1h2v3h3v2H5v3H3V6H0V4h3zm3 6V7h3V4h7l1.83 2H21c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V10h3zm7 9c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5zm-3.2-5c0 1.77 1.43 3.2 3.2 3.2s3.2-1.43 3.2-3.2-1.43-3.2-3.2-3.2-3.2 1.43-3.2 3.2z"
    )
}
val Icons.Filled.AddAPhoto: ImageVector get() = _AddAPhoto

private val _ArrowDownward by lazy {
    captainIcon(
        "ArrowDownward",
        "M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z"
    )
}
val Icons.Filled.ArrowDownward: ImageVector get() = _ArrowDownward

private val _ArrowUpward by lazy {
    captainIcon(
        "ArrowUpward",
        "M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"
    )
}
val Icons.Filled.ArrowUpward: ImageVector get() = _ArrowUpward

private val _AttachMoney by lazy {
    captainIcon(
        "AttachMoney",
        "M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"
    )
}
val Icons.Filled.AttachMoney: ImageVector get() = _AttachMoney

private val _Badge by lazy {
    captainIcon(
        "Badge",
        "M20 7h-5V4c0-1.1-.9-2-2-2h-2c-1.1 0-2 .9-2 2v3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2zM9 12c.83 0 1.5.67 1.5 1.5S9.83 15 9 15s-1.5-.67-1.5-1.5S8.17 12 9 12zm3 6H6v-.75c0-1 2-1.5 3-1.5s3 .5 3 1.5V18zm1-9h-2V4h2v5zm5 7.5h-4V15h4v1.5zm0-3h-4V12h4v1.5z"
    )
}
val Icons.Filled.Badge: ImageVector get() = _Badge

private val _BrokenImage by lazy {
    captainIcon(
        "BrokenImage",
        "M21 5v6.59l-3-3.01-4 4.01-4-4-4 4-3-3.01V5c0-1.1.9-2 2-2h14c1.1 0 2 .9 2 2zm-3 6.42l3 3.01V19c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-6.58l3 2.99 4-4 4 4 4-3.99z"
    )
}
val Icons.Filled.BrokenImage: ImageVector get() = _BrokenImage

private val _CalendarMonth by lazy {
    captainIcon(
        "CalendarMonth",
        "M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM9 14H7v-2h2v2zm4 0h-2v-2h2v2zm4 0h-2v-2h2v2zm-8 4H7v-2h2v2zm4 0h-2v-2h2v2zm4 0h-2v-2h2v2z"
    )
}
val Icons.Filled.CalendarMonth: ImageVector get() = _CalendarMonth

private val _CameraAlt by lazy {
    captainIcon(
        "CameraAlt",
        "M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8.2c-1.77 0-3.2 1.43-3.2 3.2s1.43 3.2 3.2 3.2 3.2-1.43 3.2-3.2-1.43-3.2-3.2-3.2z"
    )
}
val Icons.Filled.CameraAlt: ImageVector get() = _CameraAlt

private val _Cancel by lazy {
    captainIcon(
        "Cancel",
        "M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"
    )
}
val Icons.Filled.Cancel: ImageVector get() = _Cancel

private val _CloudSync by lazy {
    captainIcon(
        "CloudSync",
        "M19.35 10.04C18.67 6.59 15.64 4 12 4c-1.48 0-2.85.43-4.01 1.17l1.46 1.46C10.21 6.23 11.08 6 12 6c3.04 0 5.5 2.46 5.5 5.5v.5H19c1.66 0 3 1.34 3 3 0 1.13-.64 2.11-1.56 2.62l1.45 1.45C23.16 18.16 24 16.68 24 15c0-2.64-2.05-4.78-4.65-4.96zM19 20H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95C8.08 9.14 9.94 8 12 8v2l3-3-3-3v2C8.92 6 6.26 7.91 5.21 10.67 2.27 11.15 0 13.71 0 16.8 0 20.22 2.78 23 6.2 23H19v-3z"
    )
}
val Icons.Filled.CloudSync: ImageVector get() = _CloudSync

private val _CloudUpload by lazy {
    captainIcon(
        "CloudUpload",
        "M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"
    )
}
val Icons.Filled.CloudUpload: ImageVector get() = _CloudUpload

private val _DeliveryDining by lazy {
    captainIcon(
        "DeliveryDining",
        "M19 7c0-1.1-.9-2-2-2h-3v2h3v2.65L13.52 14H10V9H6c-2.21 0-4 1.79-4 4v3h2c0 1.66 1.34 3 3 3s3-1.34 3-3h4.48L19 10.35V7zM7 17c-.55 0-1-.45-1-1h2c0 .55-.45 1-1 1zM5 6h5v2H5V6zm14 7c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3zm0 4c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z"
    )
}
val Icons.Filled.DeliveryDining: ImageVector get() = _DeliveryDining

private val _Directions by lazy {
    captainIcon(
        "Directions",
        "M21.71 11.29l-9-9a.9959.9959 0 00-1.41 0l-9 9a.9959.9959 0 000 1.41l9 9c.39.39 1.02.39 1.41 0l9-9a.9959.9959 0 000-1.41zM14 14.5V12h-4v3H8v-4c0-.55.45-1 1-1h5V7.5l3.5 3.5-3.5 3.5z"
    )
}
val Icons.Filled.Directions: ImageVector get() = _Directions

private val _DirectionsBike by lazy {
    captainIcon(
        "DirectionsBike",
        "M15.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM5 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5zm5.8-10l2.4-2.4.8.8c1.3 1.3 3 2.1 5.1 2.1V9c-1.5 0-2.7-.6-3.6-1.5l-1.9-1.9c-.5-.4-1-.6-1.6-.6s-1.1.2-1.4.6L7.8 8.4c-.4.4-.6.9-.6 1.4 0 .6.2 1.1.6 1.4L11 14v5h2v-6.2l-2.2-2.3zM19 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z"
    )
}
val Icons.Filled.DirectionsBike: ImageVector get() = _DirectionsBike

private val _DirectionsCar by lazy {
    captainIcon(
        "DirectionsCar",
        "M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"
    )
}
val Icons.Filled.DirectionsCar: ImageVector get() = _DirectionsCar

private val _DriveEta by lazy {
    captainIcon(
        "DriveEta",
        "M18.92 5.01C18.72 4.42 18.16 4 17.5 4h-11c-.66 0-1.21.42-1.42 1.01L3 11v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 15c-.83 0-1.5-.67-1.5-1.5S5.67 12 6.5 12s1.5.67 1.5 1.5S7.33 15 6.5 15zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 10l1.5-4.5h11L19 10H5z"
    )
}
val Icons.Filled.DriveEta: ImageVector get() = _DriveEta

private val _EditNote by lazy {
    captainIcon(
        "EditNote",
        "M3 10h11v2H3v-2zm0-2h11V6H3v2zm0 8h7v-2H3v2zm15.01-3.13l.71-.71c.39-.39 1.02-.39 1.41 0l.71.71c.39.39.39 1.02 0 1.41l-.71.71-2.12-2.12zm-.71.71l-5.3 5.3V21h2.12l5.3-5.3-2.12-2.12z"
    )
}
val Icons.Filled.EditNote: ImageVector get() = _EditNote

private val _ElectricScooter by lazy {
    captainIcon(
        "ElectricScooter",
        "M7.82 16H15v-1c0-2.21 1.79-4 4-4h.74l-1.9-8.44A2.008 2.008 0 0015.89 1H12v2h3.89l1.4 6.25h-.01A6.008 6.008 0 0013.09 14H7.82c-.48-1.34-1.86-2.24-3.42-1.94-1.18.23-2.13 1.2-2.35 2.38C1.7 16.34 3.16 18 5 18c1.3 0 2.4-.84 2.82-2zM5 16c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm14-4c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3zm0 4c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-8 4H7l6 3v-2h4l-6-3v2z"
    )
}
val Icons.Filled.ElectricScooter: ImageVector get() = _ElectricScooter

private val _ErrorOutline by lazy {
    captainIcon(
        "ErrorOutline",
        "M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"
    )
}
val Icons.Filled.ErrorOutline: ImageVector get() = _ErrorOutline

private val _GpsFixed by lazy {
    captainIcon(
        "GpsFixed",
        "M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"
    )
}
val Icons.Filled.GpsFixed: ImageVector get() = _GpsFixed

private val _GpsNotFixed by lazy {
    captainIcon(
        "GpsNotFixed",
        "M20.94 11c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"
    )
}
val Icons.Filled.GpsNotFixed: ImageVector get() = _GpsNotFixed

private val _GpsOff by lazy {
    captainIcon(
        "GpsOff",
        "M20.94 11c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06c-1.13.12-2.19.46-3.16.97l1.5 1.5C10.16 5.19 11.06 5 12 5c3.87 0 7 3.13 7 7 0 .94-.19 1.84-.52 2.65l1.5 1.5c.5-.96.84-2.02.97-3.15H23v-2h-2.06zM3 4.27l2.04 2.04C3.97 7.62 3.26 9.23 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c1.77-.2 3.38-.91 4.69-1.98L19.73 21 21 19.73 4.27 3 3 4.27zm13.27 13.27C15.09 18.45 13.61 19 12 19c-3.87 0-7-3.13-7-7 0-1.61.55-3.09 1.46-4.27l9.81 9.81z"
    )
}
val Icons.Filled.GpsOff: ImageVector get() = _GpsOff

private val _History by lazy {
    captainIcon(
        "History",
        "M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"
    )
}
val Icons.Filled.History: ImageVector get() = _History

private val _HourglassTop by lazy {
    captainIcon(
        "HourglassTop",
        "M6 2l.01 6L10 12l-3.99 4.01L6 22h12v-6l-4-4 4-3.99V2H6zm10 14.5V20H8v-3.5l4-4 4 4z"
    )
}
val Icons.Filled.HourglassTop: ImageVector get() = _HourglassTop

private val _Link by lazy {
    captainIcon(
        "Link",
        "M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"
    )
}
val Icons.Filled.Link: ImageVector get() = _Link

private val _LocalShipping by lazy {
    captainIcon(
        "LocalShipping",
        "M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9l1.96 2.5H17V9.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"
    )
}
val Icons.Filled.LocalShipping: ImageVector get() = _LocalShipping

private val _LockClock by lazy {
    captainIcon(
        "LockClock",
        "M14.5 14.2l2.9 1.7-.8 1.3L13 15v-5h1.5v4.2zM22 14c0 4.41-3.59 8-8 8-2.02 0-3.86-.76-5.27-2H4c-1.15 0-2-.85-2-2V9c0-1.12.89-1.96 2-2v-.5C4 4.01 6.01 2 8.5 2c2.34 0 4.24 1.79 4.46 4.08.34-.05.69-.08 1.04-.08 4.41 0 8 3.59 8 8zM6 7h5v-.74C10.88 4.99 9.8 4 8.5 4 7.12 4 6 5.12 6 6.5V7zm14 7c0-3.31-2.69-6-6-6s-6 2.69-6 6 2.69 6 6 6 6-2.69 6-6z"
    )
}
val Icons.Filled.LockClock: ImageVector get() = _LockClock

private val _Map by lazy {
    captainIcon(
        "Map",
        "M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"
    )
}
val Icons.Filled.Map: ImageVector get() = _Map

private val _MarkEmailRead by lazy {
    captainIcon(
        "MarkEmailRead",
        "M12 19a6.995 6.995 0 0110-6.32V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h8.08c-.05-.33-.08-.66-.08-1zM4 6l8 5 8-5v2l-8 5-8-5V6zm13.34 16l-3.54-3.54 1.41-1.41 2.12 2.12 4.24-4.24L23 16.34 17.34 22z"
    )
}
val Icons.Filled.MarkEmailRead: ImageVector get() = _MarkEmailRead

private val _NearMe by lazy {
    captainIcon(
        "NearMe",
        "M21 3L3 10.53v.98l6.84 2.65L12.48 21h.98L21 3z"
    )
}
val Icons.Filled.NearMe: ImageVector get() = _NearMe

private val _NotificationsActive by lazy {
    captainIcon(
        "NotificationsActive",
        "M7.58 4.08L6.15 2.65C3.75 4.48 2.17 7.3 2.03 10.5h2c.15-2.65 1.51-4.97 3.55-6.42zm12.39 6.42h2c-.15-3.2-1.73-6.02-4.12-7.85l-1.42 1.43c2.02 1.45 3.39 3.77 3.54 6.42zM18 11c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2v-5zm-6 11c.14 0 .27-.01.4-.04.65-.14 1.18-.58 1.44-1.18.1-.24.15-.5.15-.78h-4c.01 1.1.9 2 2.01 2z"
    )
}
val Icons.Filled.NotificationsActive: ImageVector get() = _NotificationsActive

private val _OpenInNew by lazy {
    captainIcon(
        "OpenInNew",
        "M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"
    )
}
val Icons.Filled.OpenInNew: ImageVector get() = _OpenInNew

private val _Payments by lazy {
    captainIcon(
        "Payments",
        "M19 14V6c0-1.1-.9-2-2-2H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zm-9-1c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm13-6v11c0 1.1-.9 2-2 2H4v-2h17V7h2z"
    )
}
val Icons.Filled.Payments: ImageVector get() = _Payments

private val _PhotoLibrary by lazy {
    captainIcon(
        "PhotoLibrary",
        "M22 16V4c0-1.1-.9-2-2-2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2zm-11-4l2.03 2.71L16 11l4 5H8l3-4zM2 6v14c0 1.1.9 2 2 2h14v-2H4V6H2z"
    )
}
val Icons.Filled.PhotoLibrary: ImageVector get() = _PhotoLibrary

private val _QrCode2 by lazy {
    captainIcon(
        "QrCode2",
        "M15 21h-2v-2h2v2zm-2-7h-2v5h2v-5zm8-2h-2v4h2v-4zm-2-2h-2v2h2v-2zM7 12H5v2h2v-2zm-2-2H3v2h2v-2zm7-5h2V3h-2v2zm-7.5-.5v3h3v-3h-3zM9 9H3V3h6v6zm-4.5 7.5v3h3v-3h-3zM9 21H3v-6h6v6zm7.5-16.5v3h3v-3h-3zM21 9h-6V3h6v6zm-2 10v-3h-4v2h2v3h4v-2h-2zm-2-7h-4v2h4v-2zm-4-2H7v2h2v2h2v-2h2v-2zm1-1V7h-2V5h-2v4h4zM6.75 5.25h-1.5v1.5h1.5v-1.5zm0 12h-1.5v1.5h1.5v-1.5zm12-12h-1.5v1.5h1.5v-1.5z"
    )
}
val Icons.Filled.QrCode2: ImageVector get() = _QrCode2

private val _ReceiptLong by lazy {
    captainIcon(
        "ReceiptLong",
        "M19.5 3.5L18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5 6 2v14H3v3c0 1.66 1.34 3 3 3h12c1.66 0 3-1.34 3-3V2l-1.5 1.5zM15 20H6c-.55 0-1-.45-1-1v-1h10v2zm4-1c0 .55-.45 1-1 1s-1-.45-1-1v-3H8V5h11v14zM9 7h6v2H9V7zm7 0h2v2h-2V7zm-7 3h6v2H9v-2zm7 0h2v2h-2v-2z"
    )
}
val Icons.Filled.ReceiptLong: ImageVector get() = _ReceiptLong

private val _Remove by lazy {
    captainIcon(
        "Remove",
        "M19 13H5v-2h14v2z"
    )
}
val Icons.Filled.Remove: ImageVector get() = _Remove

private val _Restaurant by lazy {
    captainIcon(
        "Restaurant",
        "M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z"
    )
}
val Icons.Filled.Restaurant: ImageVector get() = _Restaurant

private val _Save by lazy {
    captainIcon(
        "Save",
        "M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"
    )
}
val Icons.Filled.Save: ImageVector get() = _Save

private val _Security by lazy {
    captainIcon(
        "Security",
        "M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"
    )
}
val Icons.Filled.Security: ImageVector get() = _Security

private val _Sensors by lazy {
    captainIcon(
        "Sensors",
        "M7.76 16.24l-1.41 1.41C4.78 16.1 4 14.05 4 12s.78-4.1 2.34-5.66l1.41 1.41C6.59 8.93 6 10.46 6 12s.59 3.07 1.76 4.24zM12 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm8 2c0-2.05-.78-4.1-2.34-5.66l-1.41 1.41C17.41 8.93 18 10.46 18 12s-.59 3.07-1.76 4.24l1.41 1.41C19.22 16.1 20 14.05 20 12zm-4.95-2.83l-1.41 1.41c.23.39.36.84.36 1.42s-.13 1.03-.36 1.42l1.41 1.41c.6-.77.95-1.74.95-2.83s-.35-2.06-.95-2.83zm-6.1 0C8.35 9.94 8 10.91 8 12s.35 2.06.95 2.83l1.41-1.41C10.13 13.03 10 12.58 10 12s.13-1.03.36-1.42L8.95 9.17z"
    )
}
val Icons.Filled.Sensors: ImageVector get() = _Sensors

private val _Shield by lazy {
    captainIcon(
        "Shield",
        "M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"
    )
}
val Icons.Filled.Shield: ImageVector get() = _Shield

private val _ShoppingBag by lazy {
    captainIcon(
        "ShoppingBag",
        "M18 6h-2c0-2.21-1.79-4-4-4S8 3.79 8 6H6c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-8 4c0 .55-.45 1-1 1s-1-.45-1-1V8h2v2zm2-6c1.1 0 2 .9 2 2h-4c0-1.1.9-2 2-2zm4 6c0 .55-.45 1-1 1s-1-.45-1-1V8h2v2z"
    )
}
val Icons.Filled.ShoppingBag: ImageVector get() = _ShoppingBag

private val _Storefront by lazy {
    captainIcon(
        "Storefront",
        "M21.9 8.89l-1.05-4.37c-.22-.9-1-1.52-1.91-1.52H5.05c-.9 0-1.69.63-1.9 1.52L2.1 8.89c-.24 1.02-.02 2.06.62 2.88.08.11.19.19.28.29V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-6.94c.09-.09.2-.18.28-.28.64-.82.87-1.87.62-2.89zm-2.99-3.9l1.05 4.37c.1.42.01.84-.25 1.17-.14.18-.44.47-.94.47-.61 0-1.14-.49-1.21-1.14L16.98 5l1.93-.01zM13 5h1.96l.54 4.52c.05.39-.07.78-.33 1.07-.22.26-.54.41-.95.41-.67 0-1.22-.59-1.22-1.31V5zM8.49 9.52L9.04 5H11v4.69c0 .72-.55 1.31-1.29 1.31-.34 0-.65-.15-.89-.41-.25-.29-.37-.68-.33-1.07zm-4.45-.16L5.05 5h1.97l-.58 4.86c-.08.65-.6 1.14-1.21 1.14-.49 0-.8-.29-.93-.47-.27-.32-.36-.75-.26-1.17zM5 19v-6.03c.08.01.15.03.23.03.87 0 1.66-.36 2.24-.95.6.6 1.4.95 2.31.95.87 0 1.65-.36 2.23-.93.59.57 1.39.93 2.29.93.84 0 1.64-.35 2.24-.95.58.59 1.37.95 2.24.95.08 0 .15-.02.23-.03V19H5z"
    )
}
val Icons.Filled.Storefront: ImageVector get() = _Storefront

private val _SupportAgent by lazy {
    captainIcon(
        "SupportAgent",
        "M21 12.22C21 6.73 16.74 3 12 3c-4.69 0-9 3.65-9 9.28-.6.34-1 .98-1 1.72v2c0 1.1.9 2 2 2h1v-6.1c0-3.87 3.13-7 7-7s7 3.13 7 7V19h-8v2h8c1.1 0 2-.9 2-2v-1.22c.59-.31 1-.92 1-1.64v-2.3c0-.7-.41-1.31-1-1.62zM9 14c.55 0 1-.45 1-1s-.45-1-1-1-1 .45-1 1 .45 1 1 1zm6 0c.55 0 1-.45 1-1s-.45-1-1-1-1 .45-1 1 .45 1 1 1zm3-2.97C17.52 8.18 15.04 6 12.05 6c-3.03 0-6.29 2.51-6.03 6.45 2.47-1.01 4.33-3.21 4.86-5.89 1.31 2.63 4 4.44 7.12 4.47z"
    )
}
val Icons.Filled.SupportAgent: ImageVector get() = _SupportAgent

private val _Today by lazy {
    captainIcon(
        "Today",
        "M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM7 10h5v5H7z"
    )
}
val Icons.Filled.Today: ImageVector get() = _Today

private val _TwoWheeler by lazy {
    captainIcon(
        "TwoWheeler",
        "M20 11c-.18 0-.36.03-.53.05L17.41 9H20V6l-3.72 1.86L13.41 5H9v2h3.59l2 2H11l-4 2-2-2H0v2h4c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4l2 2h3l3.49-6.1 1.01 1.01c-.91.73-1.5 1.84-1.5 3.09 0 2.21 1.79 4 4 4s4-1.79 4-4-1.79-4-4-4zM4 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm16 0c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"
    )
}
val Icons.Filled.TwoWheeler: ImageVector get() = _TwoWheeler

private val _VerifiedUser by lazy {
    captainIcon(
        "VerifiedUser",
        "M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"
    )
}
val Icons.Filled.VerifiedUser: ImageVector get() = _VerifiedUser

private val _Visibility by lazy {
    captainIcon(
        "Visibility",
        "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"
    )
}
val Icons.Filled.Visibility: ImageVector get() = _Visibility

private val _VisibilityOff by lazy {
    captainIcon(
        "VisibilityOff",
        "M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46A11.804 11.804 0 001 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"
    )
}
val Icons.Filled.VisibilityOff: ImageVector get() = _VisibilityOff

private val _WbSunny by lazy {
    captainIcon(
        "WbSunny",
        "M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z"
    )
}
val Icons.Filled.WbSunny: ImageVector get() = _WbSunny

private val _Work by lazy {
    captainIcon(
        "Work",
        "M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z"
    )
}
val Icons.Filled.Work: ImageVector get() = _Work

private val _WorkOff by lazy {
    captainIcon(
        "WorkOff",
        "M23 21.74l-1.46-1.46L7.21 5.95 3.25 1.99 1.99 3.25l2.7 2.7h-.69c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h15.73l2 2L23 21.74zM22 8c0-1.11-.89-2-2-2h-4V4c0-1.11-.89-2-2-2h-4c-.99 0-1.8.7-1.96 1.64L10 5.6V4h4v2h-3.6L22 17.6V8z"
    )
}
val Icons.Filled.WorkOff: ImageVector get() = _WorkOff
