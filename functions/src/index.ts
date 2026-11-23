import {initializeApp} from "firebase-admin/app";
import {createHash, randomInt} from "node:crypto";
import {getFirestore, FieldValue, GeoPoint} from "firebase-admin/firestore";
import {setGlobalOptions} from "firebase-functions";
import * as logger from "firebase-functions/logger";
import {
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentWritten,
} from "firebase-functions/v2/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {onTaskDispatched} from "firebase-functions/v2/tasks";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {
  createAdminCaptainApprovalEffects,
  createAdminDatabaseAdapter,
  createAdminManualSubscriptionEffects,
  createAdminServerEffects,
} from "./firebaseAdapter.js";
import {CaptainApprovalServerService} from "./captainApprovalService.js";
import {ManualSubscriptionsServerService} from "./manualSubscriptionsService.js";
import {OrderServerService} from "./ordersService.js";
import {isCaptainInActiveShift, isCaptainWithinReadyWindow} from "./shifts.js";
import {DomainHttpsError, ReassignTaskPayload} from "./types.js";
import {
  assertMerchantAndSubscriptionValid,
  evaluateVerifiedAdminAccess,
  MAX_LOCATION_AGE_MS,
  MAX_PACKAGE_CAPTAINS,
  MIN_PACKAGE_CAPTAINS,
  parseTimestampMs,
  extractCoordinates,
  extractOrderCaptainUid,
  readNormalizedOrderStatus,
  readNumber,
  readString,
  resolveCanonicalPlanIdentifier,
  resolveCaptainAccountStatus,
  resolveEffectiveCaptainLimit,
  isTerminalMerchantOrderStatus,
} from "./validators.js";

initializeApp();
setGlobalOptions({region: "us-central1", maxInstances: 10});

const dbAdapter = createAdminDatabaseAdapter(getFirestore());
const service = new OrderServerService(
  dbAdapter,
  createAdminServerEffects()
);
const manualSubService = new ManualSubscriptionsServerService(
  dbAdapter,
  createAdminManualSubscriptionEffects()
);
const captainApprovalService = new CaptainApprovalServerService(
  dbAdapter,
  createAdminCaptainApprovalEffects()
);

function mapError(err: unknown): HttpsError {
  if (err instanceof HttpsError) return err;
  if (err instanceof DomainHttpsError) {
    return new HttpsError(err.code, err.message);
  }
  logger.error("Unhandled Cloud Function order error", {
    error: err instanceof Error ? err.message : String(err),
  });
  return new HttpsError(
    "internal",
    "حدث خطأ غير متوقع في الخادم أثناء تنفيذ العملية."
  );
}

function isCaptainReadyForDispatch(data: Record<string, unknown> | undefined): boolean {
  if (!data || data.isOnline !== true) return false;
  if (readString(data, "workStatus").toLowerCase() !== "working" || data.readyConfirmed !== true) return false;
  if (resolveCaptainAccountStatus(data) !== "approved") return false;
  const status = readString(data, "status").toLowerCase();
  const presence = (readString(data, "presenceStatus") || "available").toLowerCase();
  const availability = (readString(data, "availabilityStatus") || "available").toLowerCase();
  const unavailable = new Set(["offline", "busy", "unavailable", "paused", "on_trip"]);
  return ["online", "active", "approved"].includes(status) &&
    data.canReceiveOrders !== false &&
    data.isReceivingOrders !== false &&
    data.receiveOrders !== false &&
    data.isBlocked !== true &&
    data.isSuspended !== true &&
    !unavailable.has(presence) &&
    !unavailable.has(availability) &&
    !readString(data, "currentOrderId") &&
    !readString(data, "activeOfferOrderId");
}

