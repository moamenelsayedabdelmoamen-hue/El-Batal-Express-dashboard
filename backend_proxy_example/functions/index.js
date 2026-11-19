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
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "غير مصرح: يجب تسجيل الدخول أولاً" });
    return null;
  }

  const idToken = authHeader.slice("Bearer ".length).trim();
  if (!idToken) {
    res.status(401).json({ error: "رمز الدخول غير موجود" });
    return null;
  }

  try {
    return await admin.auth().verifyIdToken(idToken, true);
  } catch (error) {
    console.error("Token verification failed:", error?.message || error);
    res.status(401).json({ error: "جلسة الدخول غير صالحة أو منتهية، يرجى تسجيل الدخول مجدداً" });
    return null;
  }
}

async function authenticateCaptain(req, res) {
  const user = await authenticateUser(req, res);
  if (!user) return null;

  try {
    const snap = await admin.firestore().collection("captains").doc(user.uid).get();
    if (!snap.exists) {
      res.status(403).json({ error: "هذا الحساب غير مسجل ككابتن" });
      return null;
    }

    const data = snap.data() || {};
    const accountType = String(data.accountType || data.role || "").trim().toLowerCase();
    if (accountType && accountType !== "captain") {
      res.status(403).json({ error: "نوع الحساب لا يسمح بتنفيذ عملية الكابتن" });
      return null;
    }

    const status = String(data.status || "active").trim().toLowerCase();
    if (INACTIVE_ACCOUNT_STATUSES.has(status) || data.isApproved === false) {
      res.status(403).json({ error: "حساب الكابتن غير مفعل أو موقوف" });
      return null;
    }

    return user;
  } catch (error) {
    console.error("Captain profile verification failed:", error?.message || error);
    res.status(503).json({ error: "تعذر التحقق من حساب الكابتن حالياً" });
    return null;
  }
}

async function isAdminIdentity(user, db) {
  if (!user) return false;

  const claimAdmin = user.admin === true || String(user.role || "").toLowerCase() === "admin";
  const email = String(user.email || "").trim().toLowerCase();
  const allowlistedEmail = user.email_verified === true &&
    ["moamen.elsayed.abdelmoamen@gmail.com", "admin@elbatalexpress.com"].includes(email);

  let adminDocExists = false;
  try {
    const snap = await db.collection("admins").doc(user.uid).get();
    if (snap.exists) {
      const data = snap.data() || {};
      const status = String(data.status || "active").toLowerCase();
      adminDocExists = data.isActive !== false && !["disabled", "suspended", "inactive"].includes(status);
    }
  } catch (error) {
    console.error("Admin profile lookup failed:", error?.message || error);
  }

  return (claimAdmin || allowlistedEmail || adminDocExists);
}

async function authenticateAdmin(req, res, db) {
  const user = await authenticateUser(req, res);
  if (!user) return null;
  if (!(await isAdminIdentity(user, db))) {
    res.status(403).json({ error: "هذه العملية متاحة لمدير النظام فقط" });
    return null;
  }
  return user;
}

