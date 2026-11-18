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
const { onTaskDispatched } = require("firebase-functions/v2/tasks");
const { getFunctions } = require("firebase-admin/functions");
const { randomUUID } = require("crypto");
const admin = require("firebase-admin");
const axios = require("axios");
const FormData = require("form-data");
const busboy = require("busboy");

if (!admin.apps.length) {
  admin.initializeApp();
}

// ------------------------------------------------------------------------------
// Helper: Authenticate Captain via Firebase Auth ID Token
// ------------------------------------------------------------------------------
async function authenticateCaptain(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "غير مصرح: يجب تسجيل الدخول أولاً" });
    return null;
  }
  const idToken = authHeader.split("Bearer ")[1];
  try {
    const decodedUser = await admin.auth().verifyIdToken(idToken);
    return decodedUser;
  } catch (error) {
    console.error("Token verification failed:", error);
    res.status(403).json({ error: "جلسة الكابتن منتهية الصلاحية، يرجى تسجيل الدخول مجدداً" });
    return null;
  }
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

const CAPTAIN_ACTIVE_ORDERS_COLLECTION = "captain_active_orders";
const OFFER_DURATION_MS = 60 * 1000;
const MAX_CAPTAIN_LOCATION_AGE_MS = 90 * 1000;

const OFFERABLE_ORDER_STATUSES = new Set([
  "pending", "searching", "offered", "new", "ready", "ready_for_pickup", "waiting_driver"
]);

function timestampToMillisBackend(value) {
  if (value === null || value === undefined) return 0;
  try {
    if (typeof value.toMillis === "function") return value.toMillis();
    if (typeof value.toDate === "function") return value.toDate().getTime();
    if (value instanceof Date) return value.getTime();
  } catch (_) {
    return 0;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function hasFreshCaptainLocation(captainData, nowMs = Date.now()) {
  const rawTimestamp =
    captainData?.lastLocationUpdate ??
    captainData?.lastLocationTimestamp ??
    captainData?.lastUpdate;
  const updatedAtMs = timestampToMillisBackend(rawTimestamp);
  if (!updatedAtMs) return false;
  const ageMs = nowMs - updatedAtMs;
  return ageMs >= -30000 && ageMs <= MAX_CAPTAIN_LOCATION_AGE_MS;
}

function isCaptainLockBlocking(lockData, nowMs = Date.now()) {
  if (!lockData || !lockData.orderId) return false;
  const status = String(lockData.status || "").trim().toLowerCase();
  if (status === "released") return false;
  if (status === "offered" && timestampToMillisBackend(lockData.offerExpiresAt) <= nowMs) {
    return false;
  }
  return true;
}


function isCaptainOnlineAndActive(captainData) {
  if (!captainData) return false;
  if (captainData.accountType && String(captainData.accountType).trim().toLowerCase() !== "captain") return false;
  if (captainData.isOnline !== true) return false;
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
  const allShifts = [];

  if (captainData) {
    allShifts.push(...extractShiftListFromDocData(captainData));
  }

  for (const col of ["captain_schedules", "schedules"]) {
    try {
      const snap = await db.collection(col).doc(captainUid).get();
      if (snap.exists) {
        allShifts.push(...extractShiftListFromDocData(snap.data()));
      }
    } catch (_) {}
  }

  for (const field of ["captainId", "captainUid", "driverId"]) {
    try {
      const qs = await db.collection("shifts").where(field, "==", captainUid).get();
      qs.forEach(d => allShifts.push(...extractShiftListFromDocData(d.data())));
    } catch (_) {}
  }

  return allShifts;
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

async function findNearestEligibleCaptain(db, orderData, extraExcludedIds = []) {
  const excludedSet = new Set([
    ...(Array.isArray(orderData?.excludedCaptainIds) ? orderData.excludedCaptainIds : []),
    ...extraExcludedIds
  ].map(v => String(v || "").trim()).filter(Boolean));

  const captainsSnapshot = await db.collection("captains")
    .where("isOnline", "==", true)
    .limit(60)
    .get();

  if (captainsSnapshot.empty) return null;

  const merchantCoords = await extractMerchantCoordinates(db, orderData);
  if (!merchantCoords) {
    console.warn("Order dispatch skipped: merchant coordinates are missing or invalid", orderData?.id || "");
    return null;
  }

  const eligibleCandidates = [];
  const nowMs = Date.now();

  for (const doc of captainsSnapshot.docs) {
    if (excludedSet.has(doc.id)) continue;
    const cData = doc.data() || {};
    if (!isCaptainOnlineAndActive(cData)) continue;
    if (!hasFreshCaptainLocation(cData, nowMs)) continue;

    const capCoords = extractCaptainCoordinates(cData);
    if (!capCoords) continue;

    const lockSnap = await db.collection(CAPTAIN_ACTIVE_ORDERS_COLLECTION).doc(doc.id).get();
    if (lockSnap.exists && isCaptainLockBlocking(lockSnap.data(), nowMs)) continue;

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

  if (eligibleCandidates.length === 0) return null;
  eligibleCandidates.sort((a, b) => {
    if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    return a.doc.id.localeCompare(b.doc.id);
  });
  return eligibleCandidates[0];
}

async function sendNewOrderFcmToCaptain(db, captainId, captainData, orderId, orderData, customDistanceKm = null) {
  const fcmToken = String(
    captainData?.fcmToken || captainData?.fcm_token || captainData?.messagingToken || ""
  ).trim();
  if (!fcmToken) return false;
  if (captainData?.isLoggedIn === false) return false;
  if (!isCaptainOnlineAndActive(captainData)) return false;

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
        offerId: String(orderData?.offerId || ""),
        distanceKm: String(safeDistance),
        offeredCaptainId: String(captainId)
      }
    });
    return true;
  } catch (err) {
    console.warn("Failed to send new-order FCM to captain:", captainId, err.message);
    return false;
  }
}