async function enforceCaptainEmailLookupRateLimit(ipAddress: string, phone: string): Promise<void> {
  const db = getFirestore();
  const nowMs = Date.now();
  const windowMs = 15 * 60 * 1000;
  const normalizedPhone = phone.replace(/[^0-9+]/g, "").slice(0, 32) || "missing";
  const scopes = [
    {name: "ip", value: ipAddress || "unknown", maxAttempts: 30},
    {name: "phone", value: normalizedPhone, maxAttempts: 6},
  ];

  for (const scope of scopes) {
    const digest = createHash("sha256").update(scope.value).digest("hex");
    const ref = db.collection("security_rate_limits")
      .doc(`captain-email-lookup-${scope.name}-${digest}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data() ?? {};
      const windowStartedAtMs = readNumber(data, "windowStartedAtMs") ?? 0;
      const attempts = readNumber(data, "attempts") ?? 0;
      const inWindow = nowMs - windowStartedAtMs < windowMs;
      if (inWindow && attempts >= scope.maxAttempts) {
        throw new HttpsError(
          "resource-exhausted",
          "تم تجاوز عدد محاولات البحث عن الحساب. حاول مرة أخرى بعد 15 دقيقة."
        );
      }
      tx.set(ref, {
        scope: scope.name,
        windowStartedAtMs: inWindow ? windowStartedAtMs : nowMs,
        attempts: inWindow ? attempts + 1 : 1,
        expiresAt: new Date(nowMs + 24 * 60 * 60 * 1000),
        updatedAt: FieldValue.serverTimestamp(),
      }, {merge: true});
    });
  }
}

/**
 * Callable 1: Authoritative order acceptance by authenticated captain.
 */
/**
 * Server-authoritative captain shift presence transition.
 * Clients cannot write workStatus/readyConfirmed directly; the server checks approval,
 * the canonical Cairo shift schedule, and the explicit Ready confirmation.
 */
export const updateCaptainShiftPresence = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const uid = request.auth?.uid;
      if (!uid) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً.");
      const payload = (request.data ?? {}) as Record<string, unknown>;
      const action = readString(payload, "action").toLowerCase();
      if (!["ready", "working", "offline"].includes(action)) {
        throw new HttpsError("invalid-argument", "حالة الكابتن المطلوبة غير صحيحة.");
      }

      const captainRef = getFirestore().collection("captains").doc(uid);
      const captainSnap = await captainRef.get();
      if (!captainSnap.exists) throw new HttpsError("not-found", "ملف الكابتن غير موجود.");
      const captainData = (captainSnap.data() ?? {}) as Record<string, unknown>;
      if (captainData.accountType !== "captain" && captainData.role !== "captain") {
        throw new HttpsError("permission-denied", "هذا الحساب ليس حساب كابتن.");
      }

      if (action === "offline") {
        if (captainData.isOnline === false &&
            captainData.workStatus === "off_shift" &&
            captainData.readyConfirmed === false) {
          return {success: true, workStatus: "off_shift", unchanged: true};
        }
        await captainRef.update({
          isOnline: false,
          workStatus: "off_shift",
          readyConfirmed: false,
          presenceStatus: "offline",
          availabilityStatus: "offline",
          updatedAt: FieldValue.serverTimestamp(),
        });
        return {success: true, workStatus: "off_shift"};
      }

      if (resolveCaptainAccountStatus(captainData) !== "approved") {
        throw new HttpsError("permission-denied", "حساب الكابتن غير معتمد أو موقوف.");
      }

      const nowMs = Date.now();
      const activeShift = await isCaptainInActiveShift(dbAdapter, uid, captainData, nowMs);
      if (action === "ready") {
        if (captainData.isOnline === true &&
            captainData.workStatus === "ready" &&
            captainData.readyConfirmed === true) {
          return {success: true, workStatus: "ready", unchanged: true};
        }
        const inReadyWindow = await isCaptainWithinReadyWindow(dbAdapter, uid, captainData, nowMs);
        if (!activeShift && !inReadyWindow) {
          throw new HttpsError(
            "failed-precondition",
            "يمكن تأكيد الجاهزية قبل الشفت بـ30 دقيقة فقط أو عند بداية الشفت."
          );
        }
        await captainRef.update({
          isOnline: true,
          workStatus: "ready",
          readyConfirmed: true,
          readyConfirmedAt: FieldValue.serverTimestamp(),
          presenceStatus: "ready",
          availabilityStatus: "ready",
          updatedAt: FieldValue.serverTimestamp(),
        });
        return {success: true, workStatus: "ready"};
      }

      if (!activeShift) {
        throw new HttpsError("failed-precondition", "لا يمكن بدء العمل خارج وقت الشفت.");
      }
      if (captainData.isOnline === true &&
          captainData.workStatus === "working" &&
          captainData.readyConfirmed === true) {
        return {success: true, workStatus: "working", unchanged: true};
      }
      const hasReadyConfirmation = captainData.readyConfirmed === true &&
        (captainData.workStatus === "ready" || captainData.workStatus === "working");
      if (!hasReadyConfirmation) {
        throw new HttpsError(
          "failed-precondition",
          "يجب الضغط على جاهز وتأكيد الحضور قبل التحول إلى يعمل الآن."
        );
      }
      await captainRef.update({
        isOnline: true,
        workStatus: "working",
        readyConfirmed: true,
        presenceStatus: "working",
        availabilityStatus: "working",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {success: true, workStatus: "working"};
    } catch (err) {
      throw mapError(err);
    }
  }
);

export const acceptOrder = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await service.acceptOrder(request.auth?.uid, payload);
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Callable 2: Captain records arrival at merchant pickup location.
 */
export const captainArrivedAtMerchant = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await service.captainArrivedAtMerchant(request.auth?.uid, payload);
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Callable 3: Captain confirms picking up order from merchant.
 */
export const confirmPickup = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await service.confirmPickup(request.auth?.uid, payload);
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Callable 4: Captain submits customer details and verified receipt Storage path.
 */
export const submitCustomerDeliveryDetails = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await service.submitCustomerDeliveryDetails(
        request.auth?.uid,
        payload
      );
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Callable 5: Atomic idempotent delivery completion and wallet credit.
 */
export const confirmDelivery = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await service.confirmDelivery(request.auth?.uid, payload);
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Callable 6: Server-verified offer expiry or explicit decline.
 */
export const expireDeliveryOffer = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await service.expireDeliveryOffer(request.auth?.uid, payload);
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Callable 7: Read-only captain email lookup by phone number during pre-login.
 */
export const resolveCaptainEmailByPhone = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      const phone = readString(payload, "phone", "phoneNumber", "mobile");
      await enforceCaptainEmailLookupRateLimit(request.rawRequest.ip || "unknown", phone);
      return await service.resolveCaptainEmailByPhone(payload);
    } catch (err) {
      throw mapError(err);
    }
  }
);


async function requireAdminUid(
  uid: string | undefined,
  claims: Record<string, unknown>
): Promise<string> {
  const cleanUid = typeof uid === "string" ? uid.trim() : "";
  const adminDoc = cleanUid
    ? await getFirestore().collection("admins").doc(cleanUid).get()
    : null;
  try {
    const verified = evaluateVerifiedAdminAccess({
      authContext: cleanUid ? {uid: cleanUid, token: claims} : undefined,
      adminDocExists: Boolean(adminDoc?.exists),
      adminDocData: adminDoc?.exists ? (adminDoc.data() ?? {}) : undefined,
    });
    return verified.uid;
  } catch (err) {
    throw mapError(err);
  }
}

function requireOrderId(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new HttpsError("invalid-argument", "معرف الطلب مطلوب.");
  }
  const value = raw.trim().replace(/^#+/, "").trim();
  if (!value || value.length > 128 || value.includes("/")) {
    throw new HttpsError("invalid-argument", "معرف الطلب غير صالح.");
  }
  return value;
}

function generateDistinctOrderCode(): string {
  const firstDigit = randomInt(1, 10);
  const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((digit) => digit !== firstDigit);
  const digits = [firstDigit];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  digits.push(...pool.slice(0, 5));
  return digits.join("");
}

function isClosedMerchantOrderStatus(status: string): boolean {
  return isTerminalMerchantOrderStatus(status);
}

const PERMANENT_DISPATCH_ERROR_CODES = new Set<DomainHttpsError["code"]>([
  "invalid-argument",
  "permission-denied",
  "not-found",
  "failed-precondition",
]);

/**
 * Persist non-retryable order-data failures for admin review. Transient infrastructure
 * failures are deliberately rethrown so the Firestore event retry policy can recover.
 */
async function recordPermanentDispatchFailure(
  orderId: string,
  error: DomainHttpsError
): Promise<void> {
  const db = getFirestore();
  const orderRef = db.collection("orders").doc(orderId);
  const alertRef = db.collection("notifications").doc(`dispatch_failed_${orderId}`);

  await db.runTransaction(async (tx) => {
    const [orderSnap, alertSnap] = await Promise.all([
      tx.get(orderRef),
      tx.get(alertRef),
    ]);
    if (!orderSnap.exists) return;

    const order = orderSnap.data() ?? {};
    if (
      extractOrderCaptainUid(order) ||
      isClosedMerchantOrderStatus(readNormalizedOrderStatus(order))
    ) return;

    const now = FieldValue.serverTimestamp();
    tx.update(orderRef, {
      dispatchStatus: "dispatch_failed",
      dispatchFailureCode: error.code,
      dispatchFailureMessage: error.message.slice(0, 400),
      dispatchFailedAt: now,
      updatedAt: now,
    });

    if (!alertSnap.exists) {
      tx.set(alertRef, {
        type: "order_dispatch_failed",
        targetRole: "admin",
        title: "تعذر بدء توزيع طلب",
        message: `تعذر توزيع الطلب ${readString(order, "orderNumber") || orderId}: ${error.message}`,
        orderId,
        orderNumber: readString(order, "orderNumber", "order_number") || orderId,
        reason: error.message,
        isRead: false,
        createdAt: now,
      });
    }
  });
}

/**
 * Executes dispatch for a Firestore event. Known invalid business data is recorded
 * once for admin action; unexpected errors are rethrown to activate event retries.
 */
async function dispatchOrderFromEvent(
  orderId: string,
  triggerName: string
): Promise<void> {
  try {
    await service.dispatchNewOrSearchingOrder(orderId);
  } catch (err) {
    logger.error(`Order dispatch trigger failed: ${triggerName}`, {
      orderId,
      error: err instanceof Error ? err.message : String(err),
    });

    if (
      err instanceof DomainHttpsError &&
      PERMANENT_DISPATCH_ERROR_CODES.has(err.code)
    ) {
      await recordPermanentDispatchFailure(orderId, err);
      return;
    }

    throw err;
  }
}

/**
 * Converts Firestore Timestamp, Date, ISO date, or epoch values to milliseconds.
 */
function timestampToMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 1_000_000_000_000 ? Math.round(numeric * 1000) : Math.round(numeric);
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === "object") {
    const timestamp = value as {toMillis?: () => number; seconds?: number; _seconds?: number; nanoseconds?: number};
    if (typeof timestamp.toMillis === "function") {
      const parsed = timestamp.toMillis();
      return Number.isFinite(parsed) ? parsed : null;
    }
    const seconds = Number(timestamp.seconds ?? timestamp._seconds);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.round(seconds * 1000 + Number(timestamp.nanoseconds || 0) / 1_000_000);
    }
  }
  return null;
}

async function buildMerchantSubscriptionResponse(merchantId: string, requestedCaptains = 1) {
  const db = getFirestore();
  const [merchantSnap, subscriptionSnap, byMerchant, byRestaurant, byUser] = await Promise.all([
    db.collection("merchants").doc(merchantId).get(),
    db.collection("subscriptions").doc(merchantId).get(),
    db.collection("orders").where("merchantId", "==", merchantId).get(),
    db.collection("orders").where("restaurantId", "==", merchantId).get(),
    db.collection("orders").where("userId", "==", merchantId).get(),
  ]);
  const merchant = merchantSnap.data() ?? {};
  const subscription = subscriptionSnap.data() ?? {};
  const activeOrderIds = new Set<string>();
  for (const snapshot of [byMerchant, byRestaurant, byUser]) {
    for (const orderDoc of snapshot.docs) {
      if (!isClosedMerchantOrderStatus(readNormalizedOrderStatus(orderDoc.data() ?? {}))) {
        activeOrderIds.add(orderDoc.id);
      }
    }
  }
  const activeCaptainsCount = activeOrderIds.size;
  const {planId, planKey} = resolveCanonicalPlanIdentifier(merchant, subscription);
  const planName =
    readString(subscription, "planName", "packageName", "plan") ||
    readString(merchant, "planName", "packageName", "plan");
  const captainLimit = resolveEffectiveCaptainLimit(merchant, subscription);
  const price = readNumber(subscription, "price", "amount") ?? readNumber(merchant, "price") ?? 0;
  const statusRaw = readString(subscription, "status", "subscriptionStatus") ||
    readString(merchant, "subscriptionStatus");
  let status = statusRaw.trim().toLowerCase();
  const merchantStatus = readString(merchant, "status").toLowerCase();
  const merchantApproved = merchantSnap.exists &&
    readString(merchant, "accountType").toLowerCase() === "merchant" &&
    (["approved", "active"].includes(merchantStatus) || merchant.isApproved === true);
  const activeFlags = subscription.isActive === true ||
    subscription.isSubscribed === true || merchant.isSubscribed === true;
  const subscriptionStatusActive = [
    "active", "approved", "trial", "enabled", "valid", "subscribed", "نشط", "نشطة", "ساري", "سارية",
  ].includes(status) || (!status && activeFlags);
  const endDateMs = timestampToMillis(
    subscription.expiresAt ?? subscription.endDate ?? subscription.expiryDate ??
    subscription.subscriptionEndDate ?? merchant.subscriptionEndDate ?? merchant.subscriptionExpiresAt
  );
  const startDateMs = timestampToMillis(
    subscription.activatedAt ?? subscription.startDate ?? subscription.subscriptionStartDate ??
    merchant.subscriptionStartDate
  );
  const nowMs = Date.now();
  const expiryEffectiveMs = endDateMs !== null && new Date(endDateMs).getUTCHours() === 0 &&
    new Date(endDateMs).getUTCMinutes() === 0 && new Date(endDateMs).getUTCSeconds() === 0
    ? endDateMs + 86_400_000 - 1 : endDateMs;
  let validationError = "";
  if (!merchantSnap.exists || readString(merchant, "accountType").toLowerCase() !== "merchant") {
    validationError = "تعذر العثور على بيانات حساب التاجر.";
    status = "not_found";
  } else if (!merchantApproved) {
    validationError = "حساب التاجر في انتظار موافقة الإدارة.";
    status = "merchant_pending";
  } else if (!subscriptionSnap.exists) {
    validationError = "لم يتم العثور على اشتراك التاجر.";
    status = "unsubscribed";
  } else if (!subscriptionStatusActive) {
    validationError = "لا يوجد اشتراك نشط لهذا التاجر.";
    status = status || "inactive";
  } else if (captainLimit <= 0) {
    validationError = "الباقة الحالية لا تسمح بطلب الكباتن.";
  } else if (expiryEffectiveMs !== null && nowMs > expiryEffectiveMs) {
    validationError = "انتهت فترة اشتراكك، يرجى تجديد الاشتراك.";
    status = "expired";
  } else {
    try {
      assertMerchantAndSubscriptionValid(merchantId, merchant, subscription, nowMs);
    } catch (err) {
      validationError = err instanceof Error ? err.message : "الاشتراك غير صالح حالياً.";
      if (!status) status = "inactive";
    }
  }
  const isActive = validationError === "";
  const remainingCaptains = Math.max(0, captainLimit - activeCaptainsCount);
  const requested = Math.max(
    MIN_PACKAGE_CAPTAINS,
    Math.min(MAX_PACKAGE_CAPTAINS, Math.floor(Number(requestedCaptains) || 1))
  );
  const capacityAllowed = activeCaptainsCount + requested <= captainLimit;
  const remainingMillis = expiryEffectiveMs !== null ? Math.max(0, expiryEffectiveMs - nowMs) : 0;
  const errorMessage = validationError || (capacityAllowed ? undefined :
    activeCaptainsCount >= captainLimit
      ? `وصلت إلى الحد الأقصى لعدد الكباتن المتزامنين في باقتك (${captainLimit}).`
      : `المتبقي لك ${remainingCaptains} كابتن فقط من أصل ${captainLimit} في باقتك الحالية.`);
  return {
    merchantId,
    isValid: isActive && capacityAllowed,
    allowed: isActive && capacityAllowed,
    isActive,
    isSubscribed: isActive,
    status: status || (isActive ? "active" : "unsubscribed"),
    subscriptionStatus: status || (isActive ? "active" : "unsubscribed"),
    planId,
    planKey: planKey || undefined,
    packageId: planKey || undefined,
    planName,
    maxCaptains: captainLimit,
    captainLimit,
    price,
    startDate: startDateMs,
    activatedAt: startDateMs,
    endDate: endDateMs,
    expiresAt: endDateMs,
    remainingMillis,
    remainingDays: Math.floor(remainingMillis / 86_400_000),
    remainingHours: Math.floor(remainingMillis / 3_600_000),
    activeCaptainsCount,
    remainingCaptains,
    subscriptionVersion: readNumber(subscription, "subscriptionVersion") ??
      readNumber(merchant, "subscriptionVersion") ?? 1,
    updatedBy: readString(subscription, "updatedBy", "updatedByAdminUid") ||
      readString(merchant, "updatedBy") || undefined,
    paymentStatus: readString(subscription, "paymentStatus") ||
      readString(merchant, "paymentStatus") || (isActive ? "paid" : "unpaid"),
    paymentMethod: readString(subscription, "paymentMethod") ||
      readString(merchant, "paymentMethod") || undefined,
    errorMessage,
    reason: errorMessage,
    serverTimeMs: nowMs,
  };
}

export const getMerchantSubscription = onCall({region: "us-central1"}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً.");
  if (request.auth?.token.email_verified !== true) {
    throw new HttpsError("failed-precondition", "يجب تأكيد البريد الإلكتروني أولاً.");
  }
  const merchantId = readString((request.data ?? {}) as Record<string, unknown>, "merchantId");
  if (merchantId && merchantId !== uid) {
    throw new HttpsError("permission-denied", "غير مسموح بالوصول لاشتراك تاجر آخر.");
  }
  return buildMerchantSubscriptionResponse(uid);
});

export const validateMerchantSubscription = onCall({region: "us-central1"}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً.");
  if (request.auth?.token.email_verified !== true) {
    throw new HttpsError("failed-precondition", "يجب تأكيد البريد الإلكتروني أولاً.");
  }
  const payload = (request.data ?? {}) as Record<string, unknown>;
  return buildMerchantSubscriptionResponse(uid, payload.requestedCaptains as number);
});

/**
 * Merchant creates an order with a globally unique 6-digit code.
 * The code, idempotency key, capacity check, and order document are committed atomically.
 * Dispatch is performed only by the server-side order-created trigger.
 */
export const merchantCreateOrder = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const uid = request.auth?.uid;
      if (!uid) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً.");
      if (request.auth?.token.email_verified !== true) {
        throw new HttpsError("permission-denied", "يجب تأكيد البريد الإلكتروني قبل إنشاء الطلب.");
      }

      const data = (request.data ?? {}) as Record<string, unknown>;
      const idempotencyKey = readString(data, "idempotencyKey");
      if (
        idempotencyKey.length < 16 ||
        idempotencyKey.length > 128 ||
        !/^[A-Za-z0-9_-]+$/.test(idempotencyKey)
      ) {
        throw new HttpsError("invalid-argument", "مفتاح منع تكرار الطلب غير صالح.");
      }

      const destinationAddress = readString(data, "destinationAddress", "deliveryAddress", "address");
      if (!destinationAddress || destinationAddress.length > 1000) {
        throw new HttpsError("invalid-argument", "عنوان التوصيل مطلوب ويجب ألا يتجاوز 1000 حرف.");
      }

      const customerName = readString(data, "customerName").slice(0, 200);
      const customerPhone = readString(data, "customerPhone").slice(0, 40);
      const orderDetails = readString(data, "orderDetails", "items").slice(0, 4000);
      const deliveryNotes = readString(data, "deliveryNotes", "notes").slice(0, 1000);
      // The merchant app is the only client allowed to enter the delivery fee.
      // Preserve the merchant-entered text for display and store a numeric EGP value
      // for dispatch, reporting, and server-side settlement. Never invent a fee.
      const serviceFee = readString(data, "serviceFee", "price");
      if (!serviceFee) {
        throw new HttpsError("invalid-argument", "يرجى إدخال قيمة خدمة التوصيل من تطبيق التاجر.");
      }
      const feeMatch = serviceFee.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
      if (!feeMatch) {
        throw new HttpsError("invalid-argument", "قيمة خدمة التوصيل يجب أن تحتوي على مبلغ رقمي واضح.");
      }
      const deliveryFee = Number(feeMatch[0]);
      if (!Number.isFinite(deliveryFee) || deliveryFee < 0 || deliveryFee > 100000) {
        throw new HttpsError("invalid-argument", "قيمة خدمة التوصيل غير صالحة.");
      }

      const customerLatitude = readNumber(data, "customerLatitude");
      const customerLongitude = readNumber(data, "customerLongitude");
      if (
        (customerLatitude === null) !== (customerLongitude === null) ||
        (customerLatitude !== null &&
          (customerLatitude < -90 || customerLatitude > 90 ||
           customerLongitude! < -180 || customerLongitude! > 180 ||
           (customerLatitude === 0 && customerLongitude === 0)))
      ) {
        throw new HttpsError("invalid-argument", "إحداثيات عنوان العميل غير صالحة.");
      }

      const db = getFirestore();
      const merchantRef = db.collection("merchants").doc(uid);
      const subscriptionRef = db.collection("subscriptions").doc(uid);
      const idempotencyRef = db.collection("idempotency_keys").doc(idempotencyKey);
      const ordersRef = db.collection("orders");
      const capacityRef = merchantRef.collection("capacity").doc("current");
      const merchantOrdersQueries = [
        ordersRef.where("merchantId", "==", uid),
        ordersRef.where("restaurantId", "==", uid),
        ordersRef.where("userId", "==", uid),
      ];

      const replaySnap = await idempotencyRef.get();
      if (replaySnap.exists) {
        const replay = replaySnap.data() ?? {};
        if (readString(replay, "merchantId") !== uid) {
          throw new HttpsError("permission-denied", "مفتاح الطلب مستخدم لحساب آخر.");
        }
        return {
          success: true,
          orderId: readString(replay, "orderId"),
          orderCode: readString(replay, "orderCode"),
          status: "pending",
          captainLimit: 0,
          activeCaptainsCount: 0,
          remainingCaptains: 0,
          planId: 0,
          planName: "",
          subscriptionVersion: 1,
          isReplay: true,
        };
      }

      const MAX_CODE_ATTEMPTS = 25;
      for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
        const orderCode = generateDistinctOrderCode();
        const orderRef = ordersRef.doc();
        const codeRef = db.collection("order_codes").doc(orderCode);
        const nowMs = Date.now();

        try {
          const result = await db.runTransaction(async (tx) => {
            const [
              merchantSnap,
              subscriptionSnap,
              codeSnap,
              keySnap,
              ordersByMerchantSnap,
              ordersByRestaurantSnap,
              ordersByUserSnap,
              capacitySnap,
            ] = await Promise.all([
              tx.get(merchantRef),
              tx.get(subscriptionRef),
              tx.get(codeRef),
              tx.get(idempotencyRef),
              tx.get(merchantOrdersQueries[0]),
              tx.get(merchantOrdersQueries[1]),
              tx.get(merchantOrdersQueries[2]),
              tx.get(capacityRef),
            ]);

            if (keySnap.exists) {
              const keyData = keySnap.data() ?? {};
              if (readString(keyData, "merchantId") !== uid) {
                throw new HttpsError("permission-denied", "مفتاح الطلب مستخدم لحساب آخر.");
              }
              return {
                replay: true,
                orderId: readString(keyData, "orderId"),
                orderCode: readString(keyData, "orderCode"),
                maxCaptains: 0,
                activeCaptainsCount: 0,
                remainingCaptains: 0,
                planId: 0,
                planName: "",
                subscriptionVersion: 1,
              };
            }

            if (!merchantSnap.exists || !subscriptionSnap.exists) {
              throw new HttpsError(
                "failed-precondition",
                "ملف التاجر أو سجل الاشتراك غير موجود؛ لا يمكن إنشاء الطلب."
              );
            }
            const merchant = merchantSnap.data() ?? {};
            const subscription = subscriptionSnap.data() ?? {};
            if (
              readString(merchant, "accountType").toLowerCase() !== "merchant" ||
              !["approved", "active"].includes(readString(merchant, "status").toLowerCase())
            ) {
              throw new HttpsError("permission-denied", "حساب التاجر غير معتمد أو غير نشط.");
            }
            assertMerchantAndSubscriptionValid(uid, merchant, subscription, nowMs);

            const maxCaptains = resolveEffectiveCaptainLimit(merchant, subscription);
            if (maxCaptains < MIN_PACKAGE_CAPTAINS || maxCaptains > MAX_PACKAGE_CAPTAINS) {
              throw new HttpsError("failed-precondition", "لا توجد باقة نشطة تسمح بطلب الكباتن.");
            }

            // Reconcile supported owner fields and deduplicate orders. The shared capacity
            // document is read and written in this transaction to serialize concurrent requests.
            const activeOrderIds = new Set<string>();
            for (const snapshot of [
              ordersByMerchantSnap,
              ordersByRestaurantSnap,
              ordersByUserSnap,
            ]) {
              for (const orderDoc of snapshot.docs) {
                if (!isClosedMerchantOrderStatus(
                  readNormalizedOrderStatus(orderDoc.data() ?? {})
                )) activeOrderIds.add(orderDoc.id);
              }
            }
            const capacityData = capacitySnap.data() ?? {};
            const capacityVersion = readNumber(capacityData, "capacityVersion") ?? 0;
            const activeOrderCount = activeOrderIds.size;
            if (activeOrderCount >= maxCaptains) {
              throw new HttpsError(
                "resource-exhausted",
                `وصلت إلى الحد المتزامن للباقة: ${activeOrderCount} من ${maxCaptains} طلبات نشطة.`
              );
            }

            if (codeSnap.exists) {
              throw new Error("ORDER_CODE_COLLISION");
            }

            const pickup = extractCoordinates(merchant);
            if (!pickup) {
              throw new HttpsError(
                "failed-precondition",
                "يرجى تحديد موقع المتجر وتحديث إحداثياته قبل طلب كابتن."
              );
            }

            const merchantName = readString(merchant, "name", "merchantName").trim();
            const merchantPhone = readString(merchant, "phone", "phoneNumber", "mobile").trim();
            const merchantImageCandidates = [
              readString(merchant, "logo"),
              readString(merchant, "photoUrl"),
              readString(merchant, "logoUrl"),
              readString(merchant, "imageUrl"),
              readString(merchant, "profileImageUrl"),
            ];
            const storeImage = merchantImageCandidates.find((value) => /^https?:\/\//i.test(value)) || "";
            const imagePathCandidates = [
              readString(merchant, "storagePath"),
              readString(merchant, "profileImagePath"),
              readString(merchant, "logoStoragePath"),
              ...merchantImageCandidates,
            ];
            const storeImagePath = imagePathCandidates.find((value) =>
              value.startsWith("gs://") || value.startsWith(`merchants/${uid}/`)
            ) || "";
            if (!merchantName) {
              throw new HttpsError("failed-precondition", "اسم التاجر غير مسجل في ملف المتجر.");
            }
            if (!merchantPhone) {
              throw new HttpsError("failed-precondition", "يرجى تسجيل رقم الهاتف الحقيقي في ملف التاجر قبل طلب كابتن.");
            }
            if (!storeImage && !storeImagePath) {
              throw new HttpsError("failed-precondition", "يرجى رفع صورة المتجر إلى ملف التاجر قبل طلب كابتن.");
            }
            const pickupAddress = readString(merchant, "address", "pickupAddress");
            const merchantPoint = new GeoPoint(pickup.lat, pickup.lng);
            const orderNumber = `#ELB-${orderCode}`;
            const orderPayload: Record<string, unknown> = {
              orderId: orderRef.id,
              orderNumber,
              orderCode,
              code: orderCode,
              order_code: orderCode,
              address: destinationAddress,
              destinationAddress,
              deliveryAddress: destinationAddress,
              price: serviceFee,
              totalAmount: serviceFee,
              serviceFee,
              deliveryFee,
              delivery_fee: deliveryFee,
              captainEarning: deliveryFee,
              customerName,
              customerPhone,
              orderDetails,
              items: orderDetails,
              itemsSummary: orderDetails || "طلب توصيل جديد",
              itemsCount: 1,
              orderTotalAmount: deliveryFee,
              deliveryNotes,
              notes: deliveryNotes,
              status: "pending",
              dispatchStatus: "searching",
              merchantId: uid,
              restaurantId: uid,
              userId: uid,
              merchantName,
              restaurantName: merchantName,
              storeName: merchantName,
              merchantPhone,
              storePhone: merchantPhone,
              merchantLogo: storeImage,
              merchantImageUrl: storeImage,
              storeImage,
              storeImagePath,
              merchantStoragePath: storeImagePath,
              merchantLocation: merchantPoint,
              pickupLocation: merchantPoint,
              pickupLat: pickup.lat,
              pickupLng: pickup.lng,
              restaurantLatitude: pickup.lat,
              restaurantLongitude: pickup.lng,
              pickupAddress,
              storeAddress: pickupAddress,
              captainId: null,
              driverId: null,
              offeredCaptainId: null,
              offeredCaptainName: null,
              offerGeneration: 0,
              offerExpiresAt: null,
              excludedCaptainIds: [],
              timedOutCaptainIds: [],
              customerDetailsSubmitted: false,
              customerDetailsConfirmed: false,
              customerDetailsRejected: false,
              merchantConfirmed: false,
              dispatchedBy: "merchant",
              dispatchAuthority: "dashboard_functions",
              createdByServerFunction: "merchantCreateOrder",
              createdAt: FieldValue.serverTimestamp(),
              created_at: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            };
            if (customerLatitude !== null && customerLongitude !== null) {
              const customerPoint = new GeoPoint(customerLatitude, customerLongitude);
              orderPayload.customerLocation = customerPoint;
              orderPayload.customerLatitude = customerLatitude;
              orderPayload.customerLongitude = customerLongitude;
            }

            tx.create(codeRef, {
              code: orderCode,
              orderCode,
              orderId: orderRef.id,
              merchantId: uid,
              createdAt: FieldValue.serverTimestamp(),
            });
            tx.create(idempotencyRef, {
              idempotencyKey,
              orderId: orderRef.id,
              orderCode,
              merchantId: uid,
              createdAt: FieldValue.serverTimestamp(),
            });
            tx.create(orderRef, orderPayload);
            const nextReservedOrderIds = [...activeOrderIds, orderRef.id];
            tx.set(capacityRef, {
              merchantId: uid,
              reservedOrderIds: nextReservedOrderIds,
              activeReservationsCount: nextReservedOrderIds.length,
              captainLimitSnapshot: maxCaptains,
              capacityVersion: capacityVersion + 1,
              lastReservedOrderId: orderRef.id,
              updatedAt: FieldValue.serverTimestamp(),
            }, {merge: true});

            const resolvedPlan = resolveCanonicalPlanIdentifier(merchant, subscription);
            return {
              replay: false,
              orderId: orderRef.id,
              orderCode,
              maxCaptains,
              activeCaptainsCount: activeOrderCount + 1,
              remainingCaptains: Math.max(0, maxCaptains - activeOrderCount - 1),
              planId: resolvedPlan.planId,
              planKey: resolvedPlan.planKey,
              planName: readString(subscription, "planName", "packageName", "name") ||
                readString(merchant, "planName", "packageName"),
              subscriptionVersion: readNumber(subscription, "subscriptionVersion") ?? 1,
            };
          });

          return {
            success: true,
            orderId: result.orderId,
            orderCode: result.orderCode,
            orderNumber: `#ELB-${result.orderCode}`,
            status: "pending",
            dispatchStatus: result.replay ? "existing" : "searching",
            captainLimit: result.maxCaptains,
            activeCaptainsCount: result.activeCaptainsCount,
            remainingCaptains: result.remainingCaptains,
            planId: result.planId,
            planKey: result.planKey || undefined,
            planName: result.planName,
            subscriptionVersion: result.subscriptionVersion,
            isReplay: result.replay,
          };
        } catch (err) {
          if (err instanceof Error && err.message === "ORDER_CODE_COLLISION") {
            continue;
          }
          throw err;
        }
      }

      throw new HttpsError(
        "resource-exhausted",
        "تعذر تخصيص كود طلب فريد بعد عدة محاولات. يرجى إعادة المحاولة."
      );
    } catch (err) {
      throw mapError(err);
    }
  }
);

