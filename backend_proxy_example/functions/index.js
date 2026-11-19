// ==============================================================================
// El-Batal Express - Production-Ready Secure Backend Proxy & Cloud Functions
// ==============================================================================
// Complete Order Lifecycle & Security Rules Compliance
// 1. acceptDeliveryOffer (alias: acceptOrder)
// 2. captainArrivedAtMerchant (alias: captainArrived)
// 3. confirmPickup
// 4. submitCustomerDeliveryDetails (alias: submitReceiptAndCustomerData)
// 5. confirmDelivery (alias: completeDelivery)
// 6. expireDeliveryOffer
// 7. assignNextAvailableCaptain
// 8. merchantConfirmOrder
// 9. uploadImageToImgBB
// 10. updateFcmToken
// 11. onOrderCreatedNotifyCaptains (FCM Push for New Orders)
// 12. scheduledShiftBoundaryNotifications (FCM Push for Shift Start / End)
// ==============================================================================

const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const axios = require("axios");
const FormData = require("form-data");
const busboy = require("busboy");
const crypto = require("crypto");

if (!admin.apps.length) {
  admin.initializeApp();
}

// ------------------------------------------------------------------------------
// Authentication and role authorization
// ------------------------------------------------------------------------------
async function authenticateUser(req, res) {
  const authHeader = String(req.headers.authorization || "");
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: "غير مصرح: يجب تسجيل الدخول أولاً" });
    return null;
  }

  try {
    return await admin.auth().verifyIdToken(match[1].trim(), true);
  } catch (error) {
    console.error("Firebase ID token verification failed:", error);
    res.status(401).json({ error: "جلسة الدخول غير صالحة أو منتهية. يرجى تسجيل الدخول مجدداً." });
    return null;
  }
}

const ADMIN_EMAIL_ALLOWLIST = new Set([
  "moamen.elsayed.abdelmoamen@gmail.com",
  "admin@elbatalexpress.com"
]);

async function isAdminUser(db, user) {
  if (!user || !user.uid) return false;

  const tokenRole = String(user.role || "").trim().toLowerCase();
  if (tokenRole === "admin" || user.admin === true) return true;

  const email = String(user.email || "").trim().toLowerCase();
  if (user.email_verified === true && ADMIN_EMAIL_ALLOWLIST.has(email)) return true;

  const adminSnap = await db.collection("admins").doc(user.uid).get();
  if (!adminSnap.exists) return false;

  const adminData = adminSnap.data() || {};
  const status = String(adminData.status || "active").trim().toLowerCase();
  return !["pending_verification", "disabled", "suspended", "blocked", "inactive"].includes(status);
}

function isActiveMerchantRecord(user, merchantData) {
  if (!user || !merchantData) return false;
  const status = String(merchantData.status || "").trim().toLowerCase();
  return (!merchantData.uid || merchantData.uid === user.uid) &&
    merchantData.accountType === "merchant" &&
    (!merchantData.role || String(merchantData.role).trim().toLowerCase() === "merchant") &&
    user.email_verified === true &&
    ["approved", "active"].includes(status);
}

async function isMerchantOwnerOfOrder(db, user, orderData) {
  if (!user || !user.uid || !orderData) return false;
  const merchantId = String(
    orderData.merchantId || orderData.restaurantId || orderData.storeId ||
    orderData.vendorId || orderData.ownerId || ""
  ).trim();
  if (!merchantId || merchantId !== user.uid) return false;

  const merchantSnap = await db.collection("merchants").doc(user.uid).get();
  return merchantSnap.exists && isActiveMerchantRecord(user, merchantSnap.data() || {});
}

async function isAdminOrOrderMerchant(db, user, orderData) {
  if (await isAdminUser(db, user)) return true;
  return isMerchantOwnerOfOrder(db, user, orderData);
}

// Captain endpoints require a real, active captain account, not merely a valid Firebase login.
async function authenticateCaptain(req, res) {
  const user = await authenticateUser(req, res);
  if (!user) return null;

  const captainSnap = await admin.firestore().collection("captains").doc(user.uid).get();
  if (!captainSnap.exists) {
    res.status(403).json({ error: "هذا الحساب غير مسجل ككابتن." });
    return null;
  }

  const captainData = captainSnap.data() || {};
  const accountType = String(captainData.accountType || "").trim().toLowerCase();
  const role = String(captainData.role || "captain").trim().toLowerCase();
  const status = String(captainData.status || "active").trim().toLowerCase();

  if (
    accountType !== "captain" ||
    role !== "captain" ||
    INACTIVE_ACCOUNT_STATUSES.has(status) ||
    captainData.isApproved === false
  ) {
    res.status(403).json({ error: "حساب الكابتن غير مفعل أو غير مصرح له بتنفيذ هذه العملية." });
    return null;
  }

  return user;
}

/**
 * Resilient order document reference resolver:
 * Handles order IDs with or without leading '#', as well as matching by 'orderNumber' or 'order_number' fields.
 */
async function resolveOrderReference(db, orderId) {
  const rawStr = String(orderId || "").trim();
  const cleanId = rawStr.replace(/^#+/, "").trim();
  if (!cleanId) return null;

  // 1. Direct document ID match with cleanId
  let ref = db.collection("orders").doc(cleanId);
  let snap = await ref.get();
  if (snap.exists) return ref;

  // 2. Direct document ID match with raw string (if had '#')
  if (rawStr !== cleanId) {
    ref = db.collection("orders").doc(rawStr);
    snap = await ref.get();
    if (snap.exists) return ref;
  }

  // 3. Document ID prefixed with '#'
  ref = db.collection("orders").doc("#" + cleanId);
  snap = await ref.get();
  if (snap.exists) return ref;

  // 4. Query by orderNumber field
  const q1 = await db.collection("orders")
    .where("orderNumber", "in", [cleanId, "#" + cleanId])
    .limit(1)
    .get();
  if (!q1.empty) return q1.docs[0].ref;

  // 5. Query by order_number field
  const q2 = await db.collection("orders")
    .where("order_number", "in", [cleanId, "#" + cleanId])
    .limit(1)
    .get();
  if (!q2.empty) return q2.docs[0].ref;

  return db.collection("orders").doc(cleanId);
}

// ------------------------------------------------------------------------------
// Helper: Captain Online & Cairo Working Shift Eligibility
// Ensures offline or outside-shift captains are NEVER assigned or allowed to accept orders
// ------------------------------------------------------------------------------
const INACTIVE_ACCOUNT_STATUSES = new Set([
  "banned", "suspended", "disabled", "blocked", "pending", "inactive"
]);

const ONGOING_ORDER_STATUSES = [
  "accepted", "assigned", "arrived_at_merchant", "at_store",
  "picked_up", "order_data_entered", "awaiting_merchant_confirmation",
  "merchant_rejected", "en_route", "confirmed", "merchant_confirmed",
  "confirmed_by_merchant", "approved", "out_for_delivery", "delivering"
];

function isCaptainOnlineAndActive(captainData) {
  if (!captainData) return false;
  if (String(captainData.accountType || "").trim().toLowerCase() !== "captain") return false;
  if (captainData.role && String(captainData.role).trim().toLowerCase() !== "captain") return false;
  if (captainData.isOnline !== true) return false;
  if (captainData.canReceiveOrders !== true) return false;
  if (String(captainData.presenceStatus || "").trim().toLowerCase() === "offline") return false;
  const statusStr = String(captainData.status || "active").trim().toLowerCase();
  if (INACTIVE_ACCOUNT_STATUSES.has(statusStr)) return false;
  if (captainData.isApproved === false) return false;
  return true;
}

function getCairoNowInfo() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);

  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const weekdayMap = {
    Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6, Sat: 7
  };
  const hour = Number(map.hour) % 24;
  const minute = Number(map.minute);
  return {
    dayOfWeek: weekdayMap[map.weekday] || 1,
    currentMinutes: hour * 60 + minute,
    dateKey: `${map.year}-${map.month}-${map.day}`
  };
}