async function enqueueOfferExpiryTask({ orderId, offerId, offeredCaptainId }) {
  const queue = getFunctions().taskQueue("expireDeliveryOfferTask");
  await queue.enqueue(
    { orderId, offerId, offeredCaptainId },
    { scheduleDelaySeconds: 60, dispatchDeadlineSeconds: 60 }
  );
}

async function assignNearestCaptainInternal(db, orderRef, orderData, extraExcludedIds = []) {
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) return { assigned: false, reason: "order-not-found" };

  const currentData = orderSnap.data() || {};
  const currentStatus = String(currentData.status || "").trim().toLowerCase();
  const assignedCaptain = String(currentData.captainId || currentData.driverId || "").trim();
  if (assignedCaptain && assignedCaptain.toLowerCase() !== "null") {
    return { assigned: false, alreadyAssigned: true };
  }

  const currentOfferedCaptain = String(currentData.offeredCaptainId || "").trim();
  const currentExpiry = timestampToMillisBackend(currentData.offerExpiresAt);
  if (currentOfferedCaptain && currentExpiry > Date.now()) {
    return {
      assigned: true,
      alreadyOffered: true,
      offeredCaptainId: currentOfferedCaptain,
      offerId: String(currentData.offerId || ""),
      offerExpiresAt: currentExpiry
    };
  }
  if (!OFFERABLE_ORDER_STATUSES.has(currentStatus)) {
    return { assigned: false, reason: "order-not-offerable" };
  }

  const excluded = new Set([
    ...(Array.isArray(currentData.excludedCaptainIds) ? currentData.excludedCaptainIds : []),
    ...extraExcludedIds
  ].map(value => String(value || "").trim()).filter(Boolean));
  if (currentOfferedCaptain && currentExpiry <= Date.now()) excluded.add(currentOfferedCaptain);

  const dispatchData = { ...orderData, ...currentData, excludedCaptainIds: Array.from(excluded) };
  const nearestCaptain = await findNearestEligibleCaptain(db, dispatchData, Array.from(excluded));

  if (!nearestCaptain) {
    await db.runTransaction(async (transaction) => {
      const latestSnap = await transaction.get(orderRef);
      if (!latestSnap.exists) return;
      const latest = latestSnap.data() || {};
      const latestAssigned = String(latest.captainId || latest.driverId || "").trim();
      const latestOffered = String(latest.offeredCaptainId || "").trim();
      const latestExpiry = timestampToMillisBackend(latest.offerExpiresAt);
      if (latestAssigned && latestAssigned.toLowerCase() !== "null") return;
      if (latestOffered && latestExpiry > Date.now()) return;
      transaction.update(orderRef, {
        status: "searching",
        offeredCaptainId: null,
        offerId: null,
        offerExpiresAt: null,
        excludedCaptainIds: Array.from(excluded),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    return { assigned: false, offeredCaptainId: null, offerId: null, distanceKm: null, offerExpiresAt: null };
  }

  const candidate = nearestCaptain.doc;
  const distanceKm = Number(nearestCaptain.distanceKm.toFixed(2));
  const offerId = randomUUID();
  const offerExpiresAt = Date.now() + OFFER_DURATION_MS;
  const notifyKey = candidate.id + "_" + offerId + "_" + offerExpiresAt;
  const captainLockRef = db.collection(CAPTAIN_ACTIVE_ORDERS_COLLECTION).doc(candidate.id);
  let committed = false;

  await db.runTransaction(async (transaction) => {
    const orderDoc = await transaction.get(orderRef);
    const lockDoc = await transaction.get(captainLockRef);
    if (!orderDoc.exists) return;

    const latest = orderDoc.data() || {};
    const latestStatus = String(latest.status || "").trim().toLowerCase();
    const latestAssigned = String(latest.captainId || latest.driverId || "").trim();
    const latestOffered = String(latest.offeredCaptainId || "").trim();
    const latestExpiry = timestampToMillisBackend(latest.offerExpiresAt);

    if (latestAssigned && latestAssigned.toLowerCase() !== "null") return;
    if (latestOffered && latestExpiry > Date.now()) return;
    if (!OFFERABLE_ORDER_STATUSES.has(latestStatus)) return;
    if (lockDoc.exists && isCaptainLockBlocking(lockDoc.data(), Date.now())) return;

    transaction.update(orderRef, {
      status: "pending",
      offeredCaptainId: candidate.id,
      offerId,
      offerExpiresAt,
      nearestDistanceKm: distanceKm,
      lastOfferedNotifyKey: notifyKey,
      excludedCaptainIds: Array.isArray(latest.excludedCaptainIds)
        ? latest.excludedCaptainIds
        : Array.from(excluded),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    transaction.set(captainLockRef, {
      orderId: orderRef.id,
      offerId,
      status: "offered",
      offerExpiresAt,
      offeredAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    committed = true;
  });

  if (!committed) {
    await db.runTransaction(async (transaction) => {
      const latestSnap = await transaction.get(orderRef);
      if (!latestSnap.exists) return;
      const latest = latestSnap.data() || {};
      const latestAssigned = String(latest.captainId || latest.driverId || "").trim();
      const latestOffered = String(latest.offeredCaptainId || "").trim();
      const latestExpiry = timestampToMillisBackend(latest.offerExpiresAt);
      if (latestAssigned && latestAssigned.toLowerCase() !== "null") return;
      if (latestOffered && latestExpiry > Date.now()) return;
      transaction.update(orderRef, {
        status: "searching",
        excludedCaptainIds: Array.from(excluded),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    return { assigned: false, reason: "candidate-reserved-concurrently" };
  }

  const offerPayload = { ...dispatchData, offerId, offerExpiresAt };
  try {
    await enqueueOfferExpiryTask({ orderId: orderRef.id, offerId, offeredCaptainId: candidate.id });
  } catch (taskError) {
    console.error("Failed to enqueue offer expiration task:", orderRef.id, offerId, taskError.message);
  }

  await sendNewOrderFcmToCaptain(
    db, candidate.id, candidate.data(), orderRef.id, offerPayload, distanceKm
  );

  return { assigned: true, offeredCaptainId: candidate.id, offerId, distanceKm, offerExpiresAt };
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

  const { orderId } = req.body || {};
  const requestedOfferId = String(req.body?.offerId || "").trim();
  if (!orderId) return res.status(400).json({ error: "معرف الطلب مطلوب" });

  const db = admin.firestore();
  const orderRef = await resolveOrderReference(db, orderId);
  if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

  const captainRef = db.collection("captains").doc(user.uid);
  const captainLockRef = db.collection(CAPTAIN_ACTIVE_ORDERS_COLLECTION).doc(user.uid);

  try {
    const captainDoc = await captainRef.get();
    const captainData = captainDoc.exists ? captainDoc.data() : null;
    if (!captainData || !isCaptainOnlineAndActive(captainData)) {
      return res.status(403).json({
        error: "لا يمكنك قبول أو استلام طلبات وأنت في وضع غير متصل أو حسابك غير مفعل ككابتن."
      });
    }

    const shiftCheck = await isCaptainInActiveShift(db, user.uid, captainData);
    if (!shiftCheck.active) {
      return res.status(403).json({
        error: "عفواً، أنت خارج ساعات العمل الرسمية ولا يمكنك قبول طلبات جديدة حالياً."
      });
    }

    const ongoingQuery = await db.collection("orders")
      .where("captainId", "==", user.uid)
      .where("status", "in", ONGOING_ORDER_STATUSES)
      .limit(1)
      .get();
    if (!ongoingQuery.empty && ongoingQuery.docs[0].id !== orderRef.id) {
      return res.status(409).json({
        error: "لديك طلب نشط بالفعل قيد التنفيذ، لا يمكن قبول أكثر من طلب في وقت واحد."
      });
    }

    let alreadyAccepted = false;
    let acceptedOfferId = "";

    await db.runTransaction(async (transaction) => {
      const orderDoc = await transaction.get(orderRef);
      const captainDocTx = await transaction.get(captainRef);
      const lockDoc = await transaction.get(captainLockRef);
      if (!orderDoc.exists) throw new Error("هذا الطلب لم يعد متاحاً");
      if (!captainDocTx.exists) throw new Error("حساب الكابتن غير موجود");

      const data = orderDoc.data() || {};
      const captainInTx = captainDocTx.data() || {};
      const currentStatus = String(data.status || "").trim().toLowerCase();
      const existingCaptain = String(data.captainId || data.driverId || "").trim();
      const offeredCaptainId = String(data.offeredCaptainId || "").trim();
      const currentOfferId = String(data.offerId || "").trim();
      const nowMs = Date.now();

      if (!isCaptainOnlineAndActive(captainInTx)) {
        throw new Error("حسابك غير متصل أو غير مفعل، لا يمكن قبول الطلب.");
      }

      const lockData = lockDoc.exists ? (lockDoc.data() || {}) : null;
      if (lockData && String(lockData.orderId || "") !== orderRef.id &&
          isCaptainLockBlocking(lockData, nowMs)) {
        throw new Error("لديك طلب أو عرض آخر محجوز بالفعل.");
      }

      if (existingCaptain && existingCaptain.toLowerCase() !== "null") {
        if (existingCaptain !== user.uid) throw new Error("تم استلام هذا الطلب بالفعل بواسطة كابتن آخر");
        if (ONGOING_ORDER_STATUSES.includes(currentStatus)) {
          alreadyAccepted = true;
          acceptedOfferId = currentOfferId;
          transaction.set(captainLockRef, {
            orderId: orderRef.id,
            offerId: currentOfferId,
            status: "accepted",
            offerExpiresAt: null,
            acceptedAt: data.acceptedAt || admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          return;
        }
      }

      if (offeredCaptainId !== user.uid) throw new Error("هذا العرض غير مخصص لحسابك.");
      if (currentOfferId && requestedOfferId && currentOfferId !== requestedOfferId) {
        throw new Error("معرف العرض غير صالح أو تم استبدال العرض بعرض أحدث.");
      }
      if (!currentOfferId && requestedOfferId) throw new Error("هذا العرض لم يعد صالحاً.");
      if (currentOfferId && !requestedOfferId) {
        console.warn("Legacy captain acceptance without offerId:", user.uid, orderRef.id);
      }

      const expiresAtMs = timestampToMillisBackend(data.offerExpiresAt);
      if (!expiresAtMs || nowMs > expiresAtMs) {
        throw new Error("انتهت مهلة قبول الطلب وتم تحويله إلى كابتن آخر");
      }
      if (!["pending", "offered", "searching", "new", "ready", "ready_for_pickup", "waiting_driver"].includes(currentStatus)) {
        throw new Error("هذا الطلب لم يعد متاحاً للقبول");
      }

      transaction.update(orderRef, {
        status: "accepted",
        captainId: user.uid,
        driverId: user.uid,
        acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      transaction.set(captainLockRef, {
        orderId: orderRef.id,
        offerId: currentOfferId,
        status: "accepted",
        offerExpiresAt: null,
        acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      acceptedOfferId = currentOfferId;
    });

    return res.status(200).json({
      success: true,
      message: alreadyAccepted ? "الطلب مسند إليك بالفعل." : "تم قبول الطلب بنجاح وإسناده إليك",
      orderId: orderRef.id,
      offerId: acceptedOfferId || null
    });
  } catch (err) {
    console.warn("acceptDeliveryOffer error:", err.message);
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

  try {
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(orderRef);
      if (!doc.exists) throw new Error("الطلب غير موجود");
      const data = doc.data();
      if (data.captainId !== user.uid && data.driverId !== user.uid) {
        throw new Error("غير مصرح: هذا الطلب ليس مسنداً إليك");
      }
      transaction.update(orderRef, {
        status: "arrived_at_merchant",
        arrivedAtStoreTimestamp: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    return res.status(200).json({ success: true, message: "تم تسجيل الوصول إلى التاجر بنجاح" });
  } catch (err) {
    return res.status(400).json({ error: err.message });
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

    try {
      await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(orderRef);
        if (!doc.exists) throw new Error("الطلب غير موجود");
        const data = doc.data();
        if (data.captainId !== user.uid && data.driverId !== user.uid) {
          throw new Error("غير مصرح: هذا الطلب ليس مسنداً إليك");
        }
        transaction.update(orderRef, {
          status: "picked_up",
          pickedUpAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      return res.status(200).json({ success: true, message: "تم استلام الطلب من التاجر بنجاح" });
    } catch (err) {
      return res.status(400).json({ error: err.message });
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

  const { orderId, customerName, customerPhone, receiptImageUrl, notes } = req.body || {};
  if (!orderId) return res.status(400).json({ error: "معرف الطلب مطلوب" });
  if (!receiptImageUrl) return res.status(400).json({ error: "صورة الإيصال مطلوبة" });

  const db = admin.firestore();
  const orderRef = await resolveOrderReference(db, orderId);

  try {
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(orderRef);
      if (!doc.exists) throw new Error("الطلب غير موجود");
      const data = doc.data();
      if (data.captainId !== user.uid && data.driverId !== user.uid) {
        throw new Error("غير مصرح: هذا الطلب ليس مسنداً إليك");
      }
      transaction.update(orderRef, {
        customerName: customerName || data.customerName || "",
        customerPhone: customerPhone || data.customerPhone || "",
        receiptImageUrl: receiptImageUrl,
        notes: notes || data.notes || "",
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
    return res.status(400).json({ error: err.message });
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
    const { orderId, confirmed, approved, status, rejectionReason } = req.body || {};
    if (!orderId) return res.status(400).json({ error: "معرف الطلب مطلوب" });

    const normalizedReqStatus = String(status || "").trim().toLowerCase();
    const isConfirmed = confirmed === true ||
      confirmed === "true" ||
      approved === true ||
      ["confirmed", "merchant_confirmed", "approved", "en_route"].includes(normalizedReqStatus);

    const db = admin.firestore();
    const orderRef = await resolveOrderReference(db, orderId);

    try {
      let assignedCaptainId = "";
      await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(orderRef);
        if (!doc.exists) throw new Error("الطلب غير موجود");
        const docData = doc.data() || {};
        assignedCaptainId = String(
          docData.captainId || docData.driverId || docData.assignedCaptainId || docData.captainUid || ""
        ).trim();

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
            rejectionReason: rejectionReason || "بيانات الإيصال أو العميل غير مطابقة",
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
      return res.status(400).json({ error: err.message });
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

  const { orderId } = req.body || {};
  if (!orderId) return res.status(400).json({ error: "معرف الطلب مطلوب" });

  const db = admin.firestore();
  const orderRef = await resolveOrderReference(db, orderId);
  if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

  const cleanId = String(orderId).trim().replace(/^#+/, "");
  const captainRef = db.collection("captains").doc(user.uid);
  const captainLockRef = db.collection(CAPTAIN_ACTIVE_ORDERS_COLLECTION).doc(user.uid);
  const canonicalTransactionRef = captainRef.collection("transactions").doc(orderRef.id);
  const legacyTransactionRef = captainRef.collection("transactions").doc(cleanId);

  try {
    let earnedDeliveryFee = 25.0;
    let alreadyCredited = false;

    await db.runTransaction(async (transaction) => {
      const orderDoc = await transaction.get(orderRef);
      const captainDoc = await transaction.get(captainRef);
      const lockDoc = await transaction.get(captainLockRef);
      const canonicalRecordDoc = await transaction.get(canonicalTransactionRef);
      const legacyRecordDoc = legacyTransactionRef.path === canonicalTransactionRef.path
        ? canonicalRecordDoc
        : await transaction.get(legacyTransactionRef);

      if (!orderDoc.exists) throw new Error("الطلب غير موجود");
      if (!captainDoc.exists) throw new Error("حساب الكابتن غير موجود");
      const orderData = orderDoc.data() || {};

      const existingRecord = canonicalRecordDoc.exists
        ? canonicalRecordDoc
        : (legacyRecordDoc.exists ? legacyRecordDoc : null);

      if (existingRecord) {
        const recordData = existingRecord.data() || {};
        const savedAmount = Number(recordData.amount);
        earnedDeliveryFee = Number.isFinite(savedAmount) && savedAmount > 0
          ? savedAmount
          : (Number(orderData.deliveryFee) > 0 ? Number(orderData.deliveryFee) : 25.0);
        alreadyCredited = true;

        const status = String(orderData.status || "").trim().toLowerCase();
        if (status !== "delivered" && status !== "completed") {
          transaction.update(orderRef, {
            status: "delivered",
            deliveredAt: orderData.deliveredAt || admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
        if (lockDoc.exists && String(lockDoc.data()?.orderId || "") === orderRef.id) {
          transaction.delete(captainLockRef);
        }
        return;
      }

      if (orderData.captainId !== user.uid && orderData.driverId !== user.uid) {
        throw new Error("غير مصرح: هذا الطلب ليس مسنداً إليك");
      }
      const currentStatus = String(orderData.status || "").trim().toLowerCase();
      if (["cancelled", "canceled", "ملغي"].includes(currentStatus)) {
        throw new Error("لا يمكن إتمام طلب ملغي.");
      }
      if (typeof orderData.deliveryFee === "number" && orderData.deliveryFee > 0) {
        earnedDeliveryFee = orderData.deliveryFee;
      }

      transaction.update(orderRef, {
        status: "delivered",
        deliveredAt: orderData.deliveredAt || admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      transaction.update(captainRef, {
        walletBalance: admin.firestore.FieldValue.increment(earnedDeliveryFee),
        totalOrdersCount: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      transaction.create(canonicalTransactionRef, {
        amount: earnedDeliveryFee,
        type: "delivery_earning",
        orderId: orderRef.id,
        description: "أرباح توصيل الطلب رقم #" + String(orderData.orderNumber || orderRef.id),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      if (lockDoc.exists && String(lockDoc.data()?.orderId || "") === orderRef.id) {
        transaction.delete(captainLockRef);
      }
    });

    return res.status(200).json({
      success: true,
      message: alreadyCredited
        ? "تم تسجيل أرباح هذا الطلب مسبقاً."
        : "تم تسليم الطلب بنجاح وإضافة الأرباح لمحفظتك",
      earnedAmount: earnedDeliveryFee,
      alreadyCredited
    });
  } catch (err) {
    console.error("confirmDelivery error:", err.message);
    return res.status(400).json({ error: err.message });
  }
}

exports.confirmDelivery = onRequest({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, handleConfirmDelivery);
exports.completeDelivery = onRequest({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, handleConfirmDelivery);

async function expireOfferAndReassign(db, orderRef, options = {}) {
  const expectedOfferId = String(options.expectedOfferId || "").trim();
  const expectedCaptainId = String(options.expectedCaptainId || "").trim();
  const actorUid = String(options.actorUid || "").trim();
  const force = options.force === true;

  let resultState = "stale";
  let updatedOrderData = null;
  let updatedExcluded = [];

  await db.runTransaction(async (transaction) => {
    const orderDoc = await transaction.get(orderRef);
    if (!orderDoc.exists) {
      resultState = "not-found";
      return;
    }

    const data = orderDoc.data() || {};
    const assignedCaptain = String(data.captainId || data.driverId || "").trim();
    if (assignedCaptain && assignedCaptain.toLowerCase() !== "null") {
      resultState = "already-assigned";
      return;
    }

    const status = String(data.status || "").trim().toLowerCase();
    if (!OFFERABLE_ORDER_STATUSES.has(status)) {
      resultState = "not-offerable";
      return;
    }

    const offeredCaptainId = String(data.offeredCaptainId || "").trim();
    const currentOfferId = String(data.offerId || "").trim();
    if (!offeredCaptainId) {
      resultState = "no-current-offer";
      return;
    }
    if (actorUid && offeredCaptainId !== actorUid) {
      resultState = "forbidden";
      return;
    }
    if (expectedCaptainId && offeredCaptainId !== expectedCaptainId) {
      resultState = "stale";
      return;
    }
    if (expectedOfferId && currentOfferId !== expectedOfferId) {
      resultState = "stale";
      return;
    }

    const expiresAtMs = timestampToMillisBackend(data.offerExpiresAt);
    if (!force && expiresAtMs > Date.now()) {
      resultState = "not-due";
      return;
    }

    const captainLockRef = db.collection(CAPTAIN_ACTIVE_ORDERS_COLLECTION).doc(offeredCaptainId);
    const lockDoc = await transaction.get(captainLockRef);
    const excluded = Array.isArray(data.excludedCaptainIds) ? [...data.excludedCaptainIds] : [];
    if (!excluded.includes(offeredCaptainId)) excluded.push(offeredCaptainId);
    updatedExcluded = excluded;

    transaction.update(orderRef, {
      status: "searching",
      offeredCaptainId: null,
      offerId: null,
      offerExpiresAt: null,
      excludedCaptainIds: excluded,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    if (lockDoc.exists) {
      const lockData = lockDoc.data() || {};
      const lockOrderId = String(lockData.orderId || "");
      const lockOfferId = String(lockData.offerId || "");
      if (lockOrderId === orderRef.id &&
          (!currentOfferId || !lockOfferId || lockOfferId === currentOfferId)) {
        transaction.delete(captainLockRef);
      }
    }

    updatedOrderData = { ...data, excludedCaptainIds: excluded };
    resultState = "expired";
  });

  if (resultState !== "expired") {
    return { state: resultState, reassigned: false };
  }

  const assignment = await assignNearestCaptainInternal(db, orderRef, updatedOrderData, updatedExcluded);
  return { state: "expired", reassigned: Boolean(assignment?.assigned), assignResult: assignment };
}

// ------------------------------------------------------------------------------
// 7. Cloud Function: expireDeliveryOffer
// Authenticated decline or expiry hint. The server clock decides when expiry is valid.
// ------------------------------------------------------------------------------
exports.expireDeliveryOffer = onRequest(
  { cors: true, timeoutSeconds: 30, memory: "256MiB" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    const user = await authenticateCaptain(req, res);
    if (!user) return;

    const { orderId } = req.body || {};
    const reason = String(req.body?.reason || "expired").trim().toLowerCase();
    const offerId = String(req.body?.offerId || "").trim();
    if (!orderId) return res.status(400).json({ error: "معرف الطلب مطلوب" });
    if (!["expired", "declined"].includes(reason)) {
      return res.status(400).json({ error: "سبب انتهاء العرض غير صالح" });
    }

    const db = admin.firestore();
    const orderRef = await resolveOrderReference(db, orderId);
    if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

    try {
      const result = await expireOfferAndReassign(db, orderRef, {
        expectedOfferId: offerId,
        expectedCaptainId: user.uid,
        actorUid: user.uid,
        force: reason === "declined"
      });
      if (result.state === "forbidden") {
        return res.status(403).json({ error: "هذا العرض غير مخصص لحسابك." });
      }
      if (result.state === "not-due") {
        return res.status(409).json({ error: "لم تنتهِ مهلة العرض بعد حسب توقيت الخادم." });
      }
      if (result.state === "not-found") {
        return res.status(404).json({ error: "الطلب غير موجود" });
      }

      return res.status(200).json({
        success: true,
        message: result.state === "expired"
          ? "تم إنهاء العرض وإعادة توزيع الطلب من الخادم."
          : "العرض لم يعد نشطاً، ولم يتم تغيير الإسناد.",
        reassigned: Boolean(result.reassigned),
        offeredCaptainId: result.assignResult?.offeredCaptainId || null,
        offerId: result.assignResult?.offerId || null
      });
    } catch (err) {
      console.error("expireDeliveryOffer error:", err.message);
      return res.status(500).json({ error: "تعذر إنهاء العرض حالياً، حاول مرة أخرى." });
    }
  }
);

exports.expireDeliveryOfferTask = onTaskDispatched(
  {
    region: "us-central1",
    timeoutSeconds: 60,
    memory: "256MiB",
    retryConfig: {
      maxAttempts: 5,
      minBackoffSeconds: 5,
      maxBackoffSeconds: 60,
      maxDoublings: 3
    },
    rateLimits: { maxConcurrentDispatches: 50 }
  },
  async (request) => {
    const payload = request.data || {};
    const orderId = String(payload.orderId || "").trim();
    const offerId = String(payload.offerId || "").trim();
    const offeredCaptainId = String(payload.offeredCaptainId || "").trim();
    if (!orderId || !offerId || !offeredCaptainId) {
      throw new Error("Invalid offer expiration task payload.");
    }

    const db = admin.firestore();
    const orderRef = db.collection("orders").doc(orderId);
    const result = await expireOfferAndReassign(db, orderRef, {
      expectedOfferId: offerId,
      expectedCaptainId: offeredCaptainId,
      force: false
    });

    if (result.state === "not-due") {
      await getFunctions().taskQueue("expireDeliveryOfferTask").enqueue(
        { orderId, offerId, offeredCaptainId },
        { scheduleDelaySeconds: 3, dispatchDeadlineSeconds: 60 }
      );
    }
  }
);

// ------------------------------------------------------------------------------
// 8. Cloud Function: assignNextAvailableCaptain
// Kept for compatibility, but it requires the currently offered captain's auth.
// ------------------------------------------------------------------------------
exports.assignNextAvailableCaptain = onRequest(
  { cors: true, timeoutSeconds: 30, memory: "256MiB" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    const user = await authenticateCaptain(req, res);
    if (!user) return;

    const { orderId } = req.body || {};
    const offerId = String(req.body?.offerId || "").trim();
    if (!orderId) return res.status(400).json({ error: "معرف الطلب مطلوب" });

    const db = admin.firestore();
    const orderRef = await resolveOrderReference(db, orderId);
    if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

    try {
      const result = await expireOfferAndReassign(db, orderRef, {
        expectedOfferId: offerId,
        expectedCaptainId: user.uid,
        actorUid: user.uid,
        force: false
      });
      if (result.state === "forbidden") {
        return res.status(403).json({ error: "هذا العرض غير مخصص لحسابك." });
      }
      if (result.state === "not-due") {
        return res.status(409).json({ error: "لم تنتهِ مهلة العرض بعد حسب توقيت الخادم." });
      }
      if (result.state === "not-found") {
        return res.status(404).json({ error: "الطلب غير موجود" });
      }
      return res.status(200).json({
        success: true,
        message: "تمت مراجعة العرض بواسطة الخادم.",
        reassigned: Boolean(result.reassigned),
        offeredCaptainId: result.assignResult?.offeredCaptainId || null
      });
    } catch (err) {
      console.error("assignNextAvailableCaptain error:", err.message);
      return res.status(500).json({ error: "تعذر إعادة توزيع الطلب حالياً." });
    }
  }
);

// ------------------------------------------------------------------------------
// 9. Cloud Function: uploadImageToImgBB
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
    const expectedNotifyKey = `${afterOffered}_${String(afterData.offerId || "")}_${Number(afterData.offerExpiresAt || 0)}`;
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

const TERMINAL_ORDER_STATUSES = new Set([
  "cancelled", "canceled", "delivered", "completed", "ملغي", "تم التوصيل"
]);

exports.releaseCaptainActiveOrderLockOnTerminalOrder = onDocumentWritten(
  "orders/{orderId}",
  async (event) => {
    const afterSnap = event.data?.after;
    const beforeSnap = event.data?.before;
    const afterData = afterSnap?.exists ? (afterSnap.data() || {}) : null;
    const beforeData = beforeSnap?.exists ? (beforeSnap.data() || {}) : null;

    const status = afterData
      ? String(afterData.status || "").trim().toLowerCase()
      : "deleted";
    if (afterData && !TERMINAL_ORDER_STATUSES.has(status)) return;

    const captainUid = String(
      afterData?.captainId ||
      afterData?.driverId ||
      afterData?.offeredCaptainId ||
      beforeData?.captainId ||
      beforeData?.driverId ||
      beforeData?.offeredCaptainId ||
      ""
    ).trim();
    if (!captainUid || captainUid.toLowerCase() === "null") return;

    const terminalOfferId = String(afterData?.offerId || beforeData?.offerId || "").trim();
    const orderId = String(event.params.orderId || "");
    const lockRef = admin.firestore().collection(CAPTAIN_ACTIVE_ORDERS_COLLECTION).doc(captainUid);

    await admin.firestore().runTransaction(async (transaction) => {
      const lockDoc = await transaction.get(lockRef);
      if (!lockDoc.exists) return;
      const lockData = lockDoc.data() || {};
      if (String(lockData.orderId || "") !== orderId) return;
      const lockOfferId = String(lockData.offerId || "").trim();
      if (terminalOfferId && lockOfferId && terminalOfferId !== lockOfferId) return;
      transaction.delete(lockRef);
    });
  }
);

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
// Automatically reassigns any order whose 60s offer deadline expired without acceptance
// (e.g., if captain's phone was offline) to the nearest eligible captain to the merchant.
// ------------------------------------------------------------------------------
// ------------------------------------------------------------------------------
// 13. Scheduled Trigger: scheduledReassignExpiredOffers
// Recovery path if Cloud Tasks enqueue/dispatch fails.
// ------------------------------------------------------------------------------
exports.scheduledReassignExpiredOffers = onSchedule(
  { schedule: "every 1 minutes", timeZone: "Africa/Cairo", memory: "256MiB" },
  async () => {
    const db = admin.firestore();
    const nowMs = Date.now();
    const pendingSnap = await db.collection("orders")
      .where("status", "in", [
        "pending", "offered", "searching", "new", "New", "ready", "Ready", "ready_for_pickup", "waiting_driver"
      ])
      .limit(100)
      .get();

    for (const doc of pendingSnap.docs) {
      try {
        const data = doc.data() || {};
        const assigned = String(data.captainId || data.driverId || "").trim();
        if (assigned && assigned.toLowerCase() !== "null") continue;

        const offeredCaptainId = String(data.offeredCaptainId || "").trim();
        const offerId = String(data.offerId || "").trim();
        const expiresAt = timestampToMillisBackend(data.offerExpiresAt);
        if (offeredCaptainId && expiresAt > nowMs) continue;

        if (offeredCaptainId) {
          await expireOfferAndReassign(db, doc.ref, {
            expectedOfferId: offerId,
            expectedCaptainId: offeredCaptainId,
            force: false
          });
        } else {
          await assignNearestCaptainInternal(db, doc.ref, data, data.excludedCaptainIds || []);
        }
      } catch (err) {
        console.error("scheduledReassignExpiredOffers failed for order:", doc.id, err.message);
      }
    }
  }
);