/** Backward-compatible merchant Android callable names. */
export const requestCaptains = merchantCreateOrder;
export const createOrderWithCode = merchantCreateOrder;

/**
 * Merchant cancels an order before it is picked up. Any matching offer/trip reservation
 * is released in the same transaction so the captain becomes eligible again.
 */
export const merchantCancelOrder = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const uid = request.auth?.uid;
      if (!uid) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً.");
      if (request.auth?.token.email_verified !== true) {
        throw new HttpsError("permission-denied", "يجب تأكيد البريد الإلكتروني أولاً.");
      }

      const orderId = requireOrderId((request.data ?? {}).orderId);
      const reason = readString(request.data as Record<string, unknown>, "reason").slice(0, 500);
      const db = getFirestore();
      const orderRef = db.collection("orders").doc(orderId);
      const merchantRef = db.collection("merchants").doc(uid);
      const [merchantSnap] = await Promise.all([merchantRef.get()]);
      const merchant = merchantSnap.data() ?? {};
      if (
        !merchantSnap.exists ||
        readString(merchant, "accountType").toLowerCase() !== "merchant" ||
        !["approved", "active"].includes(readString(merchant, "status").toLowerCase())
      ) {
        throw new HttpsError("permission-denied", "حساب التاجر غير مؤهل لإلغاء الطلب.");
      }

      const result = await db.runTransaction(async (tx) => {
        const orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists) throw new HttpsError("not-found", "الطلب غير موجود.");
        const order = orderSnap.data() ?? {};
        if (readString(order, "merchantId", "restaurantId", "userId") !== uid) {
          throw new HttpsError("permission-denied", "هذا الطلب لا يخص متجرك.");
        }
        const status = readNormalizedOrderStatus(order);
        if (["picked_up", "order_data_entered", "awaiting_merchant_confirmation",
          "awaiting_confirmation", "merchant_rejected", "en_route", "confirmed",
          "merchant_confirmed", "out_for_delivery", "delivering", "delivered",
          "completed", "done"].includes(status)) {
          throw new HttpsError(
            "failed-precondition",
            "لا يمكن إلغاء الطلب بعد استلامه من المتجر أو بدء توصيله."
          );
        }
        if (["cancelled", "canceled"].includes(status)) {
          return {alreadyCancelled: true};
        }

        const offeredUid = readString(order, "offeredCaptainId");
        const assignedUid = extractOrderCaptainUid(order);
        const captainIds = Array.from(new Set([offeredUid, assignedUid].filter(Boolean)));
        const captainRefs = captainIds.map((captainId) => db.collection("captains").doc(captainId));
        const captainSnaps = await Promise.all(captainRefs.map((ref) => tx.get(ref)));

        captainSnaps.forEach((snap, index) => {
          if (!snap.exists) return;
          const captain = snap.data() ?? {};
          const patch: Record<string, unknown> = {};
          if (readString(captain, "currentOrderId") === orderId) {
            patch.currentOrderId = null;
            patch.activeMerchantId = FieldValue.delete();
            patch.currentMerchantId = FieldValue.delete();
            if (readString(captain, "presenceStatus") === "on_trip") {
              patch.presenceStatus = "available";
            }
            if (readString(captain, "availabilityStatus") === "on_trip") {
              patch.availabilityStatus = "available";
            }
          }
          if (readString(captain, "activeOfferOrderId") === orderId) {
            patch.activeOfferOrderId = null;
            patch.activeOfferGeneration = null;
            patch.activeOfferExpiresAt = null;
          }
          if (Object.keys(patch).length > 0) {
            patch.updatedAt = FieldValue.serverTimestamp();
            tx.update(captainRefs[index], patch);
          }
        });

        tx.update(orderRef, {
          status: "cancelled",
          dispatchStatus: "cancelled",
          offeredCaptainId: null,
          offeredCaptainName: null,
          offerExpiresAt: null,
          cancelledAt: FieldValue.serverTimestamp(),
          cancelledBy: uid,
          cancellationReason: reason || "إلغاء من قبل التاجر",
          status_ar: "ملغي",
          updatedAt: FieldValue.serverTimestamp(),
        });
        return {alreadyCancelled: false};
      });

      return {success: true, orderId, ...result};
    } catch (err) {
      throw mapError(err);
    }
  }
);