async function authenticateOrderManager(req, res, db, orderData) {
  const user = await authenticateUser(req, res);
  if (!user) return null;

  if (await isAdminIdentity(user, db)) {
    return { user, role: "admin" };
  }

  if (user.email_verified !== true) {
    res.status(403).json({ error: "يجب تأكيد البريد الإلكتروني قبل تنفيذ العملية" });
    return null;
  }

  const merchantOwners = [
    orderData?.merchantOwnerId, orderData?.merchantUid, orderData?.merchantId,
    orderData?.storeId, orderData?.vendorId, orderData?.ownerId, orderData?.userId
  ].map(value => String(value || "").trim()).filter(Boolean);

  if (!merchantOwners.includes(user.uid)) {
    res.status(403).json({ error: "غير مصرح: هذا الطلب لا يخص متجرك" });
    return null;
  }

  try {
    const merchantSnap = await db.collection("merchants").doc(user.uid).get();
    if (!merchantSnap.exists) {
      res.status(403).json({ error: "حساب التاجر غير موجود" });
      return null;
    }

    const merchant = merchantSnap.data() || {};
    const accountType = String(merchant.accountType || "").trim().toLowerCase();
    const status = String(merchant.status || "").trim().toLowerCase();
    if (accountType !== "merchant" || !["approved", "active"].includes(status)) {
      res.status(403).json({ error: "حساب التاجر غير معتمد أو غير نشط" });
      return null;
    }

    return { user, role: "merchant" };
  } catch (error) {
    console.error("Merchant profile verification failed:", error?.message || error);
    res.status(503).json({ error: "تعذر التحقق من حساب التاجر حالياً" });
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

function isCaptainOnlineAndActive(captainData) {
  if (!captainData) return false;
  if (captainData.accountType && String(captainData.accountType).trim().toLowerCase() !== "captain") return false;
  if (captainData.isOnline !== true) return false;
  if (captainData.canReceiveOrders === false) return false;
  if (["offline", "disabled", "unavailable"].includes(String(captainData.presenceStatus || "").trim().toLowerCase())) return false;
  const statusStr = String(captainData.status || "active").trim().toLowerCase();
  if (INACTIVE_ACCOUNT_STATUSES.has(statusStr)) return false;
  if (captainData.isApproved === false) return false;
  return true;
}

function timestampToMillis(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 100000000000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return timestampToMillis(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isCaptainLocationFresh(captainData, nowMs = Date.now()) {
  const candidates = [
    captainData?.lastLocationTimestamp,
    captainData?.lastLocationUpdate,
    captainData?.locationUpdatedAt,
    captainData?.currentLocation?.timestamp,
    captainData?.currentLocation?.updatedAt,
    captainData?.location?.timestamp,
    captainData?.location?.updatedAt
  ];
  const timestamp = candidates.map(timestampToMillis).find(value => value > 0) || 0;
  if (!timestamp || timestamp > nowMs + 30000 || nowMs - timestamp > 60000) return false;

  const accuracy = Number(captainData?.accuracy);
  if (Number.isFinite(accuracy) && accuracy > 250) return false;

  return Boolean(extractCaptainCoordinates(captainData));
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

async function findNearestEligibleCaptain(db, orderData, extraExcludedIds = [], requestedCaptainId = "") {
  const excludedSet = new Set([
    ...(Array.isArray(orderData?.excludedCaptainIds) ? orderData.excludedCaptainIds : []),
    ...extraExcludedIds
  ].map(v => String(v || "").trim()).filter(Boolean));

  const selectedId = String(requestedCaptainId || "").trim();
  let captainDocs = [];

  if (selectedId) {
    const selectedSnap = await db.collection("captains").doc(selectedId).get();
    if (selectedSnap.exists) captainDocs = [selectedSnap];
  } else {
    const captainsSnapshot = await db.collection("captains")
      .where("isOnline", "==", true)
      .limit(60)
      .get();
    captainDocs = captainsSnapshot.docs;
  }

  if (captainDocs.length === 0) return [];

  const merchantCoords = await extractMerchantCoordinates(db, orderData);
  if (!merchantCoords) return [];

  const eligibleCandidates = [];
  const nowMs = Date.now();

  for (const doc of captainDocs) {
    if (excludedSet.has(doc.id)) continue;

    const cData = doc.data() || {};
    if (!isCaptainOnlineAndActive(cData)) continue;
    if (!isCaptainLocationFresh(cData, nowMs)) continue;

    const lockSnap = await db.collection("captain_order_locks").doc(doc.id).get();
    if (lockSnap.exists) {
      const lock = lockSnap.data() || {};
      const lockExpiry = Number(lock.expiresAt || 0);
      const lockIsActive = lock.state === "accepted" || (lock.state === "offered" && lockExpiry > nowMs);
      if (lockIsActive) continue;
    }

    const [captainOrders, driverOrders] = await Promise.all([
      db.collection("orders")
        .where("captainId", "==", doc.id)
        .where("status", "in", ONGOING_ORDER_STATUSES)
        .limit(1)
        .get(),
      db.collection("orders")
        .where("driverId", "==", doc.id)
        .where("status", "in", ONGOING_ORDER_STATUSES)
        .limit(1)
        .get()
    ]);
    if (!captainOrders.empty || !driverOrders.empty) continue;

    const shiftCheck = await isCaptainInActiveShift(db, doc.id, cData);
    if (!shiftCheck.active) continue;

    const capCoords = extractCaptainCoordinates(cData);
    if (!capCoords) continue;

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

async function sendNewOrderFcmToCaptain(db, captainId, captainData, orderId, orderData, customDistanceKm = null, offerId = "") {
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
  const driverOngoingSnap = await db.collection("orders")
    .where("driverId", "==", captainId)
    .where("status", "in", ONGOING_ORDER_STATUSES)
    .limit(1)
    .get();
  if (!ongoingSnap.empty || !driverOngoingSnap.empty) return false;

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
    : (Number.isFinite(Number(orderData?.distanceKm)) ? Number(orderData.distanceKm) : "");

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
        offerId: String(offerId || orderData?.offerId || "")
      }
    });
    return true;
  } catch (err) {
    console.warn("Failed to send new-order FCM to captain:", captainId, err.message);
    return false;
  }
}

async function assignNearestCaptainInternal(
  db,
  orderRef,
  orderData,
  extraExcludedIds = [],
  requestedCaptainId = ""
) {
  const candidates = await findNearestEligibleCaptain(
    db, orderData, extraExcludedIds, requestedCaptainId
  );

  for (const candidate of candidates) {
    const captainId = candidate.doc.id;
    const captainRef = db.collection("captains").doc(captainId);
    const lockRef = db.collection("captain_order_locks").doc(captainId);
    const activeOrdersQuery = db.collection("orders")
      .where("captainId", "==", captainId)
      .where("status", "in", ONGOING_ORDER_STATUSES)
      .limit(2);
    const activeDriverOrdersQuery = db.collection("orders")
      .where("driverId", "==", captainId)
      .where("status", "in", ONGOING_ORDER_STATUSES)
      .limit(2);

    const offerId = crypto.randomUUID();
    const offerExpiresAt = Date.now() + 60000;
    const distanceKm = Number(candidate.distanceKm.toFixed(2));
    const notifyKey = `${captainId}_${offerId}`;

    const reservation = await db.runTransaction(async (transaction) => {
      const [orderSnap, captainSnap, lockSnap, activeOrders, activeDriverOrders] = await Promise.all([
        transaction.get(orderRef),
        transaction.get(captainRef),
        transaction.get(lockRef),
        transaction.get(activeOrdersQuery),
        transaction.get(activeDriverOrdersQuery)
      ]);

      if (!orderSnap.exists) return { reserved: false, reason: "order_missing" };

      const currentOrder = orderSnap.data() || {};
      const assignedCaptain = String(currentOrder.captainId || currentOrder.driverId || "").trim();
      if (assignedCaptain) return { reserved: false, reason: "already_assigned" };

      const status = String(currentOrder.status || "").trim().toLowerCase();
      if (!["pending", "searching", "new", "offered", "ready", "ready_for_pickup", "waiting_driver"].includes(status)) {
        return { reserved: false, reason: "invalid_order_status" };
      }

      const currentOfferedCaptain = String(currentOrder.offeredCaptainId || "").trim();
      const currentExpiry = Number(currentOrder.offerExpiresAt || 0);
      let previousOfferLockRef = null;
      let previousOfferLockSnap = null;

      if (currentOfferedCaptain && currentExpiry > Date.now()) {
        if (!requestedCaptainId || currentOfferedCaptain === captainId) {
          return { reserved: false, reason: "active_offer_exists" };
        }
        previousOfferLockRef = db.collection("captain_order_locks").doc(currentOfferedCaptain);
        previousOfferLockSnap = await transaction.get(previousOfferLockRef);
        if (previousOfferLockSnap.exists) {
          const previousLock = previousOfferLockSnap.data() || {};
          if (previousLock.state === "accepted") {
            return { reserved: false, reason: "previous_offer_accepted" };
          }
        }
      }

      if (!captainSnap.exists) return { reserved: false, reason: "captain_missing" };
      const currentCaptain = captainSnap.data() || {};
      if (!isCaptainOnlineAndActive(currentCaptain) || !isCaptainLocationFresh(currentCaptain)) {
        return { reserved: false, reason: "captain_not_eligible" };
      }

      const shift = await isCaptainInActiveShift(db, captainId, currentCaptain);
      if (!shift.active) return { reserved: false, reason: "captain_outside_shift" };

      const busyOrder = [...activeOrders.docs, ...activeDriverOrders.docs]
        .find(doc => doc.id !== orderRef.id);
      if (busyOrder) return { reserved: false, reason: "captain_has_active_order" };

      if (lockSnap.exists) {
        const lock = lockSnap.data() || {};
        const lockExpiry = Number(lock.expiresAt || 0);
        const lockActive = lock.state === "accepted" || (lock.state === "offered" && lockExpiry > Date.now());
        if (lockActive && lock.orderId !== orderRef.id) {
          return { reserved: false, reason: "captain_locked" };
        }
      }

      if (previousOfferLockSnap?.exists && previousOfferLockRef) {
        const previousLock = previousOfferLockSnap.data() || {};
        if (previousLock.orderId === orderRef.id && previousLock.state === "offered") {
          transaction.delete(previousOfferLockRef);
        }
      }

      transaction.set(lockRef, {
        orderId: orderRef.id,
        offerId,
        state: "offered",
        expiresAt: offerExpiresAt,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      transaction.update(orderRef, {
        status: "pending",
        dispatchStatus: "offered",
        offeredCaptainId: captainId,
        offeredCaptainName: String(currentCaptain.driver_name || currentCaptain.name || currentCaptain.fullName || currentCaptain.displayName || ""),
        offerId,
        offerExpiresAt,
        nearestDistanceKm: distanceKm,
        lastOfferedNotifyKey: notifyKey,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return { reserved: true, captainData: currentCaptain };
    });

    if (!reservation.reserved) {
      if (reservation.reason === "already_assigned" || reservation.reason === "active_offer_exists" || reservation.reason === "previous_offer_accepted" || reservation.reason === "invalid_order_status" || reservation.reason === "order_missing") {
        return {
          assigned: false,
          offeredCaptainId: null,
          reason: reservation.reason,
          distanceKm: null,
          offerExpiresAt: null
        };
      }
      continue;
    }

    await sendNewOrderFcmToCaptain(
      db,
      captainId,
      reservation.captainData,
      orderRef.id,
      { ...orderData, offerId, offerExpiresAt },
      distanceKm,
      offerId
    );

    return {
      assigned: true,
      offeredCaptainId: captainId,
      offeredCaptainName: String(
        reservation.captainData.driver_name ||
        reservation.captainData.name ||
        reservation.captainData.fullName ||
        reservation.captainData.displayName ||
        ""
      ),
      offerId,
      distanceKm,
      offerExpiresAt
    };
  }

  let currentState = "searching";
  await db.runTransaction(async (transaction) => {
    const orderSnap = await transaction.get(orderRef);
    if (!orderSnap.exists) return;
    const current = orderSnap.data() || {};
    if (current.captainId || current.driverId) {
      currentState = "already_assigned";
      return;
    }
    if (current.offeredCaptainId && Number(current.offerExpiresAt || 0) > Date.now()) {
      currentState = "active_offer_exists";
      return;
    }
    transaction.update(orderRef, {
      status: "searching",
      dispatchStatus: "searching",
      offeredCaptainId: null,
      offeredCaptainName: null,
      offerId: admin.firestore.FieldValue.delete(),
      offerExpiresAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return {
    assigned: false,
    offeredCaptainId: null,
    reason: currentState === "searching" ? "no_eligible_captain" : currentState,
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

  const { orderId, offerId } = req.body || {};
  if (!orderId || !offerId) {
    return res.status(400).json({ error: "معرف الطلب ومعرف العرض مطلوبان لقبول الطلب" });
  }

  const db = admin.firestore();
  const orderRef = await resolveOrderReference(db, orderId);
  if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

  const captainRef = db.collection("captains").doc(user.uid);
  const lockRef = db.collection("captain_order_locks").doc(user.uid);
  const activeOrdersQuery = db.collection("orders")
    .where("captainId", "==", user.uid)
    .where("status", "in", ONGOING_ORDER_STATUSES)
    .limit(2);
  const activeDriverOrdersQuery = db.collection("orders")
    .where("driverId", "==", user.uid)
    .where("status", "in", ONGOING_ORDER_STATUSES)
    .limit(2);

  try {
    const captainSnapshot = await captainRef.get();
    const captainData = captainSnapshot.exists ? captainSnapshot.data() : null;
    if (!captainData || !isCaptainOnlineAndActive(captainData)) {
      return res.status(403).json({ error: "حساب الكابتن غير متصل أو غير مؤهل لاستلام الطلبات" });
    }
    if (!isCaptainLocationFresh(captainData)) {
      return res.status(403).json({ error: "موقعك غير محدث. فعّل خدمة الموقع وحاول مرة أخرى" });
    }

    const shiftCheck = await isCaptainInActiveShift(db, user.uid, captainData);
    if (!shiftCheck.active) {
      return res.status(403).json({ error: shiftCheck.reason || "أنت خارج ساعات الشفت الحالية" });
    }

    const outcome = await db.runTransaction(async (transaction) => {
      const [orderDoc, captainDoc, lockDoc, activeOrders, activeDriverOrders] = await Promise.all([
        transaction.get(orderRef),
        transaction.get(captainRef),
        transaction.get(lockRef),
        transaction.get(activeOrdersQuery),
        transaction.get(activeDriverOrdersQuery)
      ]);

      if (!orderDoc.exists) throw new Error("الطلب غير موجود");
      const data = orderDoc.data() || {};
      const currentStatus = String(data.status || "").trim().toLowerCase();
      const existingCaptain = String(data.captainId || data.driverId || "").trim();

      if (existingCaptain === user.uid &&
          ["accepted", "assigned", "arrived_at_merchant", "at_store", "picked_up", "en_route", "delivering"].includes(currentStatus) &&
          String(data.acceptedOfferId || data.offerId || "") === String(offerId)) {
        return { alreadyAccepted: true };
      }

      if (existingCaptain) throw new Error("تم إسناد الطلب بالفعل إلى كابتن آخر");
      if (String(data.offeredCaptainId || "") !== user.uid) {
        throw new Error("هذا العرض غير موجه إلى حسابك");
      }
      if (String(data.offerId || "") !== String(offerId)) {
        throw new Error("معرف العرض غير مطابق أو تم استبدال العرض");
      }

      const expiresAt = Number(data.offerExpiresAt || 0);
      const nowMs = Date.now();
      if (!expiresAt || expiresAt <= nowMs) {
        throw new Error("انتهت مهلة قبول العرض");
      }
      if (!["pending", "offered"].includes(currentStatus)) {
        throw new Error("حالة الطلب لا تسمح بالقبول");
      }

      if (!captainDoc.exists || !isCaptainOnlineAndActive(captainDoc.data() || {}) ||
          !isCaptainLocationFresh(captainDoc.data() || {})) {
        throw new Error("حساب الكابتن أو موقعه لم يعد مؤهلاً لقبول الطلب");
      }

      const lock = lockDoc.exists ? (lockDoc.data() || {}) : null;
      if (!lock || lock.orderId !== orderRef.id || lock.offerId !== offerId || lock.state !== "offered") {
        throw new Error("حجز العرض غير صالح أو تم تحريره");
      }

      const busyOrder = [...activeOrders.docs, ...activeDriverOrders.docs]
        .find(doc => doc.id !== orderRef.id);
      if (busyOrder) throw new Error("لديك طلب نشط بالفعل ولا يمكن قبول طلب آخر");

      transaction.update(orderRef, {
        status: "accepted",
        dispatchStatus: "accepted",
        captainId: user.uid,
        driverId: user.uid,
        captainName: String(captainDoc.data()?.driver_name || captainDoc.data()?.name || captainDoc.data()?.fullName || ""),
        acceptedOfferId: offerId,
        offeredCaptainId: null,
        offeredCaptainName: null,
        offerExpiresAt: null,
        acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      transaction.set(lockRef, {
        orderId: orderRef.id,
        offerId,
        state: "accepted",
        expiresAt: null,
        acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return { alreadyAccepted: false };
    });

    return res.status(200).json({
      success: true,
      alreadyAccepted: outcome.alreadyAccepted === true,
      message: "تم قبول الطلب بنجاح وإسناده إليك",
      orderId: orderRef.id
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
      const currentStatus = String(data.status || "").trim().toLowerCase();
      if (currentStatus === "arrived_at_merchant" || currentStatus === "at_store") return;
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
        const currentStatus = String(data.status || "").trim().toLowerCase();
        if (currentStatus === "picked_up") return;
        if (!["arrived_at_merchant", "at_store", "ready", "ready_for_pickup"].includes(currentStatus)) {
          throw new Error("يجب تسجيل الوصول إلى التاجر وتجهيز الطلب قبل تأكيد الاستلام");
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
      const currentStatus = String(data.status || "").trim().toLowerCase();
      if (!["picked_up", "awaiting_merchant_confirmation", "merchant_rejected"].includes(currentStatus)) {
        throw new Error("لا يمكن تسجيل بيانات العميل والإيصال قبل استلام الطلب من التاجر");
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
    if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

    try {
      const initialSnap = await orderRef.get();
      if (!initialSnap.exists) return res.status(404).json({ error: "الطلب غير موجود" });

      const actor = await authenticateOrderManager(req, res, db, initialSnap.data() || {});
      if (!actor) return;

      let assignedCaptainId = "";
      const outcome = await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(orderRef);
        if (!doc.exists) throw new Error("الطلب غير موجود");
        const docData = doc.data() || {};

        const merchantOwners = [
          docData.merchantOwnerId,
          docData.merchantUid,
          docData.merchantId,
          docData.storeId,
          docData.vendorId,
          docData.ownerId,
          docData.userId
        ].map(value => String(value || "").trim()).filter(Boolean);

        if (actor.role === "merchant" && !merchantOwners.includes(actor.user.uid)) {
          throw new Error("غير مصرح: ملكية الطلب تغيرت أو لا تخص حسابك");
        }

        const currentStatus = String(docData.status || "").trim().toLowerCase();
        if (isConfirmed && docData.merchantConfirmed === true && currentStatus === "en_route") {
          assignedCaptainId = String(docData.captainId || docData.driverId || "").trim();
          return { alreadyProcessed: true };
        }
        if (currentStatus !== "awaiting_merchant_confirmation") {
          throw new Error("لا يمكن تأكيد الطلب إلا بعد إرسال الكابتن بيانات العميل والإيصال");
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
        return { alreadyProcessed: false };
      });

      if (isConfirmed && assignedCaptainId && !outcome.alreadyProcessed) {
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

      return res.status(200).json({
        success: true,
        alreadyProcessed: outcome.alreadyProcessed === true,
        message: isConfirmed ? "تم تأكيد الطلب بنجاح" : "تم رفض البيانات"
      });
    } catch (err) {
      console.warn("merchantConfirmOrder error:", err.message);
      return res.status(409).json({ error: err.message });
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

  const captainRef = db.collection("captains").doc(user.uid);
  const lockRef = db.collection("captain_order_locks").doc(user.uid);
  const transactionRecordRef = captainRef.collection("transactions").doc(orderRef.id);

  try {
    let earnedDeliveryFee = 25.0;
    await db.runTransaction(async (transaction) => {
      const [orderDoc, captainDoc, transactionRecord, lockDoc] = await Promise.all([
        transaction.get(orderRef),
        transaction.get(captainRef),
        transaction.get(transactionRecordRef),
        transaction.get(lockRef)
      ]);

      if (!orderDoc.exists) throw new Error("الطلب غير موجود");
      if (!captainDoc.exists) throw new Error("ملف الكابتن غير موجود");

      const orderData = orderDoc.data() || {};
      if (orderData.captainId !== user.uid && orderData.driverId !== user.uid) {
        throw new Error("غير مصرح: هذا الطلب ليس مسنداً إليك");
      }

      const currentStatus = String(orderData.status || "").trim().toLowerCase();
      const allowedDeliveryStatuses = [
        "en_route", "confirmed", "merchant_confirmed", "confirmed_by_merchant",
        "approved", "out_for_delivery", "delivering"
      ];
      if (!allowedDeliveryStatuses.includes(currentStatus)) {
        throw new Error("لا يمكن تأكيد التسليم قبل اعتماد بيانات الطلب من التاجر");
      }

      if (transactionRecord.exists || orderData.earningRecorded === true) {
        throw new Error("تم تسجيل مستحقات هذا الطلب مسبقاً");
      }

      const feeValue = Number(orderData.deliveryFee ?? orderData.delivery_fee ?? orderData.deliveryPrice ?? 25);
      earnedDeliveryFee = Number.isFinite(feeValue) && feeValue > 0 ? feeValue : 25;

      transaction.update(orderRef, {
        status: "delivered",
        earningRecorded: true,
        deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
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
        orderId: String(orderRef.id),
        description: `أرباح توصيل الطلب رقم #${orderRef.id}`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      if (lockDoc.exists) {
        const lock = lockDoc.data() || {};
        if (lock.orderId === orderRef.id && lock.state === "accepted") {
          transaction.delete(lockRef);
        }
      }
    });

    return res.status(200).json({
      success: true,
      message: "تم تسليم الطلب بنجاح وإضافة الأرباح لمحفظتك",
      earnedAmount: earnedDeliveryFee
    });
  } catch (err) {
    console.error("confirmDelivery error:", err.message);
    return res.status(409).json({ error: err.message });
  }
}

exports.confirmDelivery = onRequest({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, handleConfirmDelivery);
exports.completeDelivery = onRequest({ cors: true, timeoutSeconds: 30, memory: "256MiB" }, handleConfirmDelivery);

async function expireOfferAndReassign(db, orderRef, options = {}) {
  const callerUid = String(options.callerUid || "").trim();
  const expectedOfferId = String(options.expectedOfferId || "").trim();
  const reason = String(options.reason || "expired").trim().toLowerCase();
  const fromScheduler = options.fromScheduler === true;
  const allowEarlyDecline = ["declined", "rejected", "not_interested"].includes(reason);

  let shouldReassign = false;
  let updatedOrderData = null;
  let updatedExcluded = [];
  let expiredCaptainId = "";

  await db.runTransaction(async (transaction) => {
    const orderSnap = await transaction.get(orderRef);
    if (!orderSnap.exists) throw new Error("الطلب غير موجود");

    const data = orderSnap.data() || {};
    const status = String(data.status || "").trim().toLowerCase();
    const assignedCaptain = String(data.captainId || data.driverId || "").trim();
    if (assignedCaptain) return;

    const offeredCaptainId = String(data.offeredCaptainId || "").trim();
    const offerExpiresAt = Number(data.offerExpiresAt || 0);
    const currentOfferId = String(data.offerId || "").trim();

    if (callerUid && offeredCaptainId !== callerUid) {
      throw new Error("غير مصرح: هذا العرض ليس موجهًا إلى حسابك");
    }
    if (expectedOfferId && currentOfferId !== expectedOfferId) {
      throw new Error("العرض تغير أو لم يعد صالحًا");
    }

    const canSearch = ["pending", "searching", "offered", "new", "ready", "ready_for_pickup", "waiting_driver"].includes(status);
    if (!canSearch) return;

    if (offeredCaptainId) {
      if (!allowEarlyDecline && (!offerExpiresAt || offerExpiresAt > Date.now())) {
        throw new Error("لا يمكن إنهاء العرض قبل انتهاء مهلة الستين ثانية");
      }
    } else if (!fromScheduler && callerUid) {
      throw new Error("لا يوجد عرض نشط لهذا الكابتن");
    }

    const lockRef = offeredCaptainId
      ? db.collection("captain_order_locks").doc(offeredCaptainId)
      : null;
    const lockSnap = lockRef ? await transaction.get(lockRef) : null;

    const excluded = Array.isArray(data.excludedCaptainIds) ? [...data.excludedCaptainIds] : [];
    if (offeredCaptainId && !excluded.includes(offeredCaptainId)) excluded.push(offeredCaptainId);
    updatedExcluded = excluded;
    expiredCaptainId = offeredCaptainId;

    if (lockSnap?.exists) {
      const lock = lockSnap.data() || {};
      if (lock.orderId === orderRef.id && (!currentOfferId || lock.offerId === currentOfferId)) {
        transaction.delete(lockRef);
      }
    }

    transaction.update(orderRef, {
      status: "searching",
      dispatchStatus: "searching",
      offeredCaptainId: null,
      offeredCaptainName: null,
      offerId: admin.firestore.FieldValue.delete(),
      offerExpiresAt: null,
      excludedCaptainIds: excluded,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    updatedOrderData = { ...data, status: "searching", offeredCaptainId: null, offerId: null, offerExpiresAt: null, excludedCaptainIds: excluded };
    shouldReassign = true;
  });

  if (!shouldReassign) {
    return { reassigned: false, reason: "not_expired_or_already_assigned" };
  }

  const assignment = await assignNearestCaptainInternal(
    db,
    orderRef,
    updatedOrderData || {},
    updatedExcluded
  );

  return {
    reassigned: true,
    expiredCaptainId,
    offeredCaptainId: assignment.offeredCaptainId || null,
    offeredCaptainName: assignment.offeredCaptainName || "",
    offerId: assignment.offerId || null,
    distanceKm: assignment.distanceKm || null,
    offerExpiresAt: assignment.offerExpiresAt || null
  };
}

// ------------------------------------------------------------------------------
// 7. Cloud Function: expireDeliveryOffer
// Ends the 60s window, excludes current captain, and immediately reassigns to nearest captain
// ------------------------------------------------------------------------------
exports.expireDeliveryOffer = onRequest(
  { cors: true, timeoutSeconds: 30, memory: "256MiB" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    const user = await authenticateCaptain(req, res);
    if (!user) return;

    const { orderId, captainId, offerId, reason } = req.body || {};
    if (!orderId) return res.status(400).json({ error: "معرف الطلب مطلوب" });
    if (captainId && String(captainId) !== user.uid) {
      return res.status(403).json({ error: "هوية الكابتن المرسلة لا تطابق جلسة الدخول" });
    }

    const db = admin.firestore();
    const orderRef = await resolveOrderReference(db, orderId);
    if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

    try {
      const result = await expireOfferAndReassign(db, orderRef, {
        callerUid: user.uid,
        expectedOfferId: offerId || "",
        reason: reason || "expired"
      });

      return res.status(200).json({
        success: true,
        reassigned: result.reassigned,
        offeredCaptainId: result.offeredCaptainId || null,
        offerId: result.offerId || null,
        distanceKm: result.distanceKm || null,
        message: result.reassigned ? "تم إنهاء العرض وإعادة البحث عن كابتن متاح" : "لا يوجد عرض منتهي لإعادة توزيعه"
      });
    } catch (err) {
      console.warn("expireDeliveryOffer error:", err.message);
      return res.status(409).json({ error: err.message });
    }
  }
);

// ------------------------------------------------------------------------------
// 8. Cloud Function: assignNextAvailableCaptain
// Selects the nearest online, active, non-busy, in-shift captain to the merchant
// ------------------------------------------------------------------------------
exports.assignNextAvailableCaptain = onRequest(
  { cors: true, timeoutSeconds: 30, memory: "256MiB" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const db = admin.firestore();
    const user = await authenticateAdmin(req, res, db);
    if (!user) return;

    const { orderId, captainId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: "معرف الطلب مطلوب" });

    const orderRef = await resolveOrderReference(db, orderId);
    if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

    try {
      const orderDoc = await orderRef.get();
      if (!orderDoc.exists) return res.status(404).json({ error: "الطلب غير موجود" });

      const orderData = orderDoc.data() || {};
      const excluded = Array.isArray(orderData.excludedCaptainIds) ? orderData.excludedCaptainIds : [];
      const requestedCaptainId = String(captainId || "").trim();

      const assignResult = await assignNearestCaptainInternal(
        db, orderRef, orderData, excluded, requestedCaptainId
      );

      if (assignResult.assigned) {
        return res.status(200).json({
          success: true,
          message: requestedCaptainId ? "تم إرسال عرض الطلب إلى الكابتن المحدد" : "تم إرسال عرض الطلب إلى أقرب كابتن مؤهل",
          offeredCaptainId: assignResult.offeredCaptainId,
          offeredCaptainName: assignResult.offeredCaptainName || "",
          offerId: assignResult.offerId,
          distanceKm: assignResult.distanceKm,
          offerExpiresAt: assignResult.offerExpiresAt,
          expiresInSeconds: 60
        });
      }

      const message = requestedCaptainId
        ? "الكابتن المحدد غير متاح أو لا يحقق شروط الاتصال والموقع والشفت أو لديه طلب نشط"
        : "لا يوجد كباتن مؤهلون متاحون حالياً، سيستمر البحث";
      return res.status(requestedCaptainId ? 409 : 200).json({
        success: !requestedCaptainId,
        assigned: false,
        reason: assignResult.reason || "no_eligible_captain",
        message
      });
    } catch (err) {
      console.error("assignNextAvailableCaptain error:", err.message);
      return res.status(500).json({ error: "تعذر توزيع الطلب حالياً" });
    }
  }
);

function generateUniqueOrderCode() {
  const digits = "0123456789".split("");
  const first = String(crypto.randomInt(1, 10));
  const remaining = digits.filter(digit => digit !== first);
  let code = first;
  while (code.length < 6) {
    const index = crypto.randomInt(0, remaining.length);
    code += remaining.splice(index, 1)[0];
  }
  return code;
}

function sanitizeOrderItems(items) {
  if (!Array.isArray(items)) return [];
  if (items.length > 40) throw new Error("عدد أصناف الطلب يتجاوز الحد المسموح");

  return items.map((item, index) => {
    const name = String(item?.name || "").trim().slice(0, 120);
    const quantity = Number(item?.quantity);
    const price = Number(item?.price);
    if (!name || !Number.isInteger(quantity) || quantity < 1 || quantity > 999 ||
        !Number.isFinite(price) || price < 0) {
      throw new Error(`بيانات صنف الطلب رقم ${index + 1} غير صالحة`);
    }
    return { name, quantity, price };
  });
}

// ------------------------------------------------------------------------------
// Server-authoritative order creation and admin order updates
// ------------------------------------------------------------------------------
exports.createOrder = onRequest(
  { cors: true, timeoutSeconds: 60, memory: "256MiB" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const db = admin.firestore();
    const user = await authenticateAdmin(req, res, db);
    if (!user) return;

    const body = req.body || {};
    const restaurantId = String(body.restaurantId || body.merchantId || "").trim();
    const requestId = String(body.requestId || "").trim();
    if (!restaurantId) return res.status(400).json({ error: "معرف التاجر مطلوب" });
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(requestId)) {
      return res.status(400).json({ error: "معرف محاولة إنشاء الطلب غير صالح" });
    }

    try {
      const [restaurantSnap, merchantSnap] = await Promise.all([
        db.collection("restaurants").doc(restaurantId).get(),
        db.collection("merchants").doc(restaurantId).get()
      ]);
      const merchantData = restaurantSnap.exists
        ? (restaurantSnap.data() || {})
        : (merchantSnap.exists ? (merchantSnap.data() || {}) : {});
      const restaurantName = String(
        merchantData.name || merchantData.restaurantName || merchantData.merchantName || body.restaurantName || ""
      ).trim().slice(0, 160);
      if (!restaurantName) return res.status(404).json({ error: "بيانات التاجر أو اسم المتجر غير موجودة" });

      const customerName = String(body.customerName || "").trim().slice(0, 120);
      const customerPhone = String(body.customerPhone || "").trim().slice(0, 30);
      const deliveryAddress = String(body.deliveryAddress || "").trim().slice(0, 700);
      const notes = String(body.notes || "").trim().slice(0, 1500);

      const deliveryFee = Number(body.deliveryFee ?? 25);
      const subtotal = Number(body.subtotal ?? 0);
      const total = Number(body.total ?? (subtotal + deliveryFee));
      if (![deliveryFee, subtotal, total].every(Number.isFinite) ||
          deliveryFee < 0 || subtotal < 0 || total < 0) {
        return res.status(400).json({ error: "قيمة الطلب أو رسوم التوصيل غير صالحة" });
      }

      const items = sanitizeOrderItems(body.items);
      const requestedCaptainId = String(body.captainId || "").trim();
      const orderRef = db.collection("orders").doc();
      const requestKey = crypto.createHash("sha256")
        .update(`${user.uid}:${requestId}`)
        .digest("hex");
      const idempotencyRef = db.collection("idempotency_keys").doc(requestKey);

      const baseOrder = {
        orderNumber: "",
        orderCode: "",
        order_code: "",
        order_codes: "",
        merchantId: restaurantId,
        merchantOwnerId: String(merchantData.ownerUid || merchantData.ownerId || merchantData.userId || merchantData.merchantUid || merchantData.authUid || restaurantId).trim(),
        restaurantId,
        merchantName: restaurantName,
        restaurantName,
        captainId: null,
        driverId: null,
        captainName: "",
        offeredCaptainId: null,
        offeredCaptainName: "",
        customerName,
        customerPhone,
        deliveryAddress,
        deliveryFee,
        delivery_fee: deliveryFee,
        deliveryPrice: deliveryFee,
        fee: deliveryFee,
        subtotal,
        total,
        status: "searching",
        dispatchStatus: "searching",
        notes,
        items,
        excludedCaptainIds: [],
        dispatchedBy: "admin",
        createdBy: user.uid,
        source: "admin_dashboard",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      let creationResult = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        const code = generateUniqueOrderCode();
        const orderNumber = `#ELB-${code}`;
        const codeRef = db.collection("order_codes").doc(code);
        const orderData = {
          ...baseOrder,
          orderNumber,
          orderCode: orderNumber,
          order_code: orderNumber,
          order_codes: orderNumber
        };

        creationResult = await db.runTransaction(async (transaction) => {
          const [idempotencySnap, codeSnap] = await Promise.all([
            transaction.get(idempotencyRef),
            transaction.get(codeRef)
          ]);

          if (idempotencySnap.exists) {
            const saved = idempotencySnap.data() || {};
            return { duplicate: true, orderId: String(saved.orderId || "") };
          }
          if (codeSnap.exists) return { collision: true };

          transaction.create(orderRef, orderData);
          transaction.create(codeRef, {
            code,
            orderId: orderRef.id,
            orderDocId: orderRef.id,
            orderNumber,
            orderCode: orderNumber,
            order_code: orderNumber,
            merchantId: restaurantId,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          transaction.create(idempotencyRef, {
            requestId,
            userId: user.uid,
            merchantId: restaurantId,
            orderId: orderRef.id,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });

          return { created: true, orderId: orderRef.id, orderData };
        });

        if (!creationResult.collision) break;
      }

      if (!creationResult || creationResult.collision) {
        return res.status(503).json({ error: "تعذر إنشاء رقم طلب فريد، يرجى المحاولة مجدداً" });
      }

      if (creationResult.duplicate) {
        if (!creationResult.orderId) return res.status(409).json({ error: "مفتاح منع التكرار غير مكتمل" });
        const savedOrder = await db.collection("orders").doc(creationResult.orderId).get();
        if (!savedOrder.exists) return res.status(409).json({ error: "سجل منع التكرار يشير إلى طلب غير موجود" });
        const saved = savedOrder.data() || {};
        return res.status(200).json({
          success: true,
          duplicate: true,
          orderId: savedOrder.id,
          orderNumber: saved.orderNumber || saved.orderCode || "",
          orderCode: saved.orderCode || saved.orderNumber || "",
          offeredCaptainId: saved.offeredCaptainId || null,
          offeredCaptainName: saved.offeredCaptainName || "",
          offerId: saved.offerId || null,
          status: saved.status || "searching"
        });
      }

      const assignment = await assignNearestCaptainInternal(
        db,
        orderRef,
        creationResult.orderData,
        [],
        requestedCaptainId
      );

      if (assignment.assigned) {
        await orderRef.update({
          offeredCaptainName: assignment.offeredCaptainName || "",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      return res.status(200).json({
        success: true,
        duplicate: false,
        orderId: orderRef.id,
        orderNumber: creationResult.orderData.orderNumber,
        orderCode: creationResult.orderData.orderCode,
        status: assignment.assigned ? "pending" : "searching",
        offeredCaptainId: assignment.offeredCaptainId || null,
        offeredCaptainName: assignment.offeredCaptainName || "",
        offerId: assignment.offerId || null,
        offerExpiresAt: assignment.offerExpiresAt || null,
        distanceKm: assignment.distanceKm || null,
        assigned: assignment.assigned === true,
        assignmentReason: assignment.reason || ""
      });
    } catch (err) {
      console.error("createOrder error:", err?.message || err);
      return res.status(400).json({ error: err.message || "تعذر إنشاء الطلب" });
    }
  }
);

exports.adminUpdateOrderStatus = onRequest(
  { cors: true, timeoutSeconds: 30, memory: "256MiB" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const db = admin.firestore();
    const user = await authenticateAdmin(req, res, db);
    if (!user) return;

    const { orderId, action, newStatus, field } = req.body || {};
    if (!orderId) return res.status(400).json({ error: "معرف الطلب مطلوب" });

    const orderRef = await resolveOrderReference(db, orderId);
    if (!orderRef) return res.status(400).json({ error: "معرف الطلب غير صالح" });

    try {
      if (action === "recordStageTimestamp") {
        const timestampFields = {
          acceptedAt: "acceptedAt",
          arrivedAtMerchantAt: "arrivedAtMerchantAt",
          pickedUpAt: "pickedUpAt",
          deliveredAt: "deliveredAt"
        };
        const fieldName = timestampFields[String(field || "")];
        if (!fieldName) return res.status(400).json({ error: "حقل التوقيت غير مسموح" });

        const now = Date.now();
        await db.runTransaction(async (transaction) => {
          const orderSnap = await transaction.get(orderRef);
          if (!orderSnap.exists) throw new Error("الطلب غير موجود");
          const data = orderSnap.data() || {};
          const statusValue = String(data.status || "").toLowerCase();

          if (fieldName === "acceptedAt" && !["accepted", "assigned", "arrived_at_merchant", "at_store", "preparing", "ready"].includes(statusValue)) {
            throw new Error("لا يمكن تسجيل وقت القبول قبل قبول الطلب");
          }
          if (fieldName === "arrivedAtMerchantAt" && !["arrived_at_merchant", "at_store", "preparing", "ready", "picked_up", "awaiting_merchant_confirmation", "en_route", "delivered"].includes(statusValue)) {
            throw new Error("لا يمكن تسجيل وقت الوصول قبل تسجيل الوصول");
          }
          if (fieldName === "pickedUpAt" && !["picked_up", "awaiting_merchant_confirmation", "merchant_rejected", "en_route", "delivered"].includes(statusValue)) {
            throw new Error("لا يمكن تسجيل وقت الاستلام قبل استلام الطلب");
          }
          if (fieldName === "deliveredAt" && !["delivered", "completed"].includes(statusValue)) {
            throw new Error("يجب إتمام التسليم من تطبيق الكابتن أولاً");
          }

          if (!data[fieldName]) {
            transaction.update(orderRef, {
              [fieldName]: admin.firestore.Timestamp.fromMillis(now),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        });

        return res.status(200).json({ success: true, field: fieldName, timestamp: new Date(now).toISOString() });
      }

      if (action !== "updateStatus") {
        return res.status(400).json({ error: "نوع العملية غير مدعوم" });
      }

      const normalized = String(newStatus || "").trim().toLowerCase();
      const statusMap = {
        "preparing": "preparing",
        "ready": "ready",
        "cancelled": "cancelled",
        "canceled": "cancelled"
      };
      const nextStatus = statusMap[normalized];
      if (!nextStatus) {
        return res.status(400).json({ error: "هذه المرحلة يجب أن يتم تسجيلها من تطبيق التاجر أو الكابتن، وليست من لوحة الإدارة" });
      }

      await db.runTransaction(async (transaction) => {
        const orderSnap = await transaction.get(orderRef);
        if (!orderSnap.exists) throw new Error("الطلب غير موجود");

        const data = orderSnap.data() || {};
        const currentStatus = String(data.status || "").trim().toLowerCase();
        if (["delivered", "completed"].includes(currentStatus)) {
          throw new Error("لا يمكن تعديل طلب تم تسليمه");
        }
        if (["cancelled", "canceled"].includes(currentStatus)) {
          throw new Error("الطلب ملغي بالفعل");
        }

        const assignedCaptainId = String(
          data.captainId || data.driverId || data.offeredCaptainId || ""
        ).trim();
        const lockRef = assignedCaptainId
          ? db.collection("captain_order_locks").doc(assignedCaptainId)
          : null;
        const lockSnap = lockRef ? await transaction.get(lockRef) : null;

        const updates = {
          status: nextStatus,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (nextStatus === "cancelled") {
          updates.dispatchStatus = "cancelled";
          updates.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
          updates.offeredCaptainId = null;
          updates.offeredCaptainName = null;
          updates.offerId = admin.firestore.FieldValue.delete();
          updates.offerExpiresAt = null;
          if (lockSnap?.exists) {
            const lock = lockSnap.data() || {};
            if (lock.orderId === orderRef.id) transaction.delete(lockRef);
          }
        } else if (nextStatus === "ready") {
          updates.readyAt = admin.firestore.FieldValue.serverTimestamp();
        } else if (nextStatus === "preparing") {
          updates.preparingAt = admin.firestore.FieldValue.serverTimestamp();
        }

        transaction.update(orderRef, updates);
      });

      return res.status(200).json({ success: true, status: nextStatus });
    } catch (err) {
      console.warn("adminUpdateOrderStatus error:", err.message);
      return res.status(409).json({ error: err.message });
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
  // createOrder runs the initial dispatch itself after its idempotent creation transaction.
  if (!beforeData && afterData.source === "admin_dashboard") return;

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
    const expectedNotifyKey = `${afterOffered}_${String(afterData.offerId || Number(afterData.offerExpiresAt || 0))}`;
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
// Automatically reassigns any order whose 60s offer deadline expired without acceptance
// (e.g., if captain's phone was offline) to the nearest eligible captain to the merchant.
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
      try {
        const data = doc.data() || {};
        const assigned = String(data.captainId || data.driverId || "").trim();
        if (assigned && assigned.toLowerCase() !== "null") continue;

        const offerExpiresAt = Number(data.offerExpiresAt || 0);
        const offeredCaptainId = String(data.offeredCaptainId || "").trim();
        const isExpiredOffer = Boolean(offeredCaptainId && offerExpiresAt > 0 && offerExpiresAt <= nowMs);
        const isUnassignedSearch = !offeredCaptainId &&
          ["searching", "pending", "offered"].includes(String(data.status || "").toLowerCase());

        if (!isExpiredOffer && !isUnassignedSearch) continue;

        await expireOfferAndReassign(db, doc.ref, {
          fromScheduler: true,
          reason: isExpiredOffer ? "expired" : "searching"
        });
      } catch (error) {
        console.error("scheduledReassignExpiredOffers failed for", doc.id, error?.message || error);
      }
    }
  }
);


);