function formatMinutesArabicBackend(totalMinutes) {
  const clamped = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hour24 = Math.floor(clamped / 60);
  const minute = clamped % 60;
  const period = hour24 >= 12 ? "م" : "ص";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

const ARABIC_DAYS_MAP = {
  1: "الأحد",
  2: "الإثنين",
  3: "الثلاثاء",
  4: "الأربعاء",
  5: "الخميس",
  6: "الجمعة",
  7: "السبت"
};

function parseShiftTimeToMinutesBackend(raw, fallbackMinutes) {
  if (raw === null || raw === undefined) return fallbackMinutes;
  if (typeof raw === "number") {
    if (raw >= 0 && raw <= 24) return Math.round(raw * 60);
    if (raw > 24 && raw <= 1440) return Math.round(raw);
  }
  if (typeof raw === "object") {
    if (typeof raw.toDate === "function") {
      const d = raw.toDate();
      const info = new Intl.DateTimeFormat("en-US", {
        timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hour12: false
      }).formatToParts(d);
      const pm = {};
      for (const p of info) pm[p.type] = p.value;
      return (Number(pm.hour) % 24) * 60 + Number(pm.minute);
    }
    const h = raw.hour ?? raw.hours ?? raw.h;
    const m = raw.minute ?? raw.minutes ?? raw.min ?? raw.m ?? 0;
    if (h !== undefined) return (Number(h) % 24) * 60 + Number(m || 0);
  }
  const s = String(raw).trim()
    .replace(/[٠-٩]/g, ch => String(ch.charCodeAt(0) - 0x0660));
  if (!s) return fallbackMinutes;
  const isPm = /pm|م/i.test(s);
  const isAm = /am|ص/i.test(s);
  const match = s.match(/(\d{1,2})(?::(\d{1,2}))?/);
  if (!match) return fallbackMinutes;
  let h = Number(match[1]);
  const m = Number(match[2] || 0);
  if (isPm && h < 12) h += 12;
  if (isAm && h === 12) h = 0;
  return Math.max(0, Math.min(1439, h * 60 + m));
}

function normalizeDayCodeBackend(rawDay, fallbackDay = null) {
  if (typeof rawDay === "number") {
    const map = { 0: 7, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };
    return map[rawDay] ?? fallbackDay;
  }
  const s = String(rawDay || "").trim().toLowerCase();
  if (!s) return fallbackDay;
  if (s.includes("sat") || s.includes("سبت") || s === "0" || s === "day_0" || s === "day0") return 7;
  if (s.includes("sun") || s.includes("أحد") || s.includes("احد") || s === "1" || s === "day_1" || s === "day1") return 1;
  if (s.includes("mon") || s.includes("إثنين") || s.includes("اثنين") || s === "2" || s === "day_2" || s === "day2") return 2;
  if (s.includes("tue") || s.includes("ثلاثاء") || s === "3" || s === "day_3" || s === "day3") return 3;
  if (s.includes("wed") || s.includes("أربعاء") || s.includes("اربعاء") || s === "4" || s === "day_4" || s === "day4") return 4;
  if (s.includes("thu") || s.includes("خميس") || s === "5" || s === "day_5" || s === "day5") return 5;
  if (s.includes("fri") || s.includes("جمعة") || s === "6" || s === "day_6" || s === "day6") return 6;
  return fallbackDay;
}

function extractShiftListFromDocData(docData) {
  if (!docData || typeof docData !== "object") return [];
  const entries = [];
  const container = docData.shifts ?? docData.schedule ?? docData.weeklySchedule ??
    docData.weekly_schedule ?? docData.workShifts ?? docData.work_shifts ??
    docData.days ?? docData.schedules ?? docData.workingHours ?? docData.working_hours;

  const parseEntry = (item, fallbackDay) => {
    if (!item || typeof item !== "object") return null;
    const dayCode = normalizeDayCodeBackend(
      item.dayOfWeek ?? item.day_of_week ?? item.day ?? item.dayName ?? item.weekday,
      fallbackDay
    );
    if (!dayCode) return null;
    const isDayOff = Boolean(item.isDayOff ?? item.is_day_off ?? item.dayOff ?? item.isOff ?? item.off ?? item.holiday);
    const startRaw = item.startTime ?? item.start_time ?? item.shiftStart ?? item.shift_start ?? item.start ?? item.from;
    const endRaw = item.endTime ?? item.end_time ?? item.shiftEnd ?? item.shift_end ?? item.end ?? item.to;
    const startMin = parseShiftTimeToMinutesBackend(startRaw, 12 * 60);
    const endMin = parseShiftTimeToMinutesBackend(endRaw, 20 * 60);
    return { dayOfWeek: dayCode, isDayOff, startMin, endMin };
  };

  if (Array.isArray(container)) {
    const idxToDay = [7, 1, 2, 3, 4, 5, 6];
    container.forEach((item, idx) => {
      const parsed = parseEntry(item, idxToDay[idx] || 7);
      if (parsed) entries.push(parsed);
    });
  } else if (container && typeof container === "object") {
    Object.entries(container).forEach(([k, v]) => {
      const parsed = parseEntry(v, normalizeDayCodeBackend(k, null));
      if (parsed) entries.push(parsed);
    });
  }

  if (entries.length === 0) {
    const startRaw = docData.startTime ?? docData.start_time ?? docData.shiftStart ?? docData.shift_start;
    const endRaw = docData.endTime ?? docData.end_time ?? docData.shiftEnd ?? docData.shift_end;
    if (startRaw !== undefined || endRaw !== undefined) {
      const startMin = parseShiftTimeToMinutesBackend(startRaw, 12 * 60);
      const endMin = parseShiftTimeToMinutesBackend(endRaw, 20 * 60);
      const singleDay = normalizeDayCodeBackend(docData.dayOfWeek ?? docData.day_of_week ?? docData.day, null);
      if (singleDay) {
        entries.push({
          dayOfWeek: singleDay,
          isDayOff: Boolean(docData.isDayOff ?? docData.is_day_off),
          startMin,
          endMin
        });
      } else {
        for (let d = 1; d <= 7; d++) {
          entries.push({ dayOfWeek: d, isDayOff: d === 6 && (docData.fridayOff !== false), startMin, endMin });
        }
      }
    }
  }
  return entries;
}

async function collectCaptainShifts(db, captainUid, captainData) {
  // Primary schedule source managed by the admin dashboard. If a document exists,
  // it is authoritative even when it contains an empty schedule (no active shifts).
  try {
    const primary = await db.collection("captain_schedules").doc(captainUid).get();
    if (primary.exists) {
      return extractShiftListFromDocData(primary.data());
    }
  } catch (error) {
    console.warn("Primary captain_schedules read failed:", captainUid, error.message);
  }

  // Legacy fallback sources are consulted one at a time, never merged together.
  const embedded = extractShiftListFromDocData(captainData);
  if (embedded.length > 0) return embedded;

  try {
    const legacySchedule = await db.collection("schedules").doc(captainUid).get();
    if (legacySchedule.exists) {
      const shifts = extractShiftListFromDocData(legacySchedule.data());
      if (shifts.length > 0) return shifts;
    }
  } catch (_) {}

  for (const field of ["captainId", "captainUid", "driverId"]) {
    try {
      const qs = await db.collection("shifts").where(field, "==", captainUid).get();
      const legacyShifts = [];
      qs.forEach(d => legacyShifts.push(...extractShiftListFromDocData(d.data())));
      if (legacyShifts.length > 0) return legacyShifts;
    } catch (_) {}
  }

  return [];
}

async function isCaptainInActiveShift(db, captainUid, captainData) {
  const allShifts = await collectCaptainShifts(db, captainUid, captainData);

  if (allShifts.length === 0) {
    return { active: false, reason: "لا يوجد جدول شفتات عمل نشط محدد للكابتن حالياً." };
  }

  const { dayOfWeek: todayDay, currentMinutes } = getCairoNowInfo();
  const yesterdayDay = todayDay === 1 ? 7 : todayDay - 1;

  // Check ongoing overnight shift from yesterday
  const yesterdayShift = allShifts.find(s => s.dayOfWeek === yesterdayDay && !s.isDayOff);
  if (yesterdayShift && yesterdayShift.endMin < yesterdayShift.startMin && currentMinutes < yesterdayShift.endMin) {
    return { active: true };
  }

  const todayShift = allShifts.find(s => s.dayOfWeek === todayDay);
  if (!todayShift || todayShift.isDayOff) {
    return { active: false, reason: "الكابتن في يوم عطلة أو خارج شفت العمل اليوم." };
  }

  const isOvernight = todayShift.endMin < todayShift.startMin;
  const activeNow = isOvernight
    ? currentMinutes >= todayShift.startMin
    : (currentMinutes >= todayShift.startMin && currentMinutes < todayShift.endMin);

  if (!activeNow) {
    return { active: false, reason: "الكابتن خارج ساعات الشفت الرسمية حالياً." };
  }
  return { active: true };
}

// ------------------------------------------------------------------------------
// Helper: Geospatial Haversine Distance & Nearest Eligible Captain to Merchant
// ------------------------------------------------------------------------------
function isValidLatLng(lat, lng) {
  return Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    !(lat === 0 && lng === 0) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180;
}

function parseCoordNumber(val) {
  if (typeof val === "number") return Number.isFinite(val) ? val : NaN;
  if (typeof val === "string" && val.trim()) {
    const n = Number(val.trim());
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function parseCoordsFromGoogleMapsUrl(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!url) return null;
  const patterns = [
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (isValidLatLng(lat, lng)) return { lat, lng };
    }
  }
  return null;
}

function extractCaptainCoordinates(cData) {
  if (!cData || typeof cData !== "object") return null;
  const candidates = [
    [cData.lat, cData.lng],
    [cData.latitude, cData.longitude],
    [cData.currentLat, cData.currentLng],
    [cData.currentLocation?.lat, cData.currentLocation?.lng],
    [cData.currentLocation?.latitude, cData.currentLocation?.longitude],
    [cData.location?.lat, cData.location?.lng],
    [cData.location?.latitude, cData.location?.longitude],
    [cData.coords?.lat, cData.coords?.lng]
  ];
  for (const [rLat, rLng] of candidates) {
    const lat = parseCoordNumber(rLat);
    const lng = parseCoordNumber(rLng);
    if (isValidLatLng(lat, lng)) return { lat, lng };
  }
  return null;
}

function getCaptainLocationTimestampMs(captainData) {
  const value = captainData?.lastLocationUpdate;
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  return 0;
}

function isCaptainLocationFresh(captainData, nowMs = Date.now()) {
  const updatedAtMs = getCaptainLocationTimestampMs(captainData);
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return false;
  const ageMs = nowMs - updatedAtMs;
  return ageMs >= -10000 && ageMs <= 60000;
}



async function extractMerchantCoordinates(db, orderData) {
  if (!orderData || typeof orderData !== "object") return null;
  const directCandidates = [
    [orderData.pickupLat, orderData.pickupLng],
    [orderData.storeLat, orderData.storeLng],
    [orderData.merchantLat, orderData.merchantLng],
    [orderData.restaurantLat, orderData.restaurantLng],
    [orderData.pickupLocation?.lat, orderData.pickupLocation?.lng],
    [orderData.pickupLocation?.latitude, orderData.pickupLocation?.longitude],
    [orderData.merchantLocation?.lat, orderData.merchantLocation?.lng],
    [orderData.storeLocation?.lat, orderData.storeLocation?.lng]
  ];
  for (const [rLat, rLng] of directCandidates) {
    const lat = parseCoordNumber(rLat);
    const lng = parseCoordNumber(rLng);
    if (isValidLatLng(lat, lng)) return { lat, lng };
  }
  const fromUrl = parseCoordsFromGoogleMapsUrl(
    orderData.merchantMapUrl || orderData.storeMapUrl || orderData.pickupMapUrl || orderData.mapUrl
  );
  if (fromUrl) return fromUrl;

  const merchantId = String(
    orderData.merchantId || orderData.restaurantId || orderData.storeId || orderData.vendorId || ""
  ).trim();
  if (merchantId) {
    for (const col of ["restaurants", "merchants"]) {
      try {
        const mDoc = await db.collection(col).doc(merchantId).get();
        if (mDoc.exists) {
          const m = mDoc.data() || {};
          const mCandidates = [
            [m.lat, m.lng],
            [m.latitude, m.longitude],
            [m.location?.lat, m.location?.lng],
            [m.location?.latitude, m.location?.longitude],
            [m.coords?.lat, m.coords?.lng]
          ];
          for (const [rLat, rLng] of mCandidates) {
            const lat = parseCoordNumber(rLat);
            const lng = parseCoordNumber(rLng);
            if (isValidLatLng(lat, lng)) return { lat, lng };
          }
          const mUrl = parseCoordsFromGoogleMapsUrl(m.mapUrl || m.googleMapsUrl || m.locationUrl);
          if (mUrl) return mUrl;
        }
      } catch (_) {}
    }
  }
  return null;
}

function calculateDistanceKmBackend(lat1, lng1, lat2, lng2) {
  if (!isValidLatLng(lat1, lng1) || !isValidLatLng(lat2, lng2)) return Infinity;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const rKm = 6371.0;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return rKm * c;
}

async function findNearestEligibleCaptain(db, orderData, extraExcludedIds = [], preferredCaptainId = "") {
  const excludedSet = new Set([
    ...(Array.isArray(orderData?.excludedCaptainIds) ? orderData.excludedCaptainIds : []),
    ...extraExcludedIds
  ].map(v => String(v || "").trim()).filter(Boolean));
  const preferredId = String(preferredCaptainId || "").trim();

  const captainsSnapshot = await db.collection("captains")
    .where("isOnline", "==", true)
    .limit(200)
    .get();
  if (captainsSnapshot.empty) return [];

  const merchantCoords = await extractMerchantCoordinates(db, orderData);
  if (!merchantCoords) {
    console.warn("Automatic dispatch skipped: merchant coordinates are missing or invalid.");
    return [];
  }

  const eligibleCandidates = [];
  const nowMs = Date.now();

  for (const doc of captainsSnapshot.docs) {
    if (excludedSet.has(doc.id)) continue;
    if (preferredId && doc.id !== preferredId) continue;

    const cData = doc.data() || {};
    if (!isCaptainOnlineAndActive(cData) || cData.canReceiveOrders === false) continue;
    if (!isCaptainLocationFresh(cData, nowMs)) continue;

    const capCoords = extractCaptainCoordinates(cData);
    if (!capCoords) continue;

    const lockSnap = await db.collection("captain_order_locks").doc(doc.id).get();
    if (lockSnap.exists) {
      const lockData = lockSnap.data() || {};
      const lockStatus = String(lockData.status || "").trim().toLowerCase();
      const lockExpiresAt = Number(lockData.expiresAt || 0);
      if (lockStatus === "accepted" || (lockStatus === "offered" && lockExpiresAt > nowMs)) continue;
    }

    const ongoingSnap = await db.collection("orders")
      .where("captainId", "==", doc.id)
      .where("status", "in", ONGOING_ORDER_STATUSES)
      .limit(1)
      .get();
    if (!ongoingSnap.empty) continue;

    const shiftCheck = await isCaptainInActiveShift(db, doc.id, cData);
    if (!shiftCheck.active) continue;

    const distanceKm = calculateDistanceKmBackend(
      merchantCoords.lat, merchantCoords.lng, capCoords.lat, capCoords.lng
    );
    if (!Number.isFinite(distanceKm)) continue;

    eligibleCandidates.push({ doc, distanceKm });
  }

  eligibleCandidates.sort((a, b) => {
    if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    return a.doc.id.localeCompare(b.doc.id);
  });

  return eligibleCandidates;
}

async function sendNewOrderFcmToCaptain(db, captainId, captainData, orderId, orderData, customDistanceKm = null) {
  const fcmToken = String(
    captainData?.fcmToken || captainData?.fcm_token || captainData?.messagingToken || ""
  ).trim();
  if (!fcmToken) return false;
  if (captainData?.isLoggedIn === false) return false;
  if (!isCaptainOnlineAndActive(captainData) || !isCaptainLocationFresh(captainData)) return false;

  const ongoingSnap = await db.collection("orders")
    .where("captainId", "==", captainId)
    .where("status", "in", ONGOING_ORDER_STATUSES)
    .limit(1)
    .get();
  if (!ongoingSnap.empty) return false;

  const shiftCheck = await isCaptainInActiveShift(db, captainId, captainData);
  if (!shiftCheck.active) return false;

  const storeName = String(
    orderData?.storeName || orderData?.merchantName || orderData?.restaurantName || "مطعم مسجل"
  ).trim();
  const pickupAddress = String(orderData?.pickupAddress || orderData?.storeAddress || "").trim();
  const deliveryAddress = String(orderData?.deliveryAddress || orderData?.customerAddress || "").trim();
  const feeNum = Number(orderData?.deliveryFee || orderData?.captainEarning || 25);
  const safeFee = Number.isFinite(feeNum) && feeNum > 0 ? feeNum : 25;

  const expiresAtNum = Number(orderData?.offerExpiresAt || 0);
  const effectiveExpiresAt = expiresAtNum > Date.now() ? expiresAtNum : (Date.now() + 60000);
  const safeDistance = Number.isFinite(customDistanceKm)
    ? customDistanceKm
    : (Number.isFinite(Number(orderData?.distanceKm)) ? Number(orderData.distanceKm) : 3.0);

  const rawCodeCandidate =
    orderData?.orderCodes ??
    orderData?.order_codes ??
    orderData?.orderCode ??
    orderData?.order_code ??
    orderData?.["Ordar codes"] ??
    orderData?.["Ordar code"] ??
    orderData?.ordarCodes ??
    orderData?.ordarCode ??
    orderData?.trackingCode ??
    orderData?.shortCode ??
    orderData?.code ??
    orderData?.codes ??
    "";
  const orderCode = Array.isArray(rawCodeCandidate)
    ? rawCodeCandidate.map(v => String(v || "").trim()).filter(Boolean).join(" • ")
    : String(rawCodeCandidate || "").trim().replace(/^#+/, "");

  // IMPORTANT: Data-only high-priority FCM ensures CaptainFirebaseMessagingService.onMessageReceived
  // always executes even when the app is closed/backgrounded so the continuous bell + 60s countdown
  // notification & full-screen alert fire reliably.
  try {
    await admin.messaging().send({
      token: fcmToken,
      android: {
        priority: "high",
        ttl: 60 * 1000
      },
      data: {
        type: "new_order",
        orderId: String(orderId || ""),
        orderCode,
        storeName,
        pickupAddress,
        deliveryAddress,
        deliveryFee: String(safeFee),
        offerExpiresAt: String(effectiveExpiresAt),
        distanceKm: String(safeDistance),
        offeredCaptainId: String(captainId),
        offerId: String(orderData?.offerId || "")
      }
    });
    return true;
  } catch (err) {
    console.warn("Failed to send new-order FCM to captain:", captainId, err.message);
    return false;
  }
}

async function assignNearestCaptainInternal(db, orderRef, orderData, extraExcludedIds = []) {
  const preferredCaptainId = String(orderData?.preferredCaptainId || orderData?.captainId || "").trim();
  const candidates = await findNearestEligibleCaptain(db, orderData, extraExcludedIds, preferredCaptainId);
  const nowMs = Date.now();

  // Idempotency: do not replace a still-live offer when a Firestore trigger or scheduler retries.
  const existingOfferedCaptainId = String(orderData?.offeredCaptainId || "").trim();
  const existingOfferId = String(orderData?.offerId || "").trim();
  const existingExpiresAt = Number(orderData?.offerExpiresAt || 0);
  if (existingOfferedCaptainId && existingOfferId && existingExpiresAt > nowMs) {
    return {
      assigned: true,
      alreadyOffered: true,
      offeredCaptainId: existingOfferedCaptainId,
      offerId: existingOfferId,
      distanceKm: Number(orderData?.nearestDistanceKm || 0) || null,
      offerExpiresAt: existingExpiresAt
    };
  }

  for (const candidate of candidates) {
    const captainId = candidate.doc.id;
    const captainRef = db.collection("captains").doc(captainId);
    const lockRef = db.collection("captain_order_locks").doc(captainId);
    const offerId = crypto.randomUUID();
    const offerExpiresAt = Date.now() + 60000;
    const distanceKm = Number(candidate.distanceKm.toFixed(2));
    const notifyKey = `${captainId}_${offerExpiresAt}`;
    let reserved = false;
    let refreshedCaptainData = null;
    let existingOffer = null;

    await db.runTransaction(async (transaction) => {
      const orderDoc = await transaction.get(orderRef);
      if (!orderDoc.exists) throw new Error("الطلب غير موجود");
      const currentOrder = orderDoc.data() || {};
      const currentStatus = String(currentOrder.status || "").trim().toLowerCase();
      const currentOfferedCaptain = String(currentOrder.offeredCaptainId || "").trim();
      const currentOfferId = String(currentOrder.offerId || "").trim();
      const currentOfferExpiresAt = Number(currentOrder.offerExpiresAt || 0);
      const currentAssignedCaptain = String(currentOrder.captainId || currentOrder.driverId || "").trim();

      if (currentOfferedCaptain && currentOfferId && currentOfferExpiresAt > Date.now()) {
        existingOffer = {
          offeredCaptainId: currentOfferedCaptain,
          offerId: currentOfferId,
          offerExpiresAt: currentOfferExpiresAt,
          distanceKm: Number(currentOrder.nearestDistanceKm || 0) || null
        };
        return;
      }

      if (!["new", "pending", "searching", "offered", "ready", "ready_for_pickup", "waiting_driver"].includes(currentStatus)) {
        return;
      }
      if (currentAssignedCaptain && currentAssignedCaptain !== captainId) return;

      const [captainDoc, lockDoc, ongoingOrders] = await Promise.all([
        transaction.get(captainRef),
        transaction.get(lockRef),
        transaction.get(db.collection("orders")
          .where("captainId", "==", captainId)
          .where("status", "in", ONGOING_ORDER_STATUSES)
          .limit(1))
      ]);

      if (!captainDoc.exists) return;
      const captainData = captainDoc.data() || {};
      if (
        !isCaptainOnlineAndActive(captainData) ||
        captainData.canReceiveOrders === false ||
        !isCaptainLocationFresh(captainData)
      ) return;

      if (ongoingOrders.docs.some(d => d.id !== orderRef.id)) return;

      if (lockDoc.exists) {
        const lockData = lockDoc.data() || {};
        const lockStatus = String(lockData.status || "").trim().toLowerCase();
        const lockExpiresAt = Number(lockData.expiresAt || 0);
        const lockOrderId = String(lockData.orderId || "").trim();
        if (lockStatus === "accepted") return;
        if (lockStatus === "offered" && lockExpiresAt > Date.now() && lockOrderId !== orderRef.id) return;
      }

      refreshedCaptainData = captainData;
      transaction.set(lockRef, {
        captainId,
        orderId: orderRef.id,
        offerId,
        status: "offered",
        expiresAt: offerExpiresAt,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      transaction.update(orderRef, {
        status: "pending",
        dispatchStatus: "offered",
        captainId,
        driverId: captainId,
        captainName: String(captainData.name || captainData.driver_name || captainData.fullName || "كابتن معتمد"),
        offeredCaptainId: captainId,
        offerId,
        offerExpiresAt,
        preferredCaptainId: admin.firestore.FieldValue.delete(),
        nearestDistanceKm: distanceKm,
        lastOfferedNotifyKey: notifyKey,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      reserved = true;
    });

    if (existingOffer) {
      return { assigned: true, alreadyOffered: true, ...existingOffer };
    }

    if (!reserved) continue;

    const captainData = refreshedCaptainData || candidate.doc.data() || {};
    await sendNewOrderFcmToCaptain(
      db,
      captainId,
      captainData,
      orderRef.id,
      { ...orderData, offerId, offerExpiresAt },
      distanceKm
    );

    return {
      assigned: true,
      offeredCaptainId: captainId,
      offerId,
      distanceKm,
      offerExpiresAt
    };
  }

  // No suitable captain; clear only an unassigned order. Never overwrite a concurrently accepted order.
  await db.runTransaction(async (transaction) => {
    const orderDoc = await transaction.get(orderRef);
    if (!orderDoc.exists) return;
    const current = orderDoc.data() || {};
    const assigned = String(current.captainId || current.driverId || "").trim();
    const offered = String(current.offeredCaptainId || "").trim();
    const expires = Number(current.offerExpiresAt || 0);
    if (assigned || (offered && String(current.offerId || "").trim() && expires > Date.now())) return;

    transaction.update(orderRef, {
      status: "searching",
      dispatchStatus: "searching",
      captainId: null,
      driverId: null,
      offeredCaptainId: null,
      offerId: null,
      offerExpiresAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return {
    assigned: false,
    offeredCaptainId: null,
    offerId: null,
    distanceKm: null,
    offerExpiresAt: null
  };
}

// ------------------------------------------------------------------------------
// 1. Cloud Function: acceptDeliveryOffer (alias: acceptOrder)
// Enforces:
// - Captain must be online and active (never accept when offline)
// - Captain must be inside active working shift hours (Africa/Cairo)
// - 60s offer validity window
// - Prevents double assignment (atomic transaction)
// - Ensures captain has no other active orders
// ------------------------------------------------------------------------------
async function handleAcceptDeliveryOffer(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  const user = await authenticateCaptain(req, res);
  if (!user) return;

  const orderId = String(req.body?.orderId || "").trim();
  const offerId = String(req.body?.offerId || "").trim();
  if (!orderId || !offerId) {
    return res.status(400).json({ error: "معرف الطلب ومعرف العرض مطلوبان لقبول الطلب" });
  }

  const db = admin.firestore();
  const orderRef = await resolveOrderReference(db, orderId);
  if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

  try {
    const captainRef = db.collection("captains").doc(user.uid);
    const lockRef = db.collection("captain_order_locks").doc(user.uid);
    const captainSnapshot = await captainRef.get();
    const captainData = captainSnapshot.exists ? (captainSnapshot.data() || {}) : null;

    if (
      !captainData ||
      !isCaptainOnlineAndActive(captainData) ||
      captainData.canReceiveOrders === false ||
      !isCaptainLocationFresh(captainData)
    ) {
      return res.status(403).json({
        error: "لا يمكنك قبول الطلب: يجب أن يكون حسابك معتمداً ومتصلًا وموقعك حديثاً."
      });
    }

    const shiftCheck = await isCaptainInActiveShift(db, user.uid, captainData);
    if (!shiftCheck.active) {
      return res.status(403).json({
        error: "عفواً، أنت خارج ساعات العمل الرسمية ولا يمكنك قبول طلبات جديدة حالياً."
      });
    }

    await db.runTransaction(async (transaction) => {
      const orderDoc = await transaction.get(orderRef);
      if (!orderDoc.exists) throw new Error("هذا الطلب لم يعد متاحاً");

      const captainDoc = await transaction.get(captainRef);
      const lockDoc = await transaction.get(lockRef);
      const otherActiveOrders = await transaction.get(
        db.collection("orders")
          .where("captainId", "==", user.uid)
          .where("status", "in", ONGOING_ORDER_STATUSES)
          .limit(2)
      );

      const data = orderDoc.data() || {};
      const currentStatus = String(data.status || "").trim().toLowerCase();
      const offeredCaptainId = String(data.offeredCaptainId || "").trim();
      const currentOfferId = String(data.offerId || "").trim();
      const assignedCaptain = String(data.captainId || data.driverId || "").trim();
      const offerExpiresAt = Number(data.offerExpiresAt || 0);
      const nowMs = Date.now();

      if (offeredCaptainId !== user.uid) {
        throw new Error("هذا العرض غير مخصص لحسابك");
      }
      if (currentOfferId !== offerId) {
        throw new Error("معرف العرض غير مطابق أو تم استبدال العرض بعرض أحدث");
      }
      if (!Number.isFinite(offerExpiresAt) || offerExpiresAt <= nowMs) {
        throw new Error("انتهت مهلة قبول الطلب");
      }
      if (assignedCaptain && assignedCaptain !== user.uid) {
        throw new Error("تم إسناد الطلب إلى كابتن آخر");
      }
      if (!["pending", "offered"].includes(currentStatus)) {
        throw new Error("حالة الطلب الحالية لا تسمح بالقبول");
      }

      if (!captainDoc.exists || !isCaptainOnlineAndActive(captainDoc.data() || {}) ||
          (captainDoc.data() || {}).canReceiveOrders === false ||
          !isCaptainLocationFresh(captainDoc.data() || {})) {
        throw new Error("لم تعد حالة الكابتن مؤهلة لقبول العرض");
      }

      if (!lockDoc.exists) throw new Error("حجز العرض غير موجود أو انتهت صلاحيته");
      const lockData = lockDoc.data() || {};
      if (
        String(lockData.orderId || "") !== orderRef.id ||
        String(lockData.offerId || "") !== offerId ||
        String(lockData.status || "").toLowerCase() !== "offered" ||
        Number(lockData.expiresAt || 0) <= nowMs
      ) {
        throw new Error("العرض لم يعد نشطاً أو تم حجز الكابتن لطلب آخر");
      }

      if (otherActiveOrders.docs.some(d => d.id !== orderRef.id)) {
        throw new Error("لديك طلب نشط بالفعل قيد التنفيذ، لا يمكن قبول أكثر من طلب في وقت واحد.");
      }

      transaction.update(orderRef, {
        status: "accepted",
        dispatchStatus: "accepted",
        captainId: user.uid,
        driverId: user.uid,
        offeredCaptainId: null,
        acceptedOfferId: offerId,
        acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      transaction.set(lockRef, {
        captainId: user.uid,
        orderId: orderRef.id,
        offerId,
        status: "accepted",
        expiresAt: 0,
        acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });

    return res.status(200).json({
      success: true,
      message: "تم قبول الطلب بنجاح وإسناده إليك",
      orderId: orderRef.id,
      offerId
    });
  } catch (err) {
    console.warn("acceptDeliveryOffer rejected:", err.message);
    return res.status(409).json({ error: err.message });
  }
}

exports.acceptDeliveryOffer = onRequest({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, handleAcceptDeliveryOffer);
exports.acceptOrder = onRequest({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, handleAcceptDeliveryOffer);

// ------------------------------------------------------------------------------
// 2. Cloud Function: captainArrivedAtMerchant (alias: captainArrived)
// ------------------------------------------------------------------------------
async function handleCaptainArrivedAtMerchant(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  const user = await authenticateCaptain(req, res);
  if (!user) return;

  const { orderId } = req.body || {};
  if (!orderId) return res.status(400).json({ error: "معرف الطلب مطلوب" });

  const db = admin.firestore();
  const orderRef = await resolveOrderReference(db, orderId);
  if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

  try {
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(orderRef);
      if (!doc.exists) throw new Error("الطلب غير موجود");
      const data = doc.data() || {};
      if (data.captainId !== user.uid && data.driverId !== user.uid) {
        throw new Error("غير مصرح: هذا الطلب ليس مسنداً إليك");
      }
      const currentStatus = String(data.status || "").trim().toLowerCase();
      if (["arrived_at_merchant", "at_store"].includes(currentStatus)) return;
      if (!["accepted", "assigned"].includes(currentStatus)) {
        throw new Error("لا يمكن تسجيل الوصول قبل قبول الطلب");
      }
      transaction.update(orderRef, {
        status: "arrived_at_merchant",
        arrivedAtStoreTimestamp: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    return res.status(200).json({ success: true, message: "تم تسجيل الوصول إلى التاجر بنجاح" });
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
}

exports.captainArrivedAtMerchant = onRequest({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, handleCaptainArrivedAtMerchant);
exports.captainArrived = onRequest({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, handleCaptainArrivedAtMerchant);

// ------------------------------------------------------------------------------
// 3. Cloud Function: confirmPickup
// ------------------------------------------------------------------------------
exports.confirmPickup = onRequest(
  { cors: true, timeoutSeconds: 30, memory: "256MiB" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    const user = await authenticateCaptain(req, res);
    if (!user) return;

    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: "معرف الطلب مطلوب" });

    const db = admin.firestore();
    const orderRef = await resolveOrderReference(db, orderId);
    if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

    try {
      await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(orderRef);
        if (!doc.exists) throw new Error("الطلب غير موجود");
        const data = doc.data() || {};
        if (data.captainId !== user.uid && data.driverId !== user.uid) {
          throw new Error("غير مصرح: هذا الطلب ليس مسنداً إليك");
        }

        const currentStatus = String(data.status || "").trim().toLowerCase();
        if (currentStatus === "picked_up") return;
        if (!["arrived_at_merchant", "at_store"].includes(currentStatus)) {
          throw new Error("يجب تسجيل الوصول إلى التاجر قبل تأكيد استلام الطلب");
        }

        transaction.update(orderRef, {
          status: "picked_up",
          pickedUpAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      return res.status(200).json({ success: true, message: "تم استلام الطلب من التاجر بنجاح" });
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
  }
);

// ------------------------------------------------------------------------------
// 4. Cloud Function: submitCustomerDeliveryDetails (alias: submitReceiptAndCustomerData)
// ------------------------------------------------------------------------------
async function handleSubmitCustomerDeliveryDetails(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  const user = await authenticateCaptain(req, res);
  if (!user) return;

  const { orderId, customerName, customerPhone, receiptImageUrl, receiptImagePath, notes } = req.body || {};
  const receiptUrl = String(receiptImageUrl || receiptImagePath || "").trim();
  if (!orderId) return res.status(400).json({ error: "معرف الطلب مطلوب" });
  if (!receiptUrl) return res.status(400).json({ error: "صورة الإيصال مطلوبة" });

  const db = admin.firestore();
  const orderRef = await resolveOrderReference(db, orderId);
  if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

  try {
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(orderRef);
      if (!doc.exists) throw new Error("الطلب غير موجود");
      const data = doc.data() || {};
      if (data.captainId !== user.uid && data.driverId !== user.uid) {
        throw new Error("غير مصرح: هذا الطلب ليس مسنداً إليك");
      }

      const currentStatus = String(data.status || "").trim().toLowerCase();
      if (!["picked_up", "order_data_entered", "merchant_rejected"].includes(currentStatus)) {
        throw new Error("لا يمكن إرسال بيانات العميل والإيصال قبل استلام الطلب من التاجر");
      }

      transaction.update(orderRef, {
        customerName: String(customerName || data.customerName || "").slice(0, 150),
        customerPhone: String(customerPhone || data.customerPhone || "").slice(0, 32),
        receiptImageUrl: receiptUrl,
        receiptImagePath: receiptUrl,
        notes: String(notes || data.notes || "").slice(0, 1000),
        status: "awaiting_merchant_confirmation",
        merchantConfirmed: false,
        rejectionReason: admin.firestore.FieldValue.delete(),
        receiptSubmittedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    return res.status(200).json({
      success: true,
      message: "تم حفظ بيانات الإيصال وبانتظار تأكيد التاجر"
    });
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
}

exports.submitCustomerDeliveryDetails = onRequest({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, handleSubmitCustomerDeliveryDetails);
exports.submitReceiptAndCustomerData = onRequest({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, handleSubmitCustomerDeliveryDetails);

// ------------------------------------------------------------------------------
// 5. Cloud Function: merchantConfirmOrder (Merchant reviews details & receipt)
// ------------------------------------------------------------------------------
exports.merchantConfirmOrder = onRequest(
  { cors: true, timeoutSeconds: 30, memory: "256MiB" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const user = await authenticateUser(req, res);
    if (!user) return;

    const { orderId, confirmed, approved, status, rejectionReason } = req.body || {};
    if (!orderId) return res.status(400).json({ error: "معرف الطلب مطلوب" });

    const normalizedReqStatus = String(status || "").trim().toLowerCase();
    const isConfirmed = confirmed === true ||
      confirmed === "true" ||
      approved === true ||
      ["confirmed", "merchant_confirmed", "approved", "en_route"].includes(normalizedReqStatus);

    const db = admin.firestore();
    const orderRef = await resolveOrderReference(db, orderId);
    if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

    try {
      const adminAuthorized = await isAdminUser(db, user);
      let assignedCaptainId = "";

      await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(orderRef);
        if (!doc.exists) throw new Error("الطلب غير موجود");

        const docData = doc.data() || {};
        if (!adminAuthorized) {
          const merchantId = String(
            docData.merchantId || docData.restaurantId || docData.storeId || docData.vendorId || ""
          ).trim();
          if (!merchantId || merchantId !== user.uid) {
            throw new Error("غير مصرح: هذا الطلب لا يخص حساب التاجر الحالي");
          }

          const merchantRef = db.collection("merchants").doc(user.uid);
          const merchantDoc = await transaction.get(merchantRef);
          if (!merchantDoc.exists || !isActiveMerchantRecord(user, merchantDoc.data() || {})) {
            throw new Error("حساب التاجر غير نشط أو غير معتمد");
          }
        }

        const currentStatus = String(docData.status || "").trim().toLowerCase();
        if (currentStatus !== "awaiting_merchant_confirmation") {
          throw new Error("الطلب ليس في انتظار تأكيد التاجر حالياً");
        }

        assignedCaptainId = String(
          docData.captainId || docData.driverId || docData.assignedCaptainId || docData.captainUid || ""
        ).trim();
        if (!assignedCaptainId) throw new Error("لا يوجد كابتن مسند إلى هذا الطلب");

        if (isConfirmed) {
          transaction.update(orderRef, {
            status: "en_route",
            merchantConfirmed: true,
            rejectionReason: admin.firestore.FieldValue.delete(),
            merchantConfirmedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        } else {
          transaction.update(orderRef, {
            status: "merchant_rejected",
            merchantConfirmed: false,
            rejectionReason: String(rejectionReason || "بيانات الإيصال أو العميل غير مطابقة").slice(0, 500),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      });

      if (isConfirmed && assignedCaptainId) {
        try {
          const capDoc = await db.collection("captains").doc(assignedCaptainId).get();
          const cData = capDoc.exists ? (capDoc.data() || {}) : {};
          const fcmToken = String(cData.fcmToken || cData.fcm_token || cData.messagingToken || "").trim();
          if (fcmToken) {
            await admin.messaging().send({
              token: fcmToken,
              android: {
                priority: "high",
                notification: {
                  channelId: "el_batal_orders_channel",
                  sound: "default",
                  title: "تم تأكيد بيانات الطلب من التاجر",
                  body: "يمكنك الآن تسليم الطلب للعميل وتأكيد التسليم من البطاقة النشطة."
                }
              },
              data: {
                type: "merchant_confirmed",
                orderId: String(orderRef.id)
              }
            });
          }
        } catch (fcmErr) {
          console.warn("merchantConfirmOrder FCM notice:", fcmErr.message);
        }
      }

      return res.status(200).json({ success: true, message: isConfirmed ? "تم تأكيد الطلب بنجاح" : "تم رفض البيانات" });
    } catch (err) {
      console.warn("merchantConfirmOrder rejected:", err.message);
      return res.status(403).json({ error: err.message });
    }
  }
);

// ------------------------------------------------------------------------------
// 6. Cloud Function: confirmDelivery (alias: completeDelivery)
// ------------------------------------------------------------------------------
async function handleConfirmDelivery(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  const user = await authenticateCaptain(req, res);
  if (!user) return;

  const orderId = String(req.body?.orderId || "").trim();
  if (!orderId) return res.status(400).json({ error: "معرف الطلب مطلوب" });

  const db = admin.firestore();
  const orderRef = await resolveOrderReference(db, orderId);
  if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

  const captainRef = db.collection("captains").doc(user.uid);
  // Use the canonical Firestore order document ID for an immutable, per-order ledger key.
  const transactionRecordRef = captainRef.collection("transactions").doc(orderRef.id);
  const lockRef = db.collection("captain_order_locks").doc(user.uid);

  try {
    let earnedDeliveryFee = 0;
    let alreadyCompleted = false;

    await db.runTransaction(async (transaction) => {
      const [orderDoc, captainDoc, ledgerDoc, lockDoc] = await Promise.all([
        transaction.get(orderRef),
        transaction.get(captainRef),
        transaction.get(transactionRecordRef),
        transaction.get(lockRef)
      ]);
      if (!orderDoc.exists) throw new Error("الطلب غير موجود");
      if (!captainDoc.exists) throw new Error("حساب الكابتن غير موجود");

      const orderData = orderDoc.data() || {};
      const currentCaptainId = String(orderData.captainId || orderData.driverId || "").trim();
      if (currentCaptainId !== user.uid) {
        throw new Error("غير مصرح: هذا الطلب ليس مسنداً إليك");
      }

      const currentStatus = String(orderData.status || "").trim().toLowerCase();
      if (["delivered", "completed"].includes(currentStatus)) {
        if (!ledgerDoc.exists) {
          throw new Error("الطلب مكتمل لكن سجل مستحقاته غير موجود؛ يلزم فحص مالي قبل أي إعادة معالجة");
        }
        const existingLedger = ledgerDoc.data() || {};
        earnedDeliveryFee = Number(existingLedger.amount || 0);
        alreadyCompleted = true;
        return;
      }
      if (ledgerDoc.exists) {
        throw new Error("يوجد سجل مستحقات سابق لهذا الطلب مع أن حالته ليست مكتملة؛ تم إيقاف التحديث للحماية المالية");
      }

      if (!["en_route", "out_for_delivery", "delivering"].includes(currentStatus)) {
        throw new Error("لا يمكن تأكيد التسليم قبل تأكيد التاجر وخروج الطلب للتوصيل");
      }
      if (orderData.merchantConfirmed !== true) {
        throw new Error("يجب تأكيد بيانات الطلب من التاجر قبل تسجيل التسليم");
      }

      const feeRaw = orderData.deliveryFee ?? orderData.delivery_fee ?? orderData.captainEarning;
      const fee = Number(feeRaw);
      if (!Number.isFinite(fee) || fee <= 0) {
        throw new Error("قيمة مستحق الكابتن غير محددة بشكل صحيح في الطلب");
      }
      earnedDeliveryFee = fee;

      if (
        lockDoc.exists &&
        String(lockDoc.data()?.orderId || "") === orderRef.id &&
        String(lockDoc.data()?.status || "").toLowerCase() === "accepted"
      ) {
        transaction.delete(lockRef);
      }

      transaction.update(orderRef, {
        status: "delivered",
        deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
        dispatchStatus: "completed",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      transaction.update(captainRef, {
        walletBalance: admin.firestore.FieldValue.increment(earnedDeliveryFee),
        totalOrdersCount: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      transaction.create(transactionRecordRef, {
        amount: earnedDeliveryFee,
        type: "delivery_earning",
        orderId: orderRef.id,
        description: `أرباح توصيل الطلب رقم #${orderRef.id}`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.status(200).json({
      success: true,
      alreadyCompleted,
      message: alreadyCompleted
        ? "تم تسجيل تسليم هذا الطلب والمستحقات سابقاً"
        : "تم تسليم الطلب بنجاح وإضافة الأرباح لمحفظتك",
      earnedAmount: earnedDeliveryFee
    });
  } catch (err) {
    console.error("confirmDelivery rejected:", err.message);
    return res.status(409).json({ error: err.message });
  }
}

exports.confirmDelivery = onRequest({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, handleConfirmDelivery);
exports.completeDelivery = onRequest({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, handleConfirmDelivery);

async function releaseOfferAndReassign(db, orderRef, options = {}) {
  const {
    expectedCaptainId = "",
    expectedOfferId = "",
    reason = "expired",
    allowLegacyOffer = false,
    system = false
  } = options;

  let released = false;
  let latestOrderData = null;
  let updatedExcludedIds = [];

  await db.runTransaction(async (transaction) => {
    const orderDoc = await transaction.get(orderRef);
    if (!orderDoc.exists) throw new Error("الطلب غير موجود");

    const data = orderDoc.data() || {};
    const status = String(data.status || "").trim().toLowerCase();
    const offeredCaptainId = String(data.offeredCaptainId || "").trim();
    const currentOfferId = String(data.offerId || "").trim();
    const expiresAt = Number(data.offerExpiresAt || 0);
    const nowMs = Date.now();

    if (!offeredCaptainId) return;
    if (expectedCaptainId && offeredCaptainId !== expectedCaptainId) return;
    if (expectedOfferId && currentOfferId !== expectedOfferId) return;
    if (!currentOfferId && !allowLegacyOffer) {
      throw new Error("معرف العرض غير موجود أو انتهت صلاحية هذا العرض القديم");
    }
    if (!["pending", "offered"].includes(status)) return;

    const assignedCaptain = String(data.captainId || data.driverId || "").trim();
    if (assignedCaptain && assignedCaptain !== offeredCaptainId) return;

    if (reason === "expired" && (!Number.isFinite(expiresAt) || expiresAt <= 0 || expiresAt > nowMs)) {
      if (!system) throw new Error("لم تنتهِ مهلة قبول العرض بعد");
      return;
    }
    if (reason !== "expired" && reason !== "declined") {
      throw new Error("سبب إنهاء العرض غير صالح");
    }

    const lockRef = db.collection("captain_order_locks").doc(offeredCaptainId);
    const lockDoc = await transaction.get(lockRef);
    let shouldDeleteLock = false;
    if (lockDoc.exists) {
      const lockData = lockDoc.data() || {};
      const sameLock = String(lockData.orderId || "") === orderRef.id &&
        String(lockData.offerId || "") === currentOfferId;
      if (!sameLock) return;
      shouldDeleteLock = true;
    }

    const excluded = Array.isArray(data.excludedCaptainIds) ? [...data.excludedCaptainIds] : [];
    if (!excluded.includes(offeredCaptainId)) excluded.push(offeredCaptainId);

    latestOrderData = data;
    updatedExcludedIds = excluded;

    transaction.update(orderRef, {
      status: "searching",
      dispatchStatus: "searching",
      captainId: null,
      driverId: null,
      captainName: admin.firestore.FieldValue.delete(),
      offeredCaptainId: null,
      offerId: null,
      offerExpiresAt: null,
      excludedCaptainIds: excluded,
      lastOfferClosedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastOfferCloseReason: reason,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    if (shouldDeleteLock) transaction.delete(lockRef);
    released = true;
  });

  if (!released || !latestOrderData) {
    return {
      released: false,
      reassigned: false,
      offeredCaptainId: null,
      offerId: null,
      distanceKm: null
    };
  }

  const assignmentData = {
    ...latestOrderData,
    captainId: null,
    driverId: null,
    offeredCaptainId: null,
    offerId: null,
    offerExpiresAt: null,
    excludedCaptainIds: updatedExcludedIds
  };
  const assignment = await assignNearestCaptainInternal(
    db,
    orderRef,
    assignmentData,
    updatedExcludedIds
  );

  return {
    released: true,
    reassigned: Boolean(assignment.assigned),
    offeredCaptainId: assignment.offeredCaptainId || null,
    offerId: assignment.offerId || null,
    distanceKm: assignment.distanceKm || null,
    offerExpiresAt: assignment.offerExpiresAt || null
  };
}

// ------------------------------------------------------------------------------
// 7. Cloud Function: expireDeliveryOffer
// Captains may decline immediately or report expiry only after the server deadline.
// Scheduled processing uses the same transaction helper.
// ------------------------------------------------------------------------------
exports.expireDeliveryOffer = onRequest(
  { cors: true, timeoutSeconds: 30, memory: "256MiB" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    const user = await authenticateCaptain(req, res);
    if (!user) return;

    const orderId = String(req.body?.orderId || "").trim();
    const offerId = String(req.body?.offerId || "").trim();
    const reason = String(req.body?.reason || "expired").trim().toLowerCase();
    if (!orderId || !offerId) {
      return res.status(400).json({ error: "معرف الطلب ومعرف العرض مطلوبان لإنهاء العرض" });
    }
    if (!["expired", "declined"].includes(reason)) {
      return res.status(400).json({ error: "سبب إنهاء العرض غير صالح" });
    }

    const db = admin.firestore();
    const orderRef = await resolveOrderReference(db, orderId);
    if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

    try {
      const result = await releaseOfferAndReassign(db, orderRef, {
        expectedCaptainId: user.uid,
        expectedOfferId: offerId,
        reason,
        system: false
      });

      return res.status(200).json({
        success: true,
        released: result.released,
        reassigned: result.reassigned,
        offeredCaptainId: result.offeredCaptainId,
        offerId: result.offerId,
        distanceKm: result.distanceKm,
        message: result.released
          ? (result.reassigned ? "تم إنهاء العرض وإرساله إلى كابتن آخر" : "انتهى العرض ويستمر النظام في البحث عن كابتن")
          : "هذا العرض لم يعد نشطاً أو تمت معالجته بالفعل"
      });
    } catch (err) {
      const statusCode = /لم تنتهِ مهلة|معرف العرض|غير صالح/.test(err.message) ? 409 : 400;
      return res.status(statusCode).json({ error: err.message });
    }
  }
);

function generateUniqueSixDigitOrderCode() {
  const digits = [];
  digits.push(String(crypto.randomInt(1, 10)));
  while (digits.length < 6) {
    const candidate = String(crypto.randomInt(0, 10));
    if (!digits.includes(candidate)) digits.push(candidate);
  }
  return digits.join("");
}

function parseSubscriptionDateMs(value, isEndDate = false) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 100000000000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const raw = value.trim();
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    const parsed = Date.parse(dateOnly && isEndDate ? `${raw}T23:59:59.999Z` : raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function loadOrderableMerchantAndSubscription(db, merchantId) {
  const [merchantSnap, subscriptionSnap] = await Promise.all([
    db.collection("merchants").doc(merchantId).get(),
    db.collection("subscriptions").doc(merchantId).get()
  ]);

  if (!merchantSnap.exists) throw new Error("التاجر غير موجود في قاعدة البيانات");
  const merchantData = merchantSnap.data() || {};
  const merchantStatus = String(merchantData.status || "").trim().toLowerCase();
  if (
    merchantData.isActive === false ||
    (merchantStatus && !["approved", "active", "نشط", "معتمد"].includes(merchantStatus))
  ) {
    throw new Error("حساب التاجر غير نشط أو غير معتمد");
  }

  const subscriptionData = subscriptionSnap.exists ? (subscriptionSnap.data() || {}) : {};
  const nestedSubscription = merchantData.subscription && typeof merchantData.subscription === "object"
    ? merchantData.subscription
    : {};
  const nestedRecord = subscriptionData.subscription && typeof subscriptionData.subscription === "object"
    ? subscriptionData.subscription
    : {};

  const status = String(
    subscriptionData.status ||
    subscriptionData.subscriptionStatus ||
    nestedRecord.status ||
    merchantData.subscriptionStatus ||
    nestedSubscription.status ||
    ""
  ).trim().toLowerCase();

  if (!["active", "نشط", "ساري"].includes(status)) {
    throw new Error("اشتراك التاجر غير نشط؛ لا يمكن إنشاء طلب جديد");
  }

  const endDateValue =
    subscriptionData.endDate ||
    subscriptionData.subscriptionEndDate ||
    subscriptionData.expiresAt ||
    nestedRecord.endDate ||
    nestedRecord.expiresAt ||
    merchantData.subscriptionEndDate ||
    merchantData.endDate ||
    merchantData.expiresAt ||
    nestedSubscription.endDate ||
    nestedSubscription.expiresAt;
  const endDateMs = parseSubscriptionDateMs(endDateValue, true);
  if (endDateMs > 0 && endDateMs < Date.now()) {
    throw new Error("انتهى اشتراك التاجر؛ يرجى تجديد الاشتراك");
  }

  const planText = String(
    subscriptionData.plan || subscriptionData.subscriptionPlan ||
    nestedRecord.plan || merchantData.subscriptionPlan ||
    nestedSubscription.plan || ""
  );
  let maxCaptains = Number(
    subscriptionData.captainsCount ??
    subscriptionData.maxCaptains ??
    subscriptionData.allowedCaptains ??
    nestedRecord.captainsCount ??
    merchantData.captainsCount ??
    merchantData.maxCaptains ??
    nestedSubscription.captainsCount ??
    0
  );
  if (!maxCaptains) {
    const match = planText.match(/\b(2|4|6|8)\b/);
    maxCaptains = match ? Number(match[1]) : 0;
  }
  if (![2, 4, 6, 8].includes(maxCaptains)) {
    throw new Error("باقة التاجر غير محددة بشكل صحيح؛ يجب أن تكون 2 أو 4 أو 6 أو 8 كباتن");
  }

  return { merchantData, subscriptionData, maxCaptains };
}

function isTerminalOrderStatus(status) {
  return ["delivered", "completed", "cancelled", "canceled", "merchant_cancelled", "rejected", "declined"].includes(
    String(status || "").trim().toLowerCase()
  );
}

async function countActiveMerchantOrders(db, merchantId) {
  const [merchantQuery, restaurantQuery] = await Promise.all([
    db.collection("orders").where("merchantId", "==", merchantId).limit(1000).get(),
    db.collection("orders").where("restaurantId", "==", merchantId).limit(1000).get()
  ]);
  const byId = new Map();
  merchantQuery.docs.forEach(doc => byId.set(doc.id, doc));
  restaurantQuery.docs.forEach(doc => byId.set(doc.id, doc));
  return Array.from(byId.values()).filter(doc => !isTerminalOrderStatus((doc.data() || {}).status)).length;
}

// ------------------------------------------------------------------------------
// 8. Cloud Function: createOrder
// Admin dashboard creates the order on the server, validates subscription limits,
// reserves a unique six-digit order code, and starts server-side captain dispatch.
// ------------------------------------------------------------------------------
exports.createOrder = onRequest(
  { cors: true, timeoutSeconds: 60, memory: "512MiB" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    const user = await authenticateUser(req, res);
    if (!user) return;

    const db = admin.firestore();
    if (!(await isAdminUser(db, user))) {
      return res.status(403).json({ error: "غير مصرح: إنشاء الطلبات من لوحة الإدارة يتطلب صلاحية مدير" });
    }

    const body = req.body || {};
    const merchantId = String(body.restaurantId || body.merchantId || "").trim();
    if (!merchantId) return res.status(400).json({ error: "معرف التاجر مطلوب" });

    const customerName = String(body.customerName || "").trim().slice(0, 150);
    const customerPhone = String(body.customerPhone || "").trim().slice(0, 32);
    const deliveryAddress = String(body.deliveryAddress || "").trim().slice(0, 1000);
    if (!customerName || !customerPhone || !deliveryAddress) {
      return res.status(400).json({ error: "اسم العميل ورقم الهاتف وعنوان التوصيل مطلوبة" });
    }

    const deliveryFee = Number(body.deliveryFee ?? 0);
    const subtotal = Number(body.subtotal ?? 0);
    const total = Number(body.total ?? (subtotal + deliveryFee));
    if (
      !Number.isFinite(deliveryFee) || deliveryFee < 0 || deliveryFee > 10000 ||
      !Number.isFinite(subtotal) || subtotal < 0 || subtotal > 1000000 ||
      !Number.isFinite(total) || total < deliveryFee || total < subtotal || total > 1000000
    ) {
      return res.status(400).json({ error: "قيم المبالغ المالية غير صحيحة" });
    }

    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length > 50) return res.status(400).json({ error: "عدد عناصر الطلب يتجاوز الحد المسموح" });
    const items = [];
    for (const raw of rawItems) {
      const name = String(raw?.name || "").trim().slice(0, 150);
      const quantity = Number(raw?.quantity ?? 0);
      const price = Number(raw?.price ?? 0);
      if (!name || !Number.isInteger(quantity) || quantity <= 0 || quantity > 100 ||
          !Number.isFinite(price) || price < 0 || price > 100000) {
        return res.status(400).json({ error: "أحد عناصر الطلب يحتوي على بيانات أو أسعار غير صحيحة" });
      }
      items.push({ name, quantity, price });
    }

    const preferredCaptainId = String(body.captainId || "").trim();
    const notes = String(body.notes || "").trim().slice(0, 1000);
    const idempotencyKey = String(body.idempotencyKey || "").trim();
    if (!idempotencyKey || idempotencyKey.length > 128) {
      return res.status(400).json({ error: "مفتاح منع تكرار الطلب مطلوب" });
    }

    try {
      const { merchantData, subscriptionData, maxCaptains } =
        await loadOrderableMerchantAndSubscription(db, merchantId);

      const activeOrdersBeforeCreate = await countActiveMerchantOrders(db, merchantId);
      const counterRef = db.collection("merchant_dispatch_counters").doc(merchantId);
      const orderRef = db.collection("orders").doc();
      const idempotencyId = crypto.createHash("sha256")
        .update(`${user.uid}:${idempotencyKey}`)
        .digest("hex");
      const idempotencyRef = db.collection("idempotency_keys").doc(idempotencyId);

      let orderCode = "";
      let orderNumber = "";
      let persistedOrderData = null;
      let reused = false;

      for (let attempt = 0; attempt < 12; attempt++) {
        const candidateCode = generateUniqueSixDigitOrderCode();
        const candidateOrderNumber = `#ELB-${candidateCode}`;
        const codeRef = db.collection("order_codes").doc(candidateCode);
        const nowMs = Date.now();

        try {
          await db.runTransaction(async (transaction) => {
            const [idempotencyDoc, codeDoc, counterDoc] = await Promise.all([
              transaction.get(idempotencyRef),
              transaction.get(codeRef),
              transaction.get(counterRef)
            ]);

            if (idempotencyDoc.exists) {
              const existingOrderId = String(idempotencyDoc.data()?.orderId || "").trim();
              if (!existingOrderId) throw new Error("IDEMPOTENCY_RECORD_INVALID");
              const existingOrderRef = db.collection("orders").doc(existingOrderId);
              const existingOrderDoc = await transaction.get(existingOrderRef);
              if (!existingOrderDoc.exists) throw new Error("IDEMPOTENCY_ORDER_MISSING");
              persistedOrderData = { id: existingOrderId, ...existingOrderDoc.data() };
              reused = true;
              return;
            }

            if (codeDoc.exists) throw new Error("UNIQUE_ORDER_CODE_COLLISION");

            const counterData = counterDoc.exists ? (counterDoc.data() || {}) : {};
            const activeCount = counterDoc.exists
              ? Math.max(Number(counterData.activeCount || 0), activeOrdersBeforeCreate)
              : activeOrdersBeforeCreate;
            if (activeCount >= maxCaptains) {
              throw new Error(`وصل التاجر إلى الحد الأقصى للطلبات النشطة في باقة ${maxCaptains} كباتن`);
            }

            const merchantName = String(
              merchantData.name || merchantData.nameAr || merchantData.merchantName || merchantData.restaurantName || "تاجر مسجل"
            ).trim();
            const merchantLocationUrl = String(
              merchantData.mapUrl || merchantData.googleMapsUrl || merchantData.locationUrl || merchantData.storeLocationUrl || ""
            ).trim();
            const orderData = {
              orderNumber: candidateOrderNumber,
              orderCode: candidateCode,
              order_code: candidateCode,
              order_codes: candidateCode,
              orderCodeId: candidateCode,
              merchantId,
              restaurantId: merchantId,
              merchantName,
              restaurantName: merchantName,
              merchantMapUrl: merchantLocationUrl,
              pickupAddress: String(merchantData.address || merchantData.locationAddress || "").trim(),
              deliveryAddress,
              customerName,
              customerPhone,
              captainId: null,
              driverId: null,
              captainName: "",
              offeredCaptainId: null,
              preferredCaptainId: preferredCaptainId || null,
              offerId: null,
              offerExpiresAt: null,
              nearestDistanceKm: null,
              dispatchStatus: "searching",
              status: "searching",
              excludedCaptainIds: [],
              deliveryFee,
              delivery_fee: deliveryFee,
              deliveryPrice: deliveryFee,
              fee: deliveryFee,
              subtotal,
              total,
              notes,
              items,
              dispatchedBy: "admin",
              createdBy: user.uid,
              source: "admin_dashboard",
              merchantSubscriptionId: subscriptionData.id || merchantId,
              merchantMaxCaptains: maxCaptains,
              createdAt: admin.firestore.Timestamp.fromMillis(nowMs),
              updatedAt: admin.firestore.Timestamp.fromMillis(nowMs)
            };

            transaction.create(orderRef, orderData);
            transaction.create(codeRef, {
              orderId: orderRef.id,
              merchantId,
              orderCode: candidateCode,
              createdAt: admin.firestore.Timestamp.fromMillis(nowMs)
            });
            transaction.create(idempotencyRef, {
              actorUid: user.uid,
              merchantId,
              orderId: orderRef.id,
              createdAt: admin.firestore.Timestamp.fromMillis(nowMs)
            });
            transaction.set(counterRef, {
              merchantId,
              activeCount: activeCount + 1,
              maxCaptains,
              updatedAt: admin.firestore.Timestamp.fromMillis(nowMs)
            }, { merge: true });

            persistedOrderData = { id: orderRef.id, ...orderData };
            orderCode = candidateCode;
            orderNumber = candidateOrderNumber;
          });

          if (reused) {
            orderCode = String(persistedOrderData.orderCode || "");
            orderNumber = String(persistedOrderData.orderNumber || "");
          }
          break;
        } catch (error) {
          if (error.message === "UNIQUE_ORDER_CODE_COLLISION") continue;
          throw error;
        }
      }

      if (!persistedOrderData) throw new Error("تعذر إنشاء رقم طلب فريد بعد عدة محاولات");

      let dispatchResult = null;
      const existingStatus = String(persistedOrderData.status || "").trim().toLowerCase();
      if (
        ["searching", "pending", "new", "offered"].includes(existingStatus) &&
        !persistedOrderData.offeredCaptainId
      ) {
        try {
          dispatchResult = await assignNearestCaptainInternal(
            db,
            db.collection("orders").doc(persistedOrderData.id),
            persistedOrderData
          );
        } catch (dispatchError) {
          console.error("createOrder dispatch deferred:", persistedOrderData.id, dispatchError);
        }
      }

      return res.status(200).json({
        success: true,
        reused,
        orderId: persistedOrderData.id,
        orderNumber,
        orderCode,
        merchantId,
        merchantName: persistedOrderData.merchantName,
        assigned: Boolean(dispatchResult?.assigned || persistedOrderData.offeredCaptainId),
        offeredCaptainId: dispatchResult?.offeredCaptainId || persistedOrderData.offeredCaptainId || null,
        offerId: dispatchResult?.offerId || persistedOrderData.offerId || null,
        offerExpiresAt: dispatchResult?.offerExpiresAt || persistedOrderData.offerExpiresAt || null,
        distanceKm: dispatchResult?.distanceKm || persistedOrderData.nearestDistanceKm || null,
        message: dispatchResult?.assigned
          ? "تم إنشاء الطلب وإرسال عرضه إلى الكابتن"
          : "تم إنشاء الطلب؛ وسيستمر السيرفر في البحث عن كابتن مؤهل"
      });
    } catch (error) {
      const statusCode = /الحد الأقصى|اشتراك|انتهى اشتراك|باقة التاجر|التاجر غير موجود|غير نشط/.test(error.message) ? 409 : 400;
      console.warn("createOrder rejected:", error.message);
      return res.status(statusCode).json({ error: error.message || "تعذر إنشاء الطلب" });
    }
  }
);

// ------------------------------------------------------------------------------
// 9. Cloud Function: assignNextAvailableCaptain



// ------------------------------------------------------------------------------
// 8. Cloud Function: assignNextAvailableCaptain
// Selects the nearest online, active, non-busy, in-shift captain to the merchant
// ------------------------------------------------------------------------------
exports.assignNextAvailableCaptain = onRequest(
  { cors: true, timeoutSeconds: 30, memory: "256MiB" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const user = await authenticateUser(req, res);
    if (!user) return;

    const orderId = String(req.body?.orderId || "").trim();
    const requestedCaptainId = String(req.body?.captainId || "").trim();
    if (!orderId) return res.status(400).json({ error: "معرف الطلب مطلوب" });

    const db = admin.firestore();
    const orderRef = await resolveOrderReference(db, orderId);
    if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

    try {
      const orderDoc = await orderRef.get();
      if (!orderDoc.exists) return res.status(404).json({ error: "الطلب غير موجود" });
      const orderData = orderDoc.data() || {};

      if (!(await isAdminOrOrderMerchant(db, user, orderData))) {
        return res.status(403).json({ error: "غير مصرح: لا يمكنك توزيع هذا الطلب" });
      }

      const currentStatus = String(orderData.status || "").trim().toLowerCase();
      const offeredCaptainId = String(orderData.offeredCaptainId || "").trim();
      const offerExpiresAt = Number(orderData.offerExpiresAt || 0);
      const assignedCaptainId = String(orderData.captainId || orderData.driverId || "").trim();

      if (offeredCaptainId && offerExpiresAt > Date.now()) {
        return res.status(409).json({ error: "يوجد عرض نشط لهذا الطلب. انتظر انتهاء المهلة أو إنهاء العرض من الكابتن." });
      }
      if (assignedCaptainId && !offeredCaptainId) {
        return res.status(409).json({ error: "الطلب مسند بالفعل ولا يمكن إعادة توزيعه بهذه العملية" });
      }
      if (!["new", "pending", "searching", "offered", "ready", "ready_for_pickup", "waiting_driver"].includes(currentStatus)) {
        return res.status(409).json({ error: "حالة الطلب الحالية لا تسمح بالتوزيع" });
      }

      const excluded = Array.isArray(orderData.excludedCaptainIds) ? orderData.excludedCaptainIds : [];
      const assignmentData = requestedCaptainId
        ? { ...orderData, preferredCaptainId: requestedCaptainId }
        : { ...orderData, preferredCaptainId: "" };

      const assignResult = await assignNearestCaptainInternal(db, orderRef, assignmentData, excluded);

      if (assignResult.assigned) {
        const captainSnapshot = assignResult.offeredCaptainId
          ? await db.collection("captains").doc(assignResult.offeredCaptainId).get()
          : null;
        const captainData = captainSnapshot?.exists ? (captainSnapshot.data() || {}) : {};
        return res.status(200).json({
          success: true,
          assigned: true,
          message: requestedCaptainId
            ? "تم إرسال عرض الطلب إلى الكابتن المحدد"
            : "تم إرسال عرض الطلب إلى أقرب كابتن متاح",
          offeredCaptainId: assignResult.offeredCaptainId,
          captainName: String(captainData.name || captainData.driver_name || captainData.fullName || "كابتن معتمد"),
          offerId: assignResult.offerId || null,
          distanceKm: assignResult.distanceKm,
          offerExpiresAt: assignResult.offerExpiresAt || null,
          expiresInSeconds: 60
        });
      }

      return res.status(200).json({
        success: true,
        assigned: false,
        message: requestedCaptainId
          ? "الكابتن المحدد غير مؤهل حالياً؛ تم إبقاء الطلب في حالة البحث"
          : "لا يوجد كباتن مؤهلون حالياً، وسيستمر النظام في البحث"
      });
    } catch (err) {
      console.error("assignNextAvailableCaptain failed:", err);
      return res.status(500).json({ error: "تعذر توزيع الطلب حالياً" });
    }
  }
);

// ------------------------------------------------------------------------------
// 10. Cloud Function: uploadImageToImgBB
// ------------------------------------------------------------------------------
exports.uploadImageToImgBB = onRequest(
  {
    cors: false,
    timeoutSeconds: 60,
    memory: "256MiB",
    secrets: ["IMGBB_API_KEY"]
  },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const user = await authenticateCaptain(req, res);
    if (!user) return;

    const bb = busboy({ headers: req.headers });
    let fileBuffer = null;
    let fileName = "upload.jpg";

    bb.on("file", (name, file, info) => {
      fileName = info.filename || "upload.jpg";
      const chunks = [];
      file.on("data", (data) => chunks.push(data));
      file.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    bb.on("finish", async () => {
      if (!fileBuffer || fileBuffer.length === 0) {
        return res.status(400).json({ error: "لم يتم استلام أي بيانات صورة" });
      }

      try {
        const apiKey = process.env.IMGBB_API_KEY;
        if (!apiKey) {
          return res.status(500).json({ error: "خطأ في تهيئة الخادم" });
        }

        const formData = new FormData();
        formData.append("key", apiKey);
        formData.append("image", fileBuffer, { filename: fileName, contentType: "image/jpeg" });

        const imgbbResponse = await axios.post("https://api.imgbb.com/1/upload", formData, {
          headers: formData.getHeaders(),
          timeout: 45000,
        });

        if (imgbbResponse.data && imgbbResponse.data.data && imgbbResponse.data.data.url) {
          return res.status(200).json({
            success: true,
            url: imgbbResponse.data.data.url,
            display_url: imgbbResponse.data.data.display_url
          });
        } else {
          return res.status(502).json({ error: "فشل استلام الرابط من مزود الصور" });
        }
      } catch (uploadError) {
        return res.status(502).json({
          error: "تعذر رفع الصورة، يرجى المحاولة مرة أخرى",
          details: uploadError?.response?.data?.error?.message || uploadError.message
        });
      }
    });

    req.pipe(bb);
  }
);

// ------------------------------------------------------------------------------
// 10. Cloud Function: updateFcmToken
// ------------------------------------------------------------------------------
exports.updateFcmToken = onRequest(
  { cors: true, timeoutSeconds: 30, memory: "256MiB" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    const user = await authenticateCaptain(req, res);
    if (!user) return;

    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "رمز FCM مطلوب" });

    const db = admin.firestore();
    try {
      await db.collection("captains").doc(user.uid).update({
        fcmToken: token,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.status(200).json({ success: true, message: "تم تحديث رمز الإشعارات بنجاح" });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
);

// ------------------------------------------------------------------------------
// 11. Firestore Trigger: onOrderCreatedNotifyCaptains
// Sends instant high-priority FCM push notifications (even when app is closed)
// strictly to online captains inside an active Cairo shift.
// ------------------------------------------------------------------------------
const NOTIFIABLE_NEW_ORDER_STATUSES = new Set([
  "pending", "new", "offered", "searching", "ready", "ready_for_pickup", "waiting_driver"
]);

const NON_NEW_LIFECYCLE_STATUSES = new Set([
  "accepted", "assigned", "at_store", "arrived_at_merchant", "picked_up",
  "order_data_entered", "awaiting_merchant_confirmation", "merchant_rejected",
  "en_route", "confirmed", "merchant_confirmed", "approved", "delivered", "completed"
]);

exports.onOrderCreatedNotifyCaptains = onDocumentWritten("orders/{orderId}", async (event) => {
  const afterSnap = event.data && event.data.after;
  if (!afterSnap || !afterSnap.exists) return;

  const afterData = afterSnap.data() || {};
  const beforeData = (event.data.before && event.data.before.exists) ? (event.data.before.data() || {}) : null;

  if (afterData.merchantConfirmed === true) return;

  const afterStatus = String(afterData.status || "").trim().toLowerCase();
  if (!NOTIFIABLE_NEW_ORDER_STATUSES.has(afterStatus)) return;

  const assignedCaptain = String(
    afterData.captainId || afterData.driverId || afterData.assignedCaptainId || afterData.captainUid || ""
  ).trim();
  if (assignedCaptain && assignedCaptain.toLowerCase() !== "null") return;

  const beforeStatus = beforeData ? String(beforeData.status || "").trim().toLowerCase() : "";
  if (beforeData && NON_NEW_LIFECYCLE_STATUSES.has(beforeStatus)) return;

  const afterOffered = String(afterData.offeredCaptainId || "").trim();
  const beforeOffered = beforeData ? String(beforeData.offeredCaptainId || "").trim() : "";

  const isNewlyPending = !beforeData || !NOTIFIABLE_NEW_ORDER_STATUSES.has(beforeStatus);
  const isNewlyOffered = Boolean(afterOffered) && afterOffered !== beforeOffered;
  if (!isNewlyPending && !isNewlyOffered) return;

  const db = admin.firestore();
  const orderId = event.params.orderId;

  if (afterOffered) {
    // Skip duplicate FCM if assignNearestCaptainInternal already dispatched this offer window
    const expectedNotifyKey = `${afterOffered}_${Number(afterData.offerExpiresAt || 0)}`;
    if (afterData.lastOfferedNotifyKey === expectedNotifyKey) return;

    const capDoc = await db.collection("captains").doc(afterOffered).get();
    if (capDoc.exists) {
      await sendNewOrderFcmToCaptain(db, capDoc.id, capDoc.data(), orderId, afterData);
    }
    return;
  }

  // Unassigned new order: route exclusively to the nearest eligible captain to the merchant
  // with a 60-second offer deadline.
  await assignNearestCaptainInternal(db, afterSnap.ref, afterData);
});

// ------------------------------------------------------------------------------
// 12. Scheduled Trigger: scheduledShiftBoundaryNotifications
// Sends FCM shift_start & shift_end push notifications in Africa/Cairo timezone
// as server-side backup even if device Doze delays local AlarmManager.
// ------------------------------------------------------------------------------
exports.scheduledShiftBoundaryNotifications = onSchedule(
  { schedule: "every 1 minutes", timeZone: "Africa/Cairo", memory: "256MiB" },
  async () => {
    const db = admin.firestore();
    const { dayOfWeek: todayDay, currentMinutes, dateKey } = getCairoNowInfo();
    const yesterdayDay = todayDay === 1 ? 7 : todayDay - 1;

    const captainsSnap = await db.collection("captains").limit(200).get();
    for (const doc of captainsSnap.docs) {
      const cData = doc.data() || {};
      if (cData.isLoggedIn === false) continue;
      const fcmToken = String(cData.fcmToken || cData.fcm_token || cData.messagingToken || "").trim();
      if (!fcmToken) continue;

      const shifts = await collectCaptainShifts(db, doc.id, cData);
      if (shifts.length === 0) continue;

      const todayShift = shifts.find(s => s.dayOfWeek === todayDay && !s.isDayOff);
      const yesterdayShift = shifts.find(s => s.dayOfWeek === yesterdayDay && !s.isDayOff);

      // Shift Start check (today's shift starts at currentMinutes)
      if (todayShift && todayShift.startMin === currentMinutes) {
        const startFmt = formatMinutesArabicBackend(todayShift.startMin);
        const endFmt = formatMinutesArabicBackend(todayShift.endMin);
        const dayArabic = ARABIC_DAYS_MAP[todayShift.dayOfWeek] || "اليوم";
        const dedupeKey = `${dateKey}_${todayShift.dayOfWeek}_start`;
        try {
          await admin.messaging().send({
            token: fcmToken,
            android: {
              priority: "high",
              notification: {
                channelId: "el_batal_shift_alerts_channel",
                sound: "default",
                title: "بدأ شفت عملك الآن",
                body: `بدأ شفت عملك (${dayArabic}) من ${startFmt} إلى ${endFmt}. يمكنك الآن استقبال الطلبات.`
              }
            },
            data: {
              type: "shift_start",
              dayNameArabic: dayArabic,
              startFormatted: startFmt,
              endFormatted: endFmt,
              dedupeKey
            }
          });
        } catch (err) {
          console.warn("shift_start FCM error:", doc.id, err.message);
        }
      }

      // Shift End check: same-day shift ending now OR yesterday's overnight shift ending now
      const endingShift = (todayShift && todayShift.endMin >= todayShift.startMin && todayShift.endMin === currentMinutes)
        ? todayShift
        : (yesterdayShift && yesterdayShift.endMin < yesterdayShift.startMin && yesterdayShift.endMin === currentMinutes)
          ? yesterdayShift
          : null;

      if (endingShift) {
        const endFmt = formatMinutesArabicBackend(endingShift.endMin);
        const dayArabic = ARABIC_DAYS_MAP[endingShift.dayOfWeek] || "اليوم";
        const dedupeKey = `${dateKey}_${endingShift.dayOfWeek}_end`;
        try {
          await admin.messaging().send({
            token: fcmToken,
            android: {
              priority: "high",
              notification: {
                channelId: "el_batal_shift_alerts_channel",
                sound: "default",
                title: "انتهى شفت عملك اليوم",
                body: `انتهى شفت عملك (${dayArabic}) الساعة ${endFmt}. تم إيقاف إسناد الطلبات الجديدة تلقائياً.`
              }
            },
            data: {
              type: "shift_end",
              dayNameArabic: dayArabic,
              endFormatted: endFmt,
              dedupeKey
            }
          });
        } catch (err) {
          console.warn("shift_end FCM error:", doc.id, err.message);
        }
      }
    }
  }
);

// ------------------------------------------------------------------------------
// 13. Scheduled Trigger: scheduledReassignExpiredOffers
// Uses the same transaction-safe expiry path as captain requests.
// ------------------------------------------------------------------------------
exports.scheduledReassignExpiredOffers = onSchedule(
  { schedule: "every 1 minutes", timeZone: "Africa/Cairo", memory: "256MiB" },
  async () => {
    const db = admin.firestore();
    const nowMs = Date.now();
    const pendingSnap = await db.collection("orders")
      .where("status", "in", ["pending", "offered", "searching"])
      .limit(200)
      .get();

    for (const doc of pendingSnap.docs) {
      const data = doc.data() || {};
      const status = String(data.status || "").trim().toLowerCase();
      const offeredCaptainId = String(data.offeredCaptainId || "").trim();
      const offerId = String(data.offerId || "").trim();
      const expiresAt = Number(data.offerExpiresAt || 0);
      const assignedCaptain = String(data.captainId || data.driverId || "").trim();

      try {
        if (offeredCaptainId && expiresAt > 0 && expiresAt <= nowMs) {
          await releaseOfferAndReassign(db, doc.ref, {
            expectedCaptainId: offeredCaptainId,
            expectedOfferId: offerId,
            reason: "expired",
            allowLegacyOffer: !offerId,
            system: true
          });
          continue;
        }

        if (
          !offeredCaptainId &&
          !assignedCaptain &&
          !offerId &&
          ["searching", "pending", "offered"].includes(status)
        ) {
          await assignNearestCaptainInternal(db, doc.ref, data);
        }
      } catch (error) {
        console.warn("scheduledReassignExpiredOffers failed for order:", doc.id, error.message);
      }
    }
  }
);