/**
 * Merchant edits delivery details and the merchant-entered fee only while the order
 * is still searching and has not been offered or assigned to a captain.
 */
export const merchantUpdateOrderDetails = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const uid = request.auth?.uid;
      if (!uid) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً.");
      if (request.auth?.token.email_verified !== true) {
        throw new HttpsError("permission-denied", "يجب تأكيد البريد الإلكتروني أولاً.");
      }

      const data = (request.data ?? {}) as Record<string, unknown>;
      const orderId = requireOrderId(data.orderId);
      const destinationAddress = readString(data, "destinationAddress", "deliveryAddress", "address");
      const orderDetails = readString(data, "orderDetails", "items").slice(0, 4000);
      const customerName = readString(data, "customerName").slice(0, 200);
      const customerPhone = readString(data, "customerPhone").slice(0, 40);
      const deliveryNotes = readString(data, "deliveryNotes", "notes").slice(0, 1000);
      const serviceFee = readString(data, "serviceFee", "price");
      if (!destinationAddress || destinationAddress.length > 1000) {
        throw new HttpsError("invalid-argument", "عنوان التوصيل مطلوب ويجب ألا يتجاوز 1000 حرف.");
      }
      if (!serviceFee) {
        throw new HttpsError("invalid-argument", "يرجى إدخال قيمة خدمة التوصيل من تطبيق التاجر.");
      }
      const feeMatch = serviceFee.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
      if (!feeMatch) {
        throw new HttpsError("invalid-argument", "قيمة خدمة التوصيل يجب أن تحتوي على مبلغ رقمي واضح.");
      }
      const deliveryFee = Number(feeMatch[0]);
      if (!Number.isFinite(deliveryFee) || deliveryFee < 0 || deliveryFee > 100000) {
        throw new HttpsError("invalid-argument", "قيمة خدمة التوصيل غير صالحة.");
      }

      const db = getFirestore();
      const merchantSnap = await db.collection("merchants").doc(uid).get();
      const merchant = merchantSnap.data() ?? {};
      if (
        !merchantSnap.exists ||
        readString(merchant, "accountType").toLowerCase() !== "merchant" ||
        !["approved", "active"].includes(readString(merchant, "status").toLowerCase())
      ) {
        throw new HttpsError("permission-denied", "حساب التاجر غير مؤهل لتعديل الطلب.");
      }

      const orderRef = db.collection("orders").doc(orderId);
      await db.runTransaction(async (tx) => {
        const orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists) throw new HttpsError("not-found", "الطلب غير موجود.");
        const order = orderSnap.data() ?? {};
        if (readString(order, "merchantId", "restaurantId", "userId") !== uid) {
          throw new HttpsError("permission-denied", "هذا الطلب لا يخص متجرك.");
        }

        const status = readNormalizedOrderStatus(order);
        const assignedCaptainId = extractOrderCaptainUid(order);
        const offeredCaptainId = readString(order, "offeredCaptainId");
        if (
          assignedCaptainId ||
          offeredCaptainId ||
          !["pending", "searching"].includes(status)
        ) {
          throw new HttpsError(
            "failed-precondition",
            "لا يمكن تعديل الرسوم أو بيانات الطلب بعد إرسال العرض إلى كابتن أو بدء التنفيذ."
          );
        }

        tx.update(orderRef, {
          address: destinationAddress,
          destinationAddress,
          deliveryAddress: destinationAddress,
          orderDetails,
          items: orderDetails,
          customerName,
          customerPhone,
          deliveryNotes,
          notes: deliveryNotes,
          price: serviceFee,
          serviceFee,
          totalAmount: serviceFee,
          deliveryFee,
          delivery_fee: deliveryFee,
          captainEarning: deliveryFee,
          updatedAt: FieldValue.serverTimestamp(),
          merchantEditedAt: FieldValue.serverTimestamp(),
          merchantEditedBy: uid,
        });
      });

      return {success: true, orderId, serviceFee, deliveryFee};
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Admin creates an unassigned order. The created document is the source of truth;
 * the Firestore create trigger dispatches it to an eligible captain.
 */
export const adminCreateOrder = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const adminUid = await requireAdminUid(
        request.auth?.uid,
        (request.auth?.token ?? {}) as Record<string, unknown>
      );
      const data = (request.data ?? {}) as Record<string, unknown>;
      const merchantId = String(
        data.merchantId ?? data.restaurantId ?? ""
      ).trim();
      if (!merchantId || merchantId.length > 128 || merchantId.includes("/")) {
        throw new HttpsError("invalid-argument", "يجب تحديد التاجر الصحيح.");
      }

      const deliveryAddress = readString(data, "deliveryAddress", "customerAddress");
      if (!deliveryAddress) {
        throw new HttpsError("invalid-argument", "عنوان العميل مطلوب.");
      }

      const db = getFirestore();
      const [merchantSnap, restaurantSnap, subscriptionSnap] = await Promise.all([
        db.collection("merchants").doc(merchantId).get(),
        db.collection("restaurants").doc(merchantId).get(),
        db.collection("subscriptions").doc(merchantId).get(),
      ]);
      const merchantData = merchantSnap.exists
        ? merchantSnap.data()
        : restaurantSnap.exists
          ? restaurantSnap.data()
          : undefined;
      if (!merchantData || !subscriptionSnap.exists) {
        throw new HttpsError(
          "failed-precondition",
          "ملف التاجر أو سجل الاشتراك غير موجود."
        );
      }
      const merchantStatus = readString(merchantData, "status").toLowerCase();
      if (!["approved", "active"].includes(merchantStatus)) {
        throw new HttpsError("failed-precondition", "حساب التاجر غير معتمد أو غير نشط.");
      }
      assertMerchantAndSubscriptionValid(
        merchantId,
        merchantData,
        subscriptionSnap.data(),
        Date.now()
      );

      const pickup = extractCoordinates(merchantData);
      if (!pickup) {
        throw new HttpsError(
          "failed-precondition",
          "موقع التاجر غير مكتمل. حدّث إحداثيات المتجر قبل إرسال الطلب."
        );
      }

      const deliveryFee = readNumber(data, "deliveryFee") ?? 0;
      const subtotal = readNumber(data, "subtotal") ?? 0;
      const total = readNumber(data, "total") ?? subtotal + deliveryFee;
      if (
        deliveryFee < 0 || subtotal < 0 || total < 0 ||
        !Number.isFinite(deliveryFee + subtotal + total)
      ) {
        throw new HttpsError("invalid-argument", "قيم الطلب المالية غير صالحة.");
      }

      const itemsRaw = Array.isArray(data.items) ? data.items : [];
      if (itemsRaw.length > 100) {
        throw new HttpsError("invalid-argument", "عدد عناصر الطلب أكبر من الحد المسموح.");
      }
      const items = itemsRaw.map((raw) => {
        const item = (raw ?? {}) as Record<string, unknown>;
        const name = readString(item, "name", "title");
        const quantity = readNumber(item, "quantity") ?? 1;
        const price = readNumber(item, "price") ?? 0;
        if (!name || quantity <= 0 || quantity > 999 || price < 0) {
          throw new HttpsError("invalid-argument", "أحد عناصر الطلب يحتوي على بيانات غير صالحة.");
        }
        return {name: name.slice(0, 200), quantity, price};
      });

      const requestedCaptainId = readString(data, "captainId", "requestedCaptainId");
      if (requestedCaptainId && requestedCaptainId.length > 128) {
        throw new HttpsError("invalid-argument", "معرف الكابتن غير صالح.");
      }

      const merchantRef = db.collection("merchants").doc(merchantId);
      const restaurantRef = db.collection("restaurants").doc(merchantId);
      const subscriptionRef = db.collection("subscriptions").doc(merchantId);
      const capacityRef = merchantRef.collection("capacity").doc("current");
      const ordersRef = db.collection("orders");
      const merchantOrderQueries = [
        ordersRef.where("merchantId", "==", merchantId),
        ordersRef.where("restaurantId", "==", merchantId),
        ordersRef.where("userId", "==", merchantId),
      ];
      const merchantName = readString(merchantData, "name", "merchantName", "restaurantName");
      const merchantPhone = readString(merchantData, "phone", "phoneNumber", "mobile");
      const imageCandidates = [
        readString(merchantData, "logo"),
        readString(merchantData, "photoUrl"),
        readString(merchantData, "logoUrl"),
        readString(merchantData, "imageUrl"),
        readString(merchantData, "profileImageUrl"),
      ];
      const storeImage = imageCandidates.find((value) =>
        value.startsWith("https://") || value.startsWith("http://")
      ) || "";
      const storeImagePath = [
        readString(merchantData, "storagePath"),
        readString(merchantData, "profileImagePath"),
        readString(merchantData, "logoStoragePath"),
        ...imageCandidates,
      ].find((value) =>
        value.startsWith("gs://") || value.startsWith(`merchants/${merchantId}/`)
      ) || "";
      const pickupAddress = readString(merchantData, "address", "pickupAddress", "storeAddress");
      if (!merchantName || !merchantPhone || (!storeImage && !storeImagePath)) {
        throw new HttpsError("failed-precondition", "بيانات اسم التاجر أو هاتفه أو صورة المتجر غير مكتملة.");
      }

      const idempotencyKey = readString(data, "idempotencyKey");
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
        throw new HttpsError("invalid-argument", "مفتاح منع التكرار غير صالح.");
      }
      const idempotencyRef = db.collection("admin_order_idempotency").doc(idempotencyKey);
      const previousRequest = await idempotencyRef.get();
      if (previousRequest.exists) {
        const previous = previousRequest.data() ?? {};
        if (readString(previous, "merchantId") !== merchantId) {
          throw new HttpsError("permission-denied", "مفتاح الطلب مستخدم لحساب آخر.");
        }
        const previousCode = readString(previous, "orderCode");
        return {
          success: true,
          orderId: readString(previous, "orderId"),
          orderCode: previousCode,
          orderNumber: `#ELB-${previousCode}`,
          status: "pending",
          dispatchStatus: "existing",
          isReplay: true,
        };
      }

      const MAX_CODE_ATTEMPTS = 25;
      for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
        const orderCode = generateDistinctOrderCode();
        const orderRef = ordersRef.doc();
        const codeRef = db.collection("order_codes").doc(orderCode);
        try {
          await db.runTransaction(async (tx) => {
            const [
              currentMerchantSnap,
              currentRestaurantSnap,
              currentSubscriptionSnap,
              codeSnap,
              keySnap,
              merchantOrdersSnap,
              restaurantOrdersSnap,
              userOrdersSnap,
              capacitySnap,
            ] = await Promise.all([
              tx.get(merchantRef),
              tx.get(restaurantRef),
              tx.get(subscriptionRef),
              tx.get(codeRef),
              tx.get(idempotencyRef),
              tx.get(merchantOrderQueries[0]),
              tx.get(merchantOrderQueries[1]),
              tx.get(merchantOrderQueries[2]),
              tx.get(capacityRef),
            ]);
            if (keySnap.exists) {
              const previous = keySnap.data() ?? {};
              if (readString(previous, "merchantId") !== merchantId) {
                throw new HttpsError("permission-denied", "مفتاح الطلب مستخدم لحساب آخر.");
              }
              return;
            }
            if ((!currentMerchantSnap.exists && !currentRestaurantSnap.exists) || !currentSubscriptionSnap.exists) {
              throw new HttpsError("failed-precondition", "ملف التاجر أو الاشتراك غير موجود.");
            }
            const currentMerchant = currentMerchantSnap.exists
              ? currentMerchantSnap.data() ?? {}
              : currentRestaurantSnap.data() ?? {};
            const currentSubscription = currentSubscriptionSnap.data() ?? {};
            assertMerchantAndSubscriptionValid(merchantId, currentMerchant, currentSubscription, Date.now());
            if (codeSnap.exists) throw new Error("ORDER_CODE_COLLISION");

            const maxCaptains = resolveEffectiveCaptainLimit(currentMerchant, currentSubscription);
            if (maxCaptains < MIN_PACKAGE_CAPTAINS || maxCaptains > MAX_PACKAGE_CAPTAINS) {
              throw new HttpsError("failed-precondition", "باقة التاجر لا تحتوي على حد كباتن صالح (1 إلى 100).");
            }

            const activeOrderIds = new Set<string>();
            for (const snapshot of [merchantOrdersSnap, restaurantOrdersSnap, userOrdersSnap]) {
              for (const orderDoc of snapshot.docs) {
                if (!isTerminalMerchantOrderStatus(readNormalizedOrderStatus(orderDoc.data() ?? {}))) {
                  activeOrderIds.add(orderDoc.id);
                }
              }
            }
            const activeOrderCount = activeOrderIds.size;
            if (activeOrderCount >= maxCaptains) {
              throw new HttpsError(
                "resource-exhausted",
                `وصل التاجر إلى الحد المتزامن للباقة: ${activeOrderCount} من ${maxCaptains} طلبات نشطة.`
              );
            }

            const capacityVersion = readNumber(capacitySnap.data() ?? {}, "capacityVersion") ?? 0;
            const orderNumber = `#ELB-${orderCode}`;
            tx.create(codeRef, {
              code: orderCode,
              orderCode,
              orderId: orderRef.id,
              merchantId,
              createdAt: FieldValue.serverTimestamp(),
            });
            tx.create(idempotencyRef, {
              idempotencyKey,
              orderId: orderRef.id,
              orderCode,
              merchantId,
              createdAt: FieldValue.serverTimestamp(),
            });
            tx.create(orderRef, {
              orderNumber,
              orderCode,
              order_code: orderCode,
              order_codes: orderCode,
              merchantId,
              restaurantId: merchantId,
              userId: merchantId,
              merchantName,
              restaurantName: merchantName,
              storeName: merchantName,
              merchantPhone,
              storePhone: merchantPhone,
              merchantLogo: storeImage,
              merchantImageUrl: storeImage,
              storeImage,
              storeImagePath,
              merchantStoragePath: storeImagePath,
              pickupLat: pickup.lat,
              pickupLng: pickup.lng,
              restaurantLatitude: pickup.lat,
              restaurantLongitude: pickup.lng,
              pickupAddress,
              storeAddress: pickupAddress,
              deliveryAddress: deliveryAddress.slice(0, 1000),
              customerName: readString(data, "customerName").slice(0, 200),
              customerPhone: readString(data, "customerPhone").slice(0, 40),
              deliveryFee,
              delivery_fee: deliveryFee,
              subtotal,
              total,
              items,
              notes: readString(data, "notes").slice(0, 1000),
              status: "pending",
              dispatchStatus: "searching",
              dispatchAuthority: "dashboard_functions",
              createdByServerFunction: "adminCreateOrder",
              captainId: null,
              driverId: null,
              offeredCaptainId: null,
              offerGeneration: 0,
              offerExpiresAt: null,
              excludedCaptainIds: [],
              timedOutCaptainIds: [],
              requestedCaptainId: requestedCaptainId || null,
              dispatchedBy: adminUid,
              createdAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            });
            const reservedOrderIds = [...activeOrderIds, orderRef.id];
            tx.set(capacityRef, {
              merchantId,
              reservedOrderIds,
              activeReservationsCount: reservedOrderIds.length,
              captainLimitSnapshot: maxCaptains,
              capacityVersion: capacityVersion + 1,
              lastReservedOrderId: orderRef.id,
              updatedAt: FieldValue.serverTimestamp(),
            }, {merge: true});
          });
          const codeAfter = await codeRef.get();
          if (!codeAfter.exists) {
            const replay = await idempotencyRef.get();
            if (replay.exists) {
              const previous = replay.data() ?? {};
              const previousCode = readString(previous, "orderCode");
              return {
                success: true,
                orderId: readString(previous, "orderId"),
                orderCode: previousCode,
                orderNumber: `#ELB-${previousCode}`,
                status: "pending",
                dispatchStatus: "existing",
                isReplay: true,
              };
            }
            throw new HttpsError("aborted", "لم يتم حجز الطلب؛ أعد المحاولة.");
          }
          return {
            success: true,
            orderId: orderRef.id,
            orderCode,
            orderNumber: `#ELB-${orderCode}`,
            status: "pending",
            dispatchStatus: "searching",
            isReplay: false,
          };
        } catch (err) {
          if (err instanceof Error && err.message === "ORDER_CODE_COLLISION") continue;
          throw err;
        }
      }
      throw new HttpsError("resource-exhausted", "تعذر تخصيص كود طلب فريد بعد عدة محاولات.");
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Admin dispatches an existing unassigned order to a specific eligible captain.
 * The captain receives a 60-second offer; assignment is not final until acceptance.
 */
export const adminAssignCaptain = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      await requireAdminUid(
        request.auth?.uid,
        (request.auth?.token ?? {}) as Record<string, unknown>
      );
      const data = (request.data ?? {}) as Record<string, unknown>;
      const orderId = requireOrderId(data.orderId);
      const captainId = typeof data.captainId === "string" ? data.captainId.trim() : "";
      if (!captainId || captainId.length > 128 || captainId.includes("/")) {
        throw new HttpsError("invalid-argument", "يجب تحديد كابتن صالح.");
      }
      const outcome = await service.dispatchNewOrSearchingOrder(orderId, captainId);
      if (outcome.status === "no_captains_available") {
        throw new HttpsError(
          "failed-precondition",
          "الكابتن المحدد غير متاح أو خارج الشفت أو موقعه غير حديث."
        );
      }
      if (outcome.status !== "offered") {
        throw new HttpsError(
          "failed-precondition",
          "لا يمكن تعيين كابتن لهذا الطلب في حالته الحالية."
        );
      }
      return {success: true, ...outcome};
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Admin requests an automatic server-side search for the nearest eligible captain.
 */
export const adminDispatchOrder = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      await requireAdminUid(
        request.auth?.uid,
        (request.auth?.token ?? {}) as Record<string, unknown>
      );
      const data = (request.data ?? {}) as Record<string, unknown>;
      const outcome = await service.dispatchNewOrSearchingOrder(
        requireOrderId(data.orderId)
      );
      if (outcome.status === "no_captains_available") {
        throw new HttpsError(
          "failed-precondition",
          "لا يوجد كابتن متاح حاليًا. سيستمر النظام في البحث."
        );
      }
      if (outcome.status !== "offered") {
        throw new HttpsError(
          "failed-precondition",
          "الطلب ليس متاحًا لبدء توزيع جديد."
        );
      }
      return {success: true, ...outcome};
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Admin cancellation releases any matching offer/current-order reservation.
 */
export const adminCancelOrder = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const adminUid = await requireAdminUid(
        request.auth?.uid,
        (request.auth?.token ?? {}) as Record<string, unknown>
      );
      const data = (request.data ?? {}) as Record<string, unknown>;
      const orderId = requireOrderId(data.orderId);
      const reason = readString(data, "reason").slice(0, 500);
      const db = getFirestore();
      const orderRef = db.collection("orders").doc(orderId);

      const result = await db.runTransaction(async (tx) => {
        const orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists) {
          throw new HttpsError("not-found", "الطلب غير موجود.");
        }
        const order = orderSnap.data() ?? {};
        const status = readNormalizedOrderStatus(order);
        if (["delivered", "completed", "done"].includes(status)) {
          throw new HttpsError("failed-precondition", "لا يمكن إلغاء طلب تم تسليمه.");
        }
        if (["cancelled", "canceled"].includes(status)) {
          return {alreadyCancelled: true};
        }

        const offeredUid = typeof order.offeredCaptainId === "string"
          ? order.offeredCaptainId.trim()
          : "";
        const assignedUid = extractOrderCaptainUid(order);
        const captainIds = Array.from(new Set([offeredUid, assignedUid].filter(Boolean)));
        const captainRefs = captainIds.map((uid) => db.collection("captains").doc(uid));
        const captainSnaps = await Promise.all(captainRefs.map((ref) => tx.get(ref)));

        captainSnaps.forEach((snap, index) => {
          if (!snap.exists) return;
          const captain = snap.data() ?? {};
          const patch: Record<string, unknown> = {};
          if (captain.currentOrderId === orderId) {
            patch.currentOrderId = null;
            patch.activeMerchantId = FieldValue.delete();
            patch.currentMerchantId = FieldValue.delete();
            if (captain.presenceStatus === "on_trip") {
              patch.presenceStatus = "available";
            }
            if (captain.availabilityStatus === "on_trip") {
              patch.availabilityStatus = "available";
            }
          }
          if (captain.activeOfferOrderId === orderId) {
            patch.activeOfferOrderId = null;
            patch.activeOfferGeneration = null;
            patch.activeOfferExpiresAt = null;
          }
          if (Object.keys(patch).length > 0) {
            patch.updatedAt = FieldValue.serverTimestamp();
            tx.update(captainRefs[index], patch);
          }
        });

        tx.update(orderRef, {
          status: "cancelled",
          dispatchStatus: "cancelled",
          offeredCaptainId: null,
          offeredCaptainName: null,
          offerExpiresAt: null,
          cancelledAt: FieldValue.serverTimestamp(),
          cancelledBy: adminUid,
          cancellationReason: reason || "تم الإلغاء بواسطة الإدارة",
          updatedAt: FieldValue.serverTimestamp(),
        });
        return {alreadyCancelled: false};
      });

      return {success: true, orderId, ...result};
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Admin may record a missing audit timestamp only after the server-side lifecycle reached that stage.
 */
export const adminRecordOrderStageTimestamp = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      await requireAdminUid(
        request.auth?.uid,
        (request.auth?.token ?? {}) as Record<string, unknown>
      );
      const data = (request.data ?? {}) as Record<string, unknown>;
      const orderId = requireOrderId(data.orderId);
      const field = readString(data, "field");
      const allowed: Record<string, string[]> = {
        acceptedAt: ["accepted", "assigned", "arrived_at_merchant", "at_store", "picked_up", "en_route", "delivered"],
        arrivedAtMerchantAt: ["arrived_at_merchant", "at_store", "arrived", "picked_up", "en_route", "delivered"],
        pickedUpAt: ["picked_up", "order_data_entered", "awaiting_merchant_confirmation", "en_route", "delivered"],
        deliveredAt: ["delivered", "completed", "done"],
      };
      if (!Object.prototype.hasOwnProperty.call(allowed, field)) {
        throw new HttpsError("invalid-argument", "حقل التوقيت غير مسموح.");
      }

      const db = getFirestore();
      const orderRef = db.collection("orders").doc(orderId);
      const stamp = new Date();
      const iso = stamp.toISOString();
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(orderRef);
        if (!snap.exists) throw new HttpsError("not-found", "الطلب غير موجود.");
        const order = snap.data() ?? {};
        const status = readNormalizedOrderStatus(order);
        if (!allowed[field].includes(status)) {
          throw new HttpsError(
            "failed-precondition",
            "لا يمكن تسجيل هذا التوقيت قبل وصول الطلب إلى المرحلة المقابلة."
          );
        }
        if (order[field]) return {timestamp: order[field], alreadyRecorded: true};
        tx.update(orderRef, {
          [field]: stamp,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return {timestamp: iso, alreadyRecorded: false};
      });
      return {success: true, orderId, ...result};
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Merchant approval/rejection of the captain's submitted receipt and customer details.
 */
export const merchantConfirmOrder = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const uid = request.auth?.uid;
      if (!uid) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً.");
      if (request.auth?.token.email_verified !== true) {
        throw new HttpsError("permission-denied", "يجب تأكيد البريد الإلكتروني لحساب التاجر.");
      }
      const data = (request.data ?? {}) as Record<string, unknown>;
      const orderId = requireOrderId(data.orderId);
      const confirmed = data.confirmed === true;
      const rejectionReason = readString(data, "rejectionReason").slice(0, 500);
      const db = getFirestore();
      const merchantRef = db.collection("merchants").doc(uid);
      const orderRef = db.collection("orders").doc(orderId);
      const merchantSnap = await merchantRef.get();
      if (!merchantSnap.exists) {
        throw new HttpsError("permission-denied", "هذا الحساب ليس حساب تاجر مسجلاً.");
      }
      const merchant = merchantSnap.data() ?? {};
      if (
        (readString(merchant, "accountType").toLowerCase() !== "merchant" &&
          readString(merchant, "role").toLowerCase() !== "merchant") ||
        !["approved", "active"].includes(readString(merchant, "status").toLowerCase())
      ) {
        throw new HttpsError("permission-denied", "حساب التاجر غير مؤهل لاعتماد الطلب.");
      }

      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(orderRef);
        if (!snap.exists) throw new HttpsError("not-found", "الطلب غير موجود.");
        const order = snap.data() ?? {};
        const ownerId = readString(
          order,
          "merchantId",
          "restaurantId",
          "storeId",
          "vendorId",
          "ownerId"
        );
        if (ownerId !== uid) {
          throw new HttpsError("permission-denied", "هذا الطلب لا يخص متجرك.");
        }
        const status = readNormalizedOrderStatus(order);
        if (order.merchantConfirmed === true && confirmed && status === "en_route") {
          return {alreadyUpdated: true, status: "en_route"};
        }
        if (
          status !== "awaiting_merchant_confirmation" &&
          status !== "awaiting_confirmation" &&
          status !== "merchant_rejected"
        ) {
          throw new HttpsError(
            "failed-precondition",
            "الطلب ليس في انتظار مراجعة بيانات العميل والإيصال."
          );
        }
        if (confirmed) {
          tx.update(orderRef, {
            status: "en_route",
            merchantConfirmed: true,
            rejectionReason: FieldValue.delete(),
            merchantConfirmedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          return {alreadyUpdated: false, status: "en_route"};
        }
        tx.update(orderRef, {
          status: "merchant_rejected",
          merchantConfirmed: false,
          rejectionReason: rejectionReason || "بيانات الإيصال أو العميل تحتاج إلى تصحيح",
          merchantRejectedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return {alreadyUpdated: false, status: "merchant_rejected"};
      });

      // Captain receives the canonical order status through its authenticated Firestore listener.
      // Do not reuse the "new_order" FCM path for merchant confirmation.
      return {success: true, orderId, ...result};
    } catch (err) {
      throw mapError(err);
    }
  }
);


/**
 * Releases a merchant's reserved package slot after an order becomes terminal.
 * The transaction checks the current order and capacity ledger so duplicate trigger
 * deliveries cannot release the same slot twice.
 */
export const onOrderCapacityReleased = onDocumentUpdated(
  {document: "orders/{orderId}", region: "us-central1", retry: true},
  async (event) => {
    const before = event.data?.before.data() as Record<string, unknown> | undefined;
    const after = event.data?.after.data() as Record<string, unknown> | undefined;
    if (!after) return;
    const beforeStatus = readNormalizedOrderStatus(before ?? {});
    const afterStatus = readNormalizedOrderStatus(after);
    if (isClosedMerchantOrderStatus(beforeStatus) || !isClosedMerchantOrderStatus(afterStatus)) return;

    const merchantId = readString(after, "merchantId", "restaurantId", "userId");
    if (!merchantId) return;

    const db = getFirestore();
    const orderId = event.params.orderId;
    const orderRef = db.collection("orders").doc(orderId);
    const capacityRef = db.collection("merchants").doc(merchantId)
      .collection("capacity").doc("current");

    await db.runTransaction(async (tx) => {
      const [orderSnap, capacitySnap] = await Promise.all([
        tx.get(orderRef),
        tx.get(capacityRef),
      ]);
      if (!orderSnap.exists || !capacitySnap.exists) return;

      const currentOrder = orderSnap.data() ?? {};
      if (
        currentOrder.capacityReleased === true ||
        !isClosedMerchantOrderStatus(readNormalizedOrderStatus(currentOrder))
      ) return;

      const capacity = capacitySnap.data() ?? {};
      const reservedIds = Array.isArray(capacity.reservedOrderIds)
        ? capacity.reservedOrderIds.map((id) => String(id)).filter(Boolean)
        : [];
      if (!reservedIds.includes(orderId)) return;

      const remainingIds = reservedIds.filter((id) => id !== orderId);
      tx.update(orderRef, {
        capacityReleased: true,
        capacityReleasedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(capacityRef, {
        reservedOrderIds: remainingIds,
        activeReservationsCount: remainingIds.length,
        capacityVersion: FieldValue.increment(1),
        lastReleasedOrderId: orderId,
        terminalStatusAtRelease: readNormalizedOrderStatus(currentOrder),
        updatedAt: FieldValue.serverTimestamp(),
      }, {merge: true});
    });
  }
);

/**
 * Trigger 1: Auto-dispatches newly created pending orders to nearest eligible captain
 * with a server-authored 60-second offer deadline + Cloud Task watchdog.
 */
export const onOrderCreatedDispatch = onDocumentCreated(
  {document: "orders/{orderId}", region: "us-central1", retry: true},
  async (event) => {
    const orderId = event.params.orderId;
    const order = event.data?.data() ?? {};
    // Dashboard Functions is the only dispatcher for trusted merchant and admin order creation.
    if (
      order.dispatchAuthority !== "dashboard_functions" ||
      !["merchantCreateOrder", "adminCreateOrder"].includes(String(order.createdByServerFunction ?? ""))
    ) {
      return;
    }
    await dispatchOrderFromEvent(orderId, "onOrderCreatedDispatch");
  }
);

/**
 * Trigger 2: Handles admin/merchant manual re-queue to searching state without looping.
 */
export const onOrderUpdatedDispatch = onDocumentUpdated(
  {document: "orders/{orderId}", region: "us-central1", retry: true},
  async (event) => {
    const after = event.data?.after.data() as Record<string, unknown> | undefined;
    const before = event.data?.before.data() as Record<string, unknown> | undefined;
    if (!after || !before) return;

    const afterStatus = readNormalizedOrderStatus(after);
    const afterDispatch = String(after.dispatchStatus ?? "").toLowerCase();
    const beforeDispatch = String(before.dispatchStatus ?? "").toLowerCase();
    const afterOffered = String(after.offeredCaptainId ?? "").trim();

    if (
      after.dispatchAuthority === "dashboard_functions" &&
      ["merchantCreateOrder", "adminCreateOrder"].includes(String(after.createdByServerFunction ?? "")) &&
      (afterStatus === "pending" || afterStatus === "searching") &&
      afterDispatch === "searching" &&
      beforeDispatch !== "searching" &&
      !afterOffered
    ) {
      await dispatchOrderFromEvent(event.params.orderId, "onOrderUpdatedDispatch");
    }
  }
);

async function allowCaptainDispatchRetry(captainId: string): Promise<boolean> {
  const ref = getFirestore().collection("dispatch_retry_cooldowns").doc(captainId);
  const nowMs = Date.now();
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const lastAttemptAtMs = readNumber(snap.data() ?? {}, "lastAttemptAtMs") ?? 0;
    if (nowMs - lastAttemptAtMs < 30_000) return false;
    tx.set(ref, {
      lastAttemptAtMs: nowMs,
      updatedAt: FieldValue.serverTimestamp(),
    }, {merge: true});
    return true;
  });
}

async function retryQueuedDashboardOrders(): Promise<void> {
  const queued = await getFirestore()
    .collection("orders")
    .where("dispatchStatus", "==", "no_captains_available")
    .limit(50)
    .get();
  const toMillis = (value: unknown): number => {
    if (value && typeof value === "object" && "toMillis" in value &&
      typeof (value as {toMillis?: unknown}).toMillis === "function") {
      return (value as {toMillis: () => number}).toMillis();
    }
    if (typeof value === "string") return Date.parse(value) || 0;
    if (typeof value === "number") return value;
    return 0;
  };
  const pending = queued.docs
    .filter((doc) =>
      doc.get("dispatchAuthority") === "dashboard_functions" &&
      ["pending", "searching"].includes(readNormalizedOrderStatus(doc.data() ?? {}))
    )
    .sort((a, b) => toMillis(a.get("createdAt")) - toMillis(b.get("createdAt")));

  for (const orderDoc of pending) {
    const outcome = await service.dispatchNewOrSearchingOrder(orderDoc.id);
    // One queue item per trigger prevents notification storms when no eligible captain exists.
    if (outcome.status === "offered" || outcome.status === "no_captains_available") break;
  }
}

/**
 * Retry queued orders when a captain becomes available or receives a fresh GPS location.
 * GPS updates are throttled per captain to avoid repeatedly scanning the queue.
 */
export const retryNoCaptainOrdersWhenCaptainAvailable = onDocumentUpdated(
  {document: "captains/{captainId}", region: "us-central1", retry: true},
  async (event) => {
    const before = event.data?.before.data() as Record<string, unknown> | undefined;
    const after = event.data?.after.data() as Record<string, unknown> | undefined;
    if (!after || !isCaptainReadyForDispatch(after)) return;

    const becameAvailable = !isCaptainReadyForDispatch(before);
    const beforeCoordinates = before ? extractCoordinates(before) : null;
    const afterCoordinates = extractCoordinates(after);
    const beforeLocationTime = before ? parseTimestampMs(before.lastLocationUpdate) : 0;
    const afterLocationTime = parseTimestampMs(after.lastLocationUpdate);
    const nowMs = Date.now();
    const wasLocationFresh =
      beforeLocationTime > 0 && nowMs - beforeLocationTime <= MAX_LOCATION_AGE_MS;
    const isLocationFresh =
      afterLocationTime > 0 && nowMs - afterLocationTime <= MAX_LOCATION_AGE_MS;
    const locationBecameFresh =
      !!afterCoordinates && isLocationFresh && (!beforeCoordinates || !wasLocationFresh);
    if (!becameAvailable && !locationBecameFresh) return;

    const captainId = event.params.captainId;
    if (!await allowCaptainDispatchRetry(captainId)) return;
    await retryQueuedDashboardOrders();
  }
);

/**
 * A captain can become eligible by entering an active scheduled shift even when
 * their online/presence fields did not change. Re-check the queue on schedule writes.
 */
export const retryNoCaptainOrdersWhenCaptainScheduleChanges = onDocumentWritten(
  {document: "captain_schedules/{captainId}", region: "us-central1", retry: true},
  async (event) => {
    if (!event.data?.after.exists) return;
    const captainId = event.params.captainId;
    const captainSnap = await getFirestore().collection("captains").doc(captainId).get();
    if (!isCaptainReadyForDispatch(captainSnap.data() as Record<string, unknown> | undefined)) return;
    if (!await allowCaptainDispatchRetry(captainId)) return;
    await retryQueuedDashboardOrders();
  }
);

/**
 * Task Worker: Enforces the server-side 60-second offer expiry window and
 * reassigns to the next nearest eligible captain atomically.
 */
export const reassignOrderOffer = onTaskDispatched(
  {
    region: "us-central1",
    retryConfig: {
      maxAttempts: 3,
      minBackoffSeconds: 5,
    },
    rateLimits: {
      maxConcurrentDispatches: 20,
    },
  },
  async (req) => {
    const payload = (req.data ?? {}) as ReassignTaskPayload;
    try {
      await service.handleReassignOfferTask(payload);
    } catch (err) {
      logger.error("Error in reassignOrderOffer task", {
        orderId: payload?.orderId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
);


/**
 * Recovery sweep: Cloud Tasks is the primary 60-second watchdog; this scheduled
 * fallback repairs expired offers if task enqueueing or task execution is unavailable.
 */
export const sweepExpiredOrderOffers = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "Africa/Cairo",
    region: "us-central1",
    maxInstances: 1,
  },
  async () => {
    try {
      const processed = await service.sweepExpiredOffers(100);
      const redispatched = await service.retryOrdersWithExpiredExclusions(20);
      logger.info("Expired-order offer recovery sweep completed", {processed, redispatched});
    } catch (err) {
      logger.error("Expired-order offer recovery sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
);

/**
 * Callable 8a: Merchant submits (or resubmits) a manual Vodafone Cash subscription request.
 * Validates auth, merchant ownership, official server package/price/duration, Storage receipt,
 * and prevents duplicates. Always creates/updates in pending_review without activating subscription.
 */
export const submitManualSubscriptionRequest = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await manualSubService.submitManualSubscriptionRequest(
        request.auth
          ? {
            uid: request.auth.uid,
            token: request.auth.token as Record<string, unknown>,
          }
          : undefined,
        payload
      );
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Callable 8: Server-authoritative approval of a manual Vodafone Cash subscription request.
 * Atomically approves the request, activates subscriptions/{merchantId} & merchants/{merchantId},
 * creates a single financial record in payments/, writes operation_logs, and notifies the merchant.
 */
export const approveManualSubscriptionRequest = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await manualSubService.approveManualSubscriptionRequest(
        request.auth
          ? {
            uid: request.auth.uid,
            token: request.auth.token as Record<string, unknown>,
          }
          : undefined,
        payload
      );
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Callable 9: Server-authoritative rejection of a manual Vodafone Cash subscription request.
 * Records rejection reason and notifies the merchant without activating any subscription.
 */
export const rejectManualSubscriptionRequest = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await manualSubService.rejectManualSubscriptionRequest(
        request.auth
          ? {
            uid: request.auth.uid,
            token: request.auth.token as Record<string, unknown>,
          }
          : undefined,
        payload
      );
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Callable 10: Admin requests the merchant to re-upload a clearer Vodafone Cash receipt.
 * Sets status to resubmission_required and preserves previous receipt attempts & audit history.
 */
export const requestSubscriptionReceiptResubmission = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await manualSubService.requestSubscriptionReceiptResubmission(
        request.auth
          ? {
            uid: request.auth.uid,
            token: request.auth.token as Record<string, unknown>,
          }
          : undefined,
        payload
      );
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Compatibility alias for requestSubscriptionReceiptResubmission.
 */
export const requestManualSubscriptionResubmission =
  requestSubscriptionReceiptResubmission;

/**
 * Callable 11: Master-Admin-only update of Vodafone Cash wallet number, official pricing, and duration.
 */
export const updateManualSubscriptionSettings = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await manualSubService.updateManualSubscriptionSettings(
        request.auth
          ? {
            uid: request.auth.uid,
            token: request.auth.token as Record<string, unknown>,
          }
          : undefined,
        payload
      );
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Admin-only callable used by the general Subscriptions dashboard.
 * Creates, edits, renews, suspends, reactivates or cancels the canonical merchant subscription.
 */
export const adminManageMerchantSubscription = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await manualSubService.manageMerchantSubscription(
        request.auth
          ? {uid: request.auth.uid, token: request.auth.token as Record<string, unknown>}
          : undefined,
        payload
      );
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Admin-only callable to record a manual payment in the central financial ledger.
 * Uses an idempotency key to prevent duplicate records, and atomically activates/renews
 * subscriptions/{merchantId} + merchants/{merchantId} ONLY when explicitly linked to a paid package.
 */
export const recordManualPayment = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await manualSubService.recordManualPayment(
        request.auth
          ? {uid: request.auth.uid, token: request.auth.token as Record<string, unknown>}
          : undefined,
        payload
      );
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Trigger 3: Notifies admins whenever a merchant submits a new manual subscription request.
 */
export const onManualSubscriptionRequestCreated = onDocumentCreated(
  {document: "manual_subscription_requests/{requestId}", region: "us-central1", retry: true},
  async (event) => {
    const requestId = event.params.requestId;
    const data = event.data?.data() as Record<string, unknown> | undefined;
    if (!data) return;
    try {
      await manualSubService.handleNewManualSubscriptionRequest(requestId, data);
    } catch (err) {
      logger.error("Failed to process new manual subscription request alert", {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
);

/**
 * Captain Moderation Callables: server-authoritative approval, rejection,
 * temporary suspension, reactivation, and permanent blocking.
 */
export const adminApproveCaptain = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await captainApprovalService.approveCaptain(
        request.auth
          ? {uid: request.auth.uid, token: request.auth.token as Record<string, unknown>}
          : undefined,
        payload
      );
    } catch (err) {
      throw mapError(err);
    }
  }
);

export const adminRejectCaptain = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await captainApprovalService.rejectCaptain(
        request.auth
          ? {uid: request.auth.uid, token: request.auth.token as Record<string, unknown>}
          : undefined,
        payload
      );
    } catch (err) {
      throw mapError(err);
    }
  }
);

export const adminSuspendCaptain = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await captainApprovalService.suspendCaptain(
        request.auth
          ? {uid: request.auth.uid, token: request.auth.token as Record<string, unknown>}
          : undefined,
        payload
      );
    } catch (err) {
      throw mapError(err);
    }
  }
);

export const adminReactivateCaptain = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await captainApprovalService.reactivateCaptain(
        request.auth
          ? {uid: request.auth.uid, token: request.auth.token as Record<string, unknown>}
          : undefined,
        payload
      );
    } catch (err) {
      throw mapError(err);
    }
  }
);

export const adminBlockCaptain = onCall(
  {region: "us-central1"},
  async (request) => {
    try {
      const payload = (request.data ?? {}) as Record<string, unknown>;
      return await captainApprovalService.blockCaptain(
        request.auth
          ? {uid: request.auth.uid, token: request.auth.token as Record<string, unknown>}
          : undefined,
        payload
      );
    } catch (err) {
      throw mapError(err);
    }
  }
);

/**
 * Trigger 4: Notifies admins and logs initial registration when a new captain signs up.
 */
export const onCaptainCreated = onDocumentCreated(
  {document: "captains/{captainId}", region: "us-central1", retry: true},
  async (event) => {
    const captainId = event.params.captainId;
    const data = event.data?.data() as Record<string, unknown> | undefined;
    if (!data) return;
    try {
      await captainApprovalService.handleNewCaptainCreated(captainId, data);
    } catch (err) {
      logger.error("Failed to process new captain registration alert", {
        captainId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
);

