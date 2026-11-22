"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.onCaptainCreated = exports.adminBlockCaptain = exports.adminReactivateCaptain = exports.adminSuspendCaptain = exports.adminRejectCaptain = exports.adminApproveCaptain = exports.onManualSubscriptionRequestCreated = exports.recordManualPayment = exports.adminManageMerchantSubscription = exports.updateManualSubscriptionSettings = exports.requestManualSubscriptionResubmission = exports.requestSubscriptionReceiptResubmission = exports.rejectManualSubscriptionRequest = exports.approveManualSubscriptionRequest = exports.submitManualSubscriptionRequest = exports.sweepExpiredOrderOffers = exports.reassignOrderOffer = exports.retryNoCaptainOrdersWhenCaptainScheduleChanges = exports.retryNoCaptainOrdersWhenCaptainAvailable = exports.onOrderUpdatedDispatch = exports.onOrderCreatedDispatch = exports.onOrderCapacityReleased = exports.merchantConfirmOrder = exports.adminRecordOrderStageTimestamp = exports.adminCancelOrder = exports.adminDispatchOrder = exports.adminAssignCaptain = exports.adminCreateOrder = exports.merchantUpdateOrderDetails = exports.merchantCancelOrder = exports.createOrderWithCode = exports.requestCaptains = exports.merchantCreateOrder = exports.validateMerchantSubscription = exports.getMerchantSubscription = exports.resolveCaptainEmailByPhone = exports.expireDeliveryOffer = exports.confirmDelivery = exports.submitCustomerDeliveryDetails = exports.confirmPickup = exports.captainArrivedAtMerchant = exports.acceptOrder = void 0;
const app_1 = require("firebase-admin/app");
const node_crypto_1 = require("node:crypto");
const firestore_1 = require("firebase-admin/firestore");
const firebase_functions_1 = require("firebase-functions");
const logger = __importStar(require("firebase-functions/logger"));
const firestore_2 = require("firebase-functions/v2/firestore");
const https_1 = require("firebase-functions/v2/https");
const tasks_1 = require("firebase-functions/v2/tasks");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firebaseAdapter_js_1 = require("./firebaseAdapter.js");
const captainApprovalService_js_1 = require("./captainApprovalService.js");
const manualSubscriptionsService_js_1 = require("./manualSubscriptionsService.js");
const ordersService_js_1 = require("./ordersService.js");
const types_js_1 = require("./types.js");
const validators_js_1 = require("./validators.js");
(0, app_1.initializeApp)();
(0, firebase_functions_1.setGlobalOptions)({ region: "us-central1", maxInstances: 10 });
const dbAdapter = (0, firebaseAdapter_js_1.createAdminDatabaseAdapter)((0, firestore_1.getFirestore)());
const service = new ordersService_js_1.OrderServerService(dbAdapter, (0, firebaseAdapter_js_1.createAdminServerEffects)());
const manualSubService = new manualSubscriptionsService_js_1.ManualSubscriptionsServerService(dbAdapter, (0, firebaseAdapter_js_1.createAdminManualSubscriptionEffects)());
const captainApprovalService = new captainApprovalService_js_1.CaptainApprovalServerService(dbAdapter, (0, firebaseAdapter_js_1.createAdminCaptainApprovalEffects)());
function mapError(err) {
    if (err instanceof https_1.HttpsError)
        return err;
    if (err instanceof types_js_1.DomainHttpsError) {
        return new https_1.HttpsError(err.code, err.message);
    }
    logger.error("Unhandled Cloud Function order error", {
        error: err instanceof Error ? err.message : String(err),
    });
    return new https_1.HttpsError("internal", "حدث خطأ غير متوقع في الخادم أثناء تنفيذ العملية.");
}
function isCaptainReadyForDispatch(data) {
    if (!data || data.isOnline !== true)
        return false;
    if ((0, validators_js_1.resolveCaptainAccountStatus)(data) !== "approved")
        return false;
    const status = (0, validators_js_1.readString)(data, "status").toLowerCase();
    const presence = ((0, validators_js_1.readString)(data, "presenceStatus") || "available").toLowerCase();
    const availability = ((0, validators_js_1.readString)(data, "availabilityStatus") || "available").toLowerCase();
    const unavailable = new Set(["offline", "busy", "unavailable", "paused", "on_trip"]);
    return ["online", "active", "approved"].includes(status) &&
        data.canReceiveOrders !== false &&
        data.isReceivingOrders !== false &&
        data.receiveOrders !== false &&
        data.isBlocked !== true &&
        data.isSuspended !== true &&
        !unavailable.has(presence) &&
        !unavailable.has(availability) &&
        !(0, validators_js_1.readString)(data, "currentOrderId") &&
        !(0, validators_js_1.readString)(data, "activeOfferOrderId");
}
async function enforceCaptainEmailLookupRateLimit(ipAddress, phone) {
    const db = (0, firestore_1.getFirestore)();
    const nowMs = Date.now();
    const windowMs = 15 * 60 * 1000;
    const normalizedPhone = phone.replace(/[^0-9+]/g, "").slice(0, 32) || "missing";
    const scopes = [
        { name: "ip", value: ipAddress || "unknown", maxAttempts: 30 },
        { name: "phone", value: normalizedPhone, maxAttempts: 6 },
    ];
    for (const scope of scopes) {
        const digest = (0, node_crypto_1.createHash)("sha256").update(scope.value).digest("hex");
        const ref = db.collection("security_rate_limits")
            .doc(`captain-email-lookup-${scope.name}-${digest}`);
        await db.runTransaction(async (tx) => {
            var _a, _b, _c;
            const snap = await tx.get(ref);
            const data = (_a = snap.data()) !== null && _a !== void 0 ? _a : {};
            const windowStartedAtMs = (_b = (0, validators_js_1.readNumber)(data, "windowStartedAtMs")) !== null && _b !== void 0 ? _b : 0;
            const attempts = (_c = (0, validators_js_1.readNumber)(data, "attempts")) !== null && _c !== void 0 ? _c : 0;
            const inWindow = nowMs - windowStartedAtMs < windowMs;
            if (inWindow && attempts >= scope.maxAttempts) {
                throw new https_1.HttpsError("resource-exhausted", "تم تجاوز عدد محاولات البحث عن الحساب. حاول مرة أخرى بعد 15 دقيقة.");
            }
            tx.set(ref, {
                scope: scope.name,
                windowStartedAtMs: inWindow ? windowStartedAtMs : nowMs,
                attempts: inWindow ? attempts + 1 : 1,
                expiresAt: new Date(nowMs + 24 * 60 * 60 * 1000),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            }, { merge: true });
        });
    }
}
/**
 * Callable 1: Authoritative order acceptance by authenticated captain.
 */
exports.acceptOrder = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await service.acceptOrder((_b = request.auth) === null || _b === void 0 ? void 0 : _b.uid, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Callable 2: Captain records arrival at merchant pickup location.
 */
exports.captainArrivedAtMerchant = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await service.captainArrivedAtMerchant((_b = request.auth) === null || _b === void 0 ? void 0 : _b.uid, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Callable 3: Captain confirms picking up order from merchant.
 */
exports.confirmPickup = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await service.confirmPickup((_b = request.auth) === null || _b === void 0 ? void 0 : _b.uid, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Callable 4: Captain submits customer details and verified receipt Storage path.
 */
exports.submitCustomerDeliveryDetails = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await service.submitCustomerDeliveryDetails((_b = request.auth) === null || _b === void 0 ? void 0 : _b.uid, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Callable 5: Atomic idempotent delivery completion and wallet credit.
 */
exports.confirmDelivery = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await service.confirmDelivery((_b = request.auth) === null || _b === void 0 ? void 0 : _b.uid, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Callable 6: Server-verified offer expiry or explicit decline.
 */
exports.expireDeliveryOffer = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await service.expireDeliveryOffer((_b = request.auth) === null || _b === void 0 ? void 0 : _b.uid, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Callable 7: Read-only captain email lookup by phone number during pre-login.
 */
exports.resolveCaptainEmailByPhone = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        const phone = (0, validators_js_1.readString)(payload, "phone", "phoneNumber", "mobile");
        await enforceCaptainEmailLookupRateLimit(request.rawRequest.ip || "unknown", phone);
        return await service.resolveCaptainEmailByPhone(payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
async function requireAdminUid(uid, claims) {
    var _a;
    const cleanUid = typeof uid === "string" ? uid.trim() : "";
    const adminDoc = cleanUid
        ? await (0, firestore_1.getFirestore)().collection("admins").doc(cleanUid).get()
        : null;
    try {
        const verified = (0, validators_js_1.evaluateVerifiedAdminAccess)({
            authContext: cleanUid ? { uid: cleanUid, token: claims } : undefined,
            adminDocExists: Boolean(adminDoc === null || adminDoc === void 0 ? void 0 : adminDoc.exists),
            adminDocData: (adminDoc === null || adminDoc === void 0 ? void 0 : adminDoc.exists) ? ((_a = adminDoc.data()) !== null && _a !== void 0 ? _a : {}) : undefined,
        });
        return verified.uid;
    }
    catch (err) {
        throw mapError(err);
    }
}
function requireOrderId(raw) {
    if (typeof raw !== "string") {
        throw new https_1.HttpsError("invalid-argument", "معرف الطلب مطلوب.");
    }
    const value = raw.trim().replace(/^#+/, "").trim();
    if (!value || value.length > 128 || value.includes("/")) {
        throw new https_1.HttpsError("invalid-argument", "معرف الطلب غير صالح.");
    }
    return value;
}
function generateDistinctOrderCode() {
    const firstDigit = (0, node_crypto_1.randomInt)(1, 10);
    const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((digit) => digit !== firstDigit);
    const digits = [firstDigit];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = (0, node_crypto_1.randomInt)(0, i + 1);
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    digits.push(...pool.slice(0, 5));
    return digits.join("");
}
function isClosedMerchantOrderStatus(status) {
    return (0, validators_js_1.isTerminalMerchantOrderStatus)(status);
}
const PERMANENT_DISPATCH_ERROR_CODES = new Set([
    "invalid-argument",
    "permission-denied",
    "not-found",
    "failed-precondition",
]);
/**
 * Persist non-retryable order-data failures for admin review. Transient infrastructure
 * failures are deliberately rethrown so the Firestore event retry policy can recover.
 */
async function recordPermanentDispatchFailure(orderId, error) {
    const db = (0, firestore_1.getFirestore)();
    const orderRef = db.collection("orders").doc(orderId);
    const alertRef = db.collection("notifications").doc(`dispatch_failed_${orderId}`);
    await db.runTransaction(async (tx) => {
        var _a;
        const [orderSnap, alertSnap] = await Promise.all([
            tx.get(orderRef),
            tx.get(alertRef),
        ]);
        if (!orderSnap.exists)
            return;
        const order = (_a = orderSnap.data()) !== null && _a !== void 0 ? _a : {};
        if ((0, validators_js_1.extractOrderCaptainUid)(order) ||
            isClosedMerchantOrderStatus((0, validators_js_1.readNormalizedOrderStatus)(order)))
            return;
        const now = firestore_1.FieldValue.serverTimestamp();
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
                message: `تعذر توزيع الطلب ${(0, validators_js_1.readString)(order, "orderNumber") || orderId}: ${error.message}`,
                orderId,
                orderNumber: (0, validators_js_1.readString)(order, "orderNumber", "order_number") || orderId,
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
async function dispatchOrderFromEvent(orderId, triggerName) {
    try {
        await service.dispatchNewOrSearchingOrder(orderId);
    }
    catch (err) {
        logger.error(`Order dispatch trigger failed: ${triggerName}`, {
            orderId,
            error: err instanceof Error ? err.message : String(err),
        });
        if (err instanceof types_js_1.DomainHttpsError &&
            PERMANENT_DISPATCH_ERROR_CODES.has(err.code)) {
            await recordPermanentDispatchFailure(orderId, err);
            return;
        }
        throw err;
    }
}
/**
 * Converts Firestore Timestamp, Date, ISO date, or epoch values to milliseconds.
 */
function timestampToMillis(value) {
    var _a;
    if (typeof value === "number" && Number.isFinite(value)) {
        return value < 1000000000000 ? Math.round(value * 1000) : Math.round(value);
    }
    if (typeof value === "string" && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
            return numeric < 1000000000000 ? Math.round(numeric * 1000) : Math.round(numeric);
        }
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    if (value instanceof Date)
        return value.getTime();
    if (value && typeof value === "object") {
        const timestamp = value;
        if (typeof timestamp.toMillis === "function") {
            const parsed = timestamp.toMillis();
            return Number.isFinite(parsed) ? parsed : null;
        }
        const seconds = Number((_a = timestamp.seconds) !== null && _a !== void 0 ? _a : timestamp._seconds);
        if (Number.isFinite(seconds) && seconds > 0) {
            return Math.round(seconds * 1000 + Number(timestamp.nanoseconds || 0) / 1000000);
        }
    }
    return null;
}
async function buildMerchantSubscriptionResponse(merchantId, requestedCaptains = 1) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
    const db = (0, firestore_1.getFirestore)();
    const [merchantSnap, subscriptionSnap, byMerchant, byRestaurant, byUser] = await Promise.all([
        db.collection("merchants").doc(merchantId).get(),
        db.collection("subscriptions").doc(merchantId).get(),
        db.collection("orders").where("merchantId", "==", merchantId).get(),
        db.collection("orders").where("restaurantId", "==", merchantId).get(),
        db.collection("orders").where("userId", "==", merchantId).get(),
    ]);
    const merchant = (_a = merchantSnap.data()) !== null && _a !== void 0 ? _a : {};
    const subscription = (_b = subscriptionSnap.data()) !== null && _b !== void 0 ? _b : {};
    const activeOrderIds = new Set();
    for (const snapshot of [byMerchant, byRestaurant, byUser]) {
        for (const orderDoc of snapshot.docs) {
            if (!isClosedMerchantOrderStatus((0, validators_js_1.readNormalizedOrderStatus)((_c = orderDoc.data()) !== null && _c !== void 0 ? _c : {}))) {
                activeOrderIds.add(orderDoc.id);
            }
        }
    }
    const activeCaptainsCount = activeOrderIds.size;
    const { planId, planKey } = (0, validators_js_1.resolveCanonicalPlanIdentifier)(merchant, subscription);
    const planName = (0, validators_js_1.readString)(subscription, "planName", "packageName", "plan") ||
        (0, validators_js_1.readString)(merchant, "planName", "packageName", "plan");
    const captainLimit = (0, validators_js_1.resolveEffectiveCaptainLimit)(merchant, subscription);
    const price = (_e = (_d = (0, validators_js_1.readNumber)(subscription, "price", "amount")) !== null && _d !== void 0 ? _d : (0, validators_js_1.readNumber)(merchant, "price")) !== null && _e !== void 0 ? _e : 0;
    const statusRaw = (0, validators_js_1.readString)(subscription, "status", "subscriptionStatus") ||
        (0, validators_js_1.readString)(merchant, "subscriptionStatus");
    let status = statusRaw.trim().toLowerCase();
    const merchantStatus = (0, validators_js_1.readString)(merchant, "status").toLowerCase();
    const merchantApproved = merchantSnap.exists &&
        (0, validators_js_1.readString)(merchant, "accountType").toLowerCase() === "merchant" &&
        (["approved", "active"].includes(merchantStatus) || merchant.isApproved === true);
    const activeFlags = subscription.isActive === true ||
        subscription.isSubscribed === true || merchant.isSubscribed === true;
    const subscriptionStatusActive = [
        "active", "approved", "trial", "enabled", "valid", "subscribed", "نشط", "نشطة", "ساري", "سارية",
    ].includes(status) || (!status && activeFlags);
    const endDateMs = timestampToMillis((_k = (_j = (_h = (_g = (_f = subscription.expiresAt) !== null && _f !== void 0 ? _f : subscription.endDate) !== null && _g !== void 0 ? _g : subscription.expiryDate) !== null && _h !== void 0 ? _h : subscription.subscriptionEndDate) !== null && _j !== void 0 ? _j : merchant.subscriptionEndDate) !== null && _k !== void 0 ? _k : merchant.subscriptionExpiresAt);
    const startDateMs = timestampToMillis((_o = (_m = (_l = subscription.activatedAt) !== null && _l !== void 0 ? _l : subscription.startDate) !== null && _m !== void 0 ? _m : subscription.subscriptionStartDate) !== null && _o !== void 0 ? _o : merchant.subscriptionStartDate);
    const nowMs = Date.now();
    const expiryEffectiveMs = endDateMs !== null && new Date(endDateMs).getUTCHours() === 0 &&
        new Date(endDateMs).getUTCMinutes() === 0 && new Date(endDateMs).getUTCSeconds() === 0
        ? endDateMs + 86400000 - 1 : endDateMs;
    let validationError = "";
    if (!merchantSnap.exists || (0, validators_js_1.readString)(merchant, "accountType").toLowerCase() !== "merchant") {
        validationError = "تعذر العثور على بيانات حساب التاجر.";
        status = "not_found";
    }
    else if (!merchantApproved) {
        validationError = "حساب التاجر في انتظار موافقة الإدارة.";
        status = "merchant_pending";
    }
    else if (!subscriptionSnap.exists) {
        validationError = "لم يتم العثور على اشتراك التاجر.";
        status = "unsubscribed";
    }
    else if (!subscriptionStatusActive) {
        validationError = "لا يوجد اشتراك نشط لهذا التاجر.";
        status = status || "inactive";
    }
    else if (captainLimit <= 0) {
        validationError = "الباقة الحالية لا تسمح بطلب الكباتن.";
    }
    else if (expiryEffectiveMs !== null && nowMs > expiryEffectiveMs) {
        validationError = "انتهت فترة اشتراكك، يرجى تجديد الاشتراك.";
        status = "expired";
    }
    else {
        try {
            (0, validators_js_1.assertMerchantAndSubscriptionValid)(merchantId, merchant, subscription, nowMs);
        }
        catch (err) {
            validationError = err instanceof Error ? err.message : "الاشتراك غير صالح حالياً.";
            if (!status)
                status = "inactive";
        }
    }
    const isActive = validationError === "";
    const remainingCaptains = Math.max(0, captainLimit - activeCaptainsCount);
    const requested = Math.max(validators_js_1.MIN_PACKAGE_CAPTAINS, Math.min(validators_js_1.MAX_PACKAGE_CAPTAINS, Math.floor(Number(requestedCaptains) || 1)));
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
        remainingDays: Math.floor(remainingMillis / 86400000),
        remainingHours: Math.floor(remainingMillis / 3600000),
        activeCaptainsCount,
        remainingCaptains,
        subscriptionVersion: (_q = (_p = (0, validators_js_1.readNumber)(subscription, "subscriptionVersion")) !== null && _p !== void 0 ? _p : (0, validators_js_1.readNumber)(merchant, "subscriptionVersion")) !== null && _q !== void 0 ? _q : 1,
        updatedBy: (0, validators_js_1.readString)(subscription, "updatedBy", "updatedByAdminUid") ||
            (0, validators_js_1.readString)(merchant, "updatedBy") || undefined,
        paymentStatus: (0, validators_js_1.readString)(subscription, "paymentStatus") ||
            (0, validators_js_1.readString)(merchant, "paymentStatus") || (isActive ? "paid" : "unpaid"),
        paymentMethod: (0, validators_js_1.readString)(subscription, "paymentMethod") ||
            (0, validators_js_1.readString)(merchant, "paymentMethod") || undefined,
        errorMessage,
        reason: errorMessage,
        serverTimeMs: nowMs,
    };
}
exports.getMerchantSubscription = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b, _c;
    const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!uid)
        throw new https_1.HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً.");
    if (((_b = request.auth) === null || _b === void 0 ? void 0 : _b.token.email_verified) !== true) {
        throw new https_1.HttpsError("failed-precondition", "يجب تأكيد البريد الإلكتروني أولاً.");
    }
    const merchantId = (0, validators_js_1.readString)(((_c = request.data) !== null && _c !== void 0 ? _c : {}), "merchantId");
    if (merchantId && merchantId !== uid) {
        throw new https_1.HttpsError("permission-denied", "غير مسموح بالوصول لاشتراك تاجر آخر.");
    }
    return buildMerchantSubscriptionResponse(uid);
});
exports.validateMerchantSubscription = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b, _c;
    const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!uid)
        throw new https_1.HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً.");
    if (((_b = request.auth) === null || _b === void 0 ? void 0 : _b.token.email_verified) !== true) {
        throw new https_1.HttpsError("failed-precondition", "يجب تأكيد البريد الإلكتروني أولاً.");
    }
    const payload = ((_c = request.data) !== null && _c !== void 0 ? _c : {});
    return buildMerchantSubscriptionResponse(uid, payload.requestedCaptains);
});
/**
 * Merchant creates an order with a globally unique 6-digit code.
 * The code, idempotency key, capacity check, and order document are committed atomically.
 * Dispatch is performed only by the server-side order-created trigger.
 */
exports.merchantCreateOrder = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b, _c, _d;
    try {
        const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
        if (!uid)
            throw new https_1.HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً.");
        if (((_b = request.auth) === null || _b === void 0 ? void 0 : _b.token.email_verified) !== true) {
            throw new https_1.HttpsError("permission-denied", "يجب تأكيد البريد الإلكتروني قبل إنشاء الطلب.");
        }
        const data = ((_c = request.data) !== null && _c !== void 0 ? _c : {});
        const idempotencyKey = (0, validators_js_1.readString)(data, "idempotencyKey");
        if (idempotencyKey.length < 16 ||
            idempotencyKey.length > 128 ||
            !/^[A-Za-z0-9_-]+$/.test(idempotencyKey)) {
            throw new https_1.HttpsError("invalid-argument", "مفتاح منع تكرار الطلب غير صالح.");
        }
        const destinationAddress = (0, validators_js_1.readString)(data, "destinationAddress", "deliveryAddress", "address");
        if (!destinationAddress || destinationAddress.length > 1000) {
            throw new https_1.HttpsError("invalid-argument", "عنوان التوصيل مطلوب ويجب ألا يتجاوز 1000 حرف.");
        }
        const customerName = (0, validators_js_1.readString)(data, "customerName").slice(0, 200);
        const customerPhone = (0, validators_js_1.readString)(data, "customerPhone").slice(0, 40);
        const orderDetails = (0, validators_js_1.readString)(data, "orderDetails", "items").slice(0, 4000);
        const deliveryNotes = (0, validators_js_1.readString)(data, "deliveryNotes", "notes").slice(0, 1000);
        // The merchant app is the only client allowed to enter the delivery fee.
        // Preserve the merchant-entered text for display and store a numeric EGP value
        // for dispatch, reporting, and server-side settlement. Never invent a fee.
        const serviceFee = (0, validators_js_1.readString)(data, "serviceFee", "price");
        if (!serviceFee) {
            throw new https_1.HttpsError("invalid-argument", "يرجى إدخال قيمة خدمة التوصيل من تطبيق التاجر.");
        }
        const feeMatch = serviceFee.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
        if (!feeMatch) {
            throw new https_1.HttpsError("invalid-argument", "قيمة خدمة التوصيل يجب أن تحتوي على مبلغ رقمي واضح.");
        }
        const deliveryFee = Number(feeMatch[0]);
        if (!Number.isFinite(deliveryFee) || deliveryFee < 0 || deliveryFee > 100000) {
            throw new https_1.HttpsError("invalid-argument", "قيمة خدمة التوصيل غير صالحة.");
        }
        const customerLatitude = (0, validators_js_1.readNumber)(data, "customerLatitude");
        const customerLongitude = (0, validators_js_1.readNumber)(data, "customerLongitude");
        if ((customerLatitude === null) !== (customerLongitude === null) ||
            (customerLatitude !== null &&
                (customerLatitude < -90 || customerLatitude > 90 ||
                    customerLongitude < -180 || customerLongitude > 180 ||
                    (customerLatitude === 0 && customerLongitude === 0)))) {
            throw new https_1.HttpsError("invalid-argument", "إحداثيات عنوان العميل غير صالحة.");
        }
        const db = (0, firestore_1.getFirestore)();
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
            const replay = (_d = replaySnap.data()) !== null && _d !== void 0 ? _d : {};
            if ((0, validators_js_1.readString)(replay, "merchantId") !== uid) {
                throw new https_1.HttpsError("permission-denied", "مفتاح الطلب مستخدم لحساب آخر.");
            }
            return {
                success: true,
                orderId: (0, validators_js_1.readString)(replay, "orderId"),
                orderCode: (0, validators_js_1.readString)(replay, "orderCode"),
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
                    var _a, _b, _c, _d, _e, _f, _g;
                    const [merchantSnap, subscriptionSnap, codeSnap, keySnap, ordersByMerchantSnap, ordersByRestaurantSnap, ordersByUserSnap, capacitySnap,] = await Promise.all([
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
                        const keyData = (_a = keySnap.data()) !== null && _a !== void 0 ? _a : {};
                        if ((0, validators_js_1.readString)(keyData, "merchantId") !== uid) {
                            throw new https_1.HttpsError("permission-denied", "مفتاح الطلب مستخدم لحساب آخر.");
                        }
                        return {
                            replay: true,
                            orderId: (0, validators_js_1.readString)(keyData, "orderId"),
                            orderCode: (0, validators_js_1.readString)(keyData, "orderCode"),
                            maxCaptains: 0,
                            activeCaptainsCount: 0,
                            remainingCaptains: 0,
                            planId: 0,
                            planName: "",
                            subscriptionVersion: 1,
                        };
                    }
                    if (!merchantSnap.exists || !subscriptionSnap.exists) {
                        throw new https_1.HttpsError("failed-precondition", "ملف التاجر أو سجل الاشتراك غير موجود؛ لا يمكن إنشاء الطلب.");
                    }
                    const merchant = (_b = merchantSnap.data()) !== null && _b !== void 0 ? _b : {};
                    const subscription = (_c = subscriptionSnap.data()) !== null && _c !== void 0 ? _c : {};
                    if ((0, validators_js_1.readString)(merchant, "accountType").toLowerCase() !== "merchant" ||
                        !["approved", "active"].includes((0, validators_js_1.readString)(merchant, "status").toLowerCase())) {
                        throw new https_1.HttpsError("permission-denied", "حساب التاجر غير معتمد أو غير نشط.");
                    }
                    (0, validators_js_1.assertMerchantAndSubscriptionValid)(uid, merchant, subscription, nowMs);
                    const maxCaptains = (0, validators_js_1.resolveEffectiveCaptainLimit)(merchant, subscription);
                    if (maxCaptains < validators_js_1.MIN_PACKAGE_CAPTAINS || maxCaptains > validators_js_1.MAX_PACKAGE_CAPTAINS) {
                        throw new https_1.HttpsError("failed-precondition", "لا توجد باقة نشطة تسمح بطلب الكباتن.");
                    }
                    // Reconcile supported owner fields and deduplicate orders. The shared capacity
                    // document is read and written in this transaction to serialize concurrent requests.
                    const activeOrderIds = new Set();
                    for (const snapshot of [
                        ordersByMerchantSnap,
                        ordersByRestaurantSnap,
                        ordersByUserSnap,
                    ]) {
                        for (const orderDoc of snapshot.docs) {
                            if (!isClosedMerchantOrderStatus((0, validators_js_1.readNormalizedOrderStatus)((_d = orderDoc.data()) !== null && _d !== void 0 ? _d : {})))
                                activeOrderIds.add(orderDoc.id);
                        }
                    }
                    const capacityData = (_e = capacitySnap.data()) !== null && _e !== void 0 ? _e : {};
                    const capacityVersion = (_f = (0, validators_js_1.readNumber)(capacityData, "capacityVersion")) !== null && _f !== void 0 ? _f : 0;
                    const activeOrderCount = activeOrderIds.size;
                    if (activeOrderCount >= maxCaptains) {
                        throw new https_1.HttpsError("resource-exhausted", `وصلت إلى الحد المتزامن للباقة: ${activeOrderCount} من ${maxCaptains} طلبات نشطة.`);
                    }
                    if (codeSnap.exists) {
                        throw new Error("ORDER_CODE_COLLISION");
                    }
                    const pickup = (0, validators_js_1.extractCoordinates)(merchant);
                    if (!pickup) {
                        throw new https_1.HttpsError("failed-precondition", "يرجى تحديد موقع المتجر وتحديث إحداثياته قبل طلب كابتن.");
                    }
                    const merchantName = (0, validators_js_1.readString)(merchant, "name", "merchantName").trim();
                    const merchantPhone = (0, validators_js_1.readString)(merchant, "phone", "phoneNumber", "mobile").trim();
                    const merchantImageCandidates = [
                        (0, validators_js_1.readString)(merchant, "logo"),
                        (0, validators_js_1.readString)(merchant, "photoUrl"),
                        (0, validators_js_1.readString)(merchant, "logoUrl"),
                        (0, validators_js_1.readString)(merchant, "imageUrl"),
                        (0, validators_js_1.readString)(merchant, "profileImageUrl"),
                    ];
                    const storeImage = merchantImageCandidates.find((value) => /^https?:\/\//i.test(value)) || "";
                    const imagePathCandidates = [
                        (0, validators_js_1.readString)(merchant, "storagePath"),
                        (0, validators_js_1.readString)(merchant, "profileImagePath"),
                        (0, validators_js_1.readString)(merchant, "logoStoragePath"),
                        ...merchantImageCandidates,
                    ];
                    const storeImagePath = imagePathCandidates.find((value) => value.startsWith("gs://") || value.startsWith(`merchants/${uid}/`)) || "";
                    if (!merchantName) {
                        throw new https_1.HttpsError("failed-precondition", "اسم التاجر غير مسجل في ملف المتجر.");
                    }
                    if (!merchantPhone) {
                        throw new https_1.HttpsError("failed-precondition", "يرجى تسجيل رقم الهاتف الحقيقي في ملف التاجر قبل طلب كابتن.");
                    }
                    if (!storeImage && !storeImagePath) {
                        throw new https_1.HttpsError("failed-precondition", "يرجى رفع صورة المتجر إلى ملف التاجر قبل طلب كابتن.");
                    }
                    const pickupAddress = (0, validators_js_1.readString)(merchant, "address", "pickupAddress");
                    const merchantPoint = new firestore_1.GeoPoint(pickup.lat, pickup.lng);
                    const orderNumber = `#ELB-${orderCode}`;
                    const orderPayload = {
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
                        createdAt: firestore_1.FieldValue.serverTimestamp(),
                        created_at: firestore_1.FieldValue.serverTimestamp(),
                        updatedAt: firestore_1.FieldValue.serverTimestamp(),
                    };
                    if (customerLatitude !== null && customerLongitude !== null) {
                        const customerPoint = new firestore_1.GeoPoint(customerLatitude, customerLongitude);
                        orderPayload.customerLocation = customerPoint;
                        orderPayload.customerLatitude = customerLatitude;
                        orderPayload.customerLongitude = customerLongitude;
                    }
                    tx.create(codeRef, {
                        code: orderCode,
                        orderCode,
                        orderId: orderRef.id,
                        merchantId: uid,
                        createdAt: firestore_1.FieldValue.serverTimestamp(),
                    });
                    tx.create(idempotencyRef, {
                        idempotencyKey,
                        orderId: orderRef.id,
                        orderCode,
                        merchantId: uid,
                        createdAt: firestore_1.FieldValue.serverTimestamp(),
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
                        updatedAt: firestore_1.FieldValue.serverTimestamp(),
                    }, { merge: true });
                    const resolvedPlan = (0, validators_js_1.resolveCanonicalPlanIdentifier)(merchant, subscription);
                    return {
                        replay: false,
                        orderId: orderRef.id,
                        orderCode,
                        maxCaptains,
                        activeCaptainsCount: activeOrderCount + 1,
                        remainingCaptains: Math.max(0, maxCaptains - activeOrderCount - 1),
                        planId: resolvedPlan.planId,
                        planKey: resolvedPlan.planKey,
                        planName: (0, validators_js_1.readString)(subscription, "planName", "packageName", "name") ||
                            (0, validators_js_1.readString)(merchant, "planName", "packageName"),
                        subscriptionVersion: (_g = (0, validators_js_1.readNumber)(subscription, "subscriptionVersion")) !== null && _g !== void 0 ? _g : 1,
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
            }
            catch (err) {
                if (err instanceof Error && err.message === "ORDER_CODE_COLLISION") {
                    continue;
                }
                throw err;
            }
        }
        throw new https_1.HttpsError("resource-exhausted", "تعذر تخصيص كود طلب فريد بعد عدة محاولات. يرجى إعادة المحاولة.");
    }
    catch (err) {
        throw mapError(err);
    }
});
/** Backward-compatible merchant Android callable names. */
exports.requestCaptains = exports.merchantCreateOrder;
exports.createOrderWithCode = exports.merchantCreateOrder;
/**
 * Merchant cancels an order before it is picked up. Any matching offer/trip reservation
 * is released in the same transaction so the captain becomes eligible again.
 */
exports.merchantCancelOrder = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b, _c, _d;
    try {
        const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
        if (!uid)
            throw new https_1.HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً.");
        if (((_b = request.auth) === null || _b === void 0 ? void 0 : _b.token.email_verified) !== true) {
            throw new https_1.HttpsError("permission-denied", "يجب تأكيد البريد الإلكتروني أولاً.");
        }
        const orderId = requireOrderId(((_c = request.data) !== null && _c !== void 0 ? _c : {}).orderId);
        const reason = (0, validators_js_1.readString)(request.data, "reason").slice(0, 500);
        const db = (0, firestore_1.getFirestore)();
        const orderRef = db.collection("orders").doc(orderId);
        const merchantRef = db.collection("merchants").doc(uid);
        const [merchantSnap] = await Promise.all([merchantRef.get()]);
        const merchant = (_d = merchantSnap.data()) !== null && _d !== void 0 ? _d : {};
        if (!merchantSnap.exists ||
            (0, validators_js_1.readString)(merchant, "accountType").toLowerCase() !== "merchant" ||
            !["approved", "active"].includes((0, validators_js_1.readString)(merchant, "status").toLowerCase())) {
            throw new https_1.HttpsError("permission-denied", "حساب التاجر غير مؤهل لإلغاء الطلب.");
        }
        const result = await db.runTransaction(async (tx) => {
            var _a;
            const orderSnap = await tx.get(orderRef);
            if (!orderSnap.exists)
                throw new https_1.HttpsError("not-found", "الطلب غير موجود.");
            const order = (_a = orderSnap.data()) !== null && _a !== void 0 ? _a : {};
            if ((0, validators_js_1.readString)(order, "merchantId", "restaurantId", "userId") !== uid) {
                throw new https_1.HttpsError("permission-denied", "هذا الطلب لا يخص متجرك.");
            }
            const status = (0, validators_js_1.readNormalizedOrderStatus)(order);
            if (["picked_up", "order_data_entered", "awaiting_merchant_confirmation",
                "awaiting_confirmation", "merchant_rejected", "en_route", "confirmed",
                "merchant_confirmed", "out_for_delivery", "delivering", "delivered",
                "completed", "done"].includes(status)) {
                throw new https_1.HttpsError("failed-precondition", "لا يمكن إلغاء الطلب بعد استلامه من المتجر أو بدء توصيله.");
            }
            if (["cancelled", "canceled"].includes(status)) {
                return { alreadyCancelled: true };
            }
            const offeredUid = (0, validators_js_1.readString)(order, "offeredCaptainId");
            const assignedUid = (0, validators_js_1.extractOrderCaptainUid)(order);
            const captainIds = Array.from(new Set([offeredUid, assignedUid].filter(Boolean)));
            const captainRefs = captainIds.map((captainId) => db.collection("captains").doc(captainId));
            const captainSnaps = await Promise.all(captainRefs.map((ref) => tx.get(ref)));
            captainSnaps.forEach((snap, index) => {
                var _a;
                if (!snap.exists)
                    return;
                const captain = (_a = snap.data()) !== null && _a !== void 0 ? _a : {};
                const patch = {};
                if ((0, validators_js_1.readString)(captain, "currentOrderId") === orderId) {
                    patch.currentOrderId = null;
                    patch.activeMerchantId = firestore_1.FieldValue.delete();
                    patch.currentMerchantId = firestore_1.FieldValue.delete();
                    if ((0, validators_js_1.readString)(captain, "presenceStatus") === "on_trip") {
                        patch.presenceStatus = "available";
                    }
                }
                if ((0, validators_js_1.readString)(captain, "activeOfferOrderId") === orderId) {
                    patch.activeOfferOrderId = null;
                    patch.activeOfferGeneration = null;
                    patch.activeOfferExpiresAt = null;
                }
                if (Object.keys(patch).length > 0) {
                    patch.updatedAt = firestore_1.FieldValue.serverTimestamp();
                    tx.update(captainRefs[index], patch);
                }
            });
            tx.update(orderRef, {
                status: "cancelled",
                dispatchStatus: "cancelled",
                offeredCaptainId: null,
                offeredCaptainName: null,
                offerExpiresAt: null,
                cancelledAt: firestore_1.FieldValue.serverTimestamp(),
                cancelledBy: uid,
                cancellationReason: reason || "إلغاء من قبل التاجر",
                status_ar: "ملغي",
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            return { alreadyCancelled: false };
        });
        return Object.assign({ success: true, orderId }, result);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Merchant edits delivery details and the merchant-entered fee only while the order
 * is still searching and has not been offered or assigned to a captain.
 */
exports.merchantUpdateOrderDetails = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b, _c, _d;
    try {
        const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
        if (!uid)
            throw new https_1.HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً.");
        if (((_b = request.auth) === null || _b === void 0 ? void 0 : _b.token.email_verified) !== true) {
            throw new https_1.HttpsError("permission-denied", "يجب تأكيد البريد الإلكتروني أولاً.");
        }
        const data = ((_c = request.data) !== null && _c !== void 0 ? _c : {});
        const orderId = requireOrderId(data.orderId);
        const destinationAddress = (0, validators_js_1.readString)(data, "destinationAddress", "deliveryAddress", "address");
        const orderDetails = (0, validators_js_1.readString)(data, "orderDetails", "items").slice(0, 4000);
        const customerName = (0, validators_js_1.readString)(data, "customerName").slice(0, 200);
        const customerPhone = (0, validators_js_1.readString)(data, "customerPhone").slice(0, 40);
        const deliveryNotes = (0, validators_js_1.readString)(data, "deliveryNotes", "notes").slice(0, 1000);
        const serviceFee = (0, validators_js_1.readString)(data, "serviceFee", "price");
        if (!destinationAddress || destinationAddress.length > 1000) {
            throw new https_1.HttpsError("invalid-argument", "عنوان التوصيل مطلوب ويجب ألا يتجاوز 1000 حرف.");
        }
        if (!serviceFee) {
            throw new https_1.HttpsError("invalid-argument", "يرجى إدخال قيمة خدمة التوصيل من تطبيق التاجر.");
        }
        const feeMatch = serviceFee.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
        if (!feeMatch) {
            throw new https_1.HttpsError("invalid-argument", "قيمة خدمة التوصيل يجب أن تحتوي على مبلغ رقمي واضح.");
        }
        const deliveryFee = Number(feeMatch[0]);
        if (!Number.isFinite(deliveryFee) || deliveryFee < 0 || deliveryFee > 100000) {
            throw new https_1.HttpsError("invalid-argument", "قيمة خدمة التوصيل غير صالحة.");
        }
        const db = (0, firestore_1.getFirestore)();
        const merchantSnap = await db.collection("merchants").doc(uid).get();
        const merchant = (_d = merchantSnap.data()) !== null && _d !== void 0 ? _d : {};
        if (!merchantSnap.exists ||
            (0, validators_js_1.readString)(merchant, "accountType").toLowerCase() !== "merchant" ||
            !["approved", "active"].includes((0, validators_js_1.readString)(merchant, "status").toLowerCase())) {
            throw new https_1.HttpsError("permission-denied", "حساب التاجر غير مؤهل لتعديل الطلب.");
        }
        const orderRef = db.collection("orders").doc(orderId);
        await db.runTransaction(async (tx) => {
            var _a;
            const orderSnap = await tx.get(orderRef);
            if (!orderSnap.exists)
                throw new https_1.HttpsError("not-found", "الطلب غير موجود.");
            const order = (_a = orderSnap.data()) !== null && _a !== void 0 ? _a : {};
            if ((0, validators_js_1.readString)(order, "merchantId", "restaurantId", "userId") !== uid) {
                throw new https_1.HttpsError("permission-denied", "هذا الطلب لا يخص متجرك.");
            }
            const status = (0, validators_js_1.readNormalizedOrderStatus)(order);
            const assignedCaptainId = (0, validators_js_1.extractOrderCaptainUid)(order);
            const offeredCaptainId = (0, validators_js_1.readString)(order, "offeredCaptainId");
            if (assignedCaptainId ||
                offeredCaptainId ||
                !["pending", "searching"].includes(status)) {
                throw new https_1.HttpsError("failed-precondition", "لا يمكن تعديل الرسوم أو بيانات الطلب بعد إرسال العرض إلى كابتن أو بدء التنفيذ.");
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
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
                merchantEditedAt: firestore_1.FieldValue.serverTimestamp(),
                merchantEditedBy: uid,
            });
        });
        return { success: true, orderId, serviceFee, deliveryFee };
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Admin creates an unassigned order. The created document is the source of truth;
 * the Firestore create trigger dispatches it to an eligible captain.
 */
exports.adminCreateOrder = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    try {
        const adminUid = await requireAdminUid((_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid, ((_c = (_b = request.auth) === null || _b === void 0 ? void 0 : _b.token) !== null && _c !== void 0 ? _c : {}));
        const data = ((_d = request.data) !== null && _d !== void 0 ? _d : {});
        const merchantId = String((_f = (_e = data.merchantId) !== null && _e !== void 0 ? _e : data.restaurantId) !== null && _f !== void 0 ? _f : "").trim();
        if (!merchantId || merchantId.length > 128 || merchantId.includes("/")) {
            throw new https_1.HttpsError("invalid-argument", "يجب تحديد التاجر الصحيح.");
        }
        const deliveryAddress = (0, validators_js_1.readString)(data, "deliveryAddress", "customerAddress");
        if (!deliveryAddress) {
            throw new https_1.HttpsError("invalid-argument", "عنوان العميل مطلوب.");
        }
        const db = (0, firestore_1.getFirestore)();
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
            throw new https_1.HttpsError("failed-precondition", "ملف التاجر أو سجل الاشتراك غير موجود.");
        }
        const merchantStatus = (0, validators_js_1.readString)(merchantData, "status").toLowerCase();
        if (!["approved", "active"].includes(merchantStatus)) {
            throw new https_1.HttpsError("failed-precondition", "حساب التاجر غير معتمد أو غير نشط.");
        }
        (0, validators_js_1.assertMerchantAndSubscriptionValid)(merchantId, merchantData, subscriptionSnap.data(), Date.now());
        const pickup = (0, validators_js_1.extractCoordinates)(merchantData);
        if (!pickup) {
            throw new https_1.HttpsError("failed-precondition", "موقع التاجر غير مكتمل. حدّث إحداثيات المتجر قبل إرسال الطلب.");
        }
        const deliveryFee = (_g = (0, validators_js_1.readNumber)(data, "deliveryFee")) !== null && _g !== void 0 ? _g : 0;
        const subtotal = (_h = (0, validators_js_1.readNumber)(data, "subtotal")) !== null && _h !== void 0 ? _h : 0;
        const total = (_j = (0, validators_js_1.readNumber)(data, "total")) !== null && _j !== void 0 ? _j : subtotal + deliveryFee;
        if (deliveryFee < 0 || subtotal < 0 || total < 0 ||
            !Number.isFinite(deliveryFee + subtotal + total)) {
            throw new https_1.HttpsError("invalid-argument", "قيم الطلب المالية غير صالحة.");
        }
        const itemsRaw = Array.isArray(data.items) ? data.items : [];
        if (itemsRaw.length > 100) {
            throw new https_1.HttpsError("invalid-argument", "عدد عناصر الطلب أكبر من الحد المسموح.");
        }
        const items = itemsRaw.map((raw) => {
            var _a, _b;
            const item = (raw !== null && raw !== void 0 ? raw : {});
            const name = (0, validators_js_1.readString)(item, "name", "title");
            const quantity = (_a = (0, validators_js_1.readNumber)(item, "quantity")) !== null && _a !== void 0 ? _a : 1;
            const price = (_b = (0, validators_js_1.readNumber)(item, "price")) !== null && _b !== void 0 ? _b : 0;
            if (!name || quantity <= 0 || quantity > 999 || price < 0) {
                throw new https_1.HttpsError("invalid-argument", "أحد عناصر الطلب يحتوي على بيانات غير صالحة.");
            }
            return { name: name.slice(0, 200), quantity, price };
        });
        const requestedCaptainId = (0, validators_js_1.readString)(data, "captainId", "requestedCaptainId");
        if (requestedCaptainId && requestedCaptainId.length > 128) {
            throw new https_1.HttpsError("invalid-argument", "معرف الكابتن غير صالح.");
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
        const merchantName = (0, validators_js_1.readString)(merchantData, "name", "merchantName", "restaurantName");
        const merchantPhone = (0, validators_js_1.readString)(merchantData, "phone", "phoneNumber", "mobile");
        const imageCandidates = [
            (0, validators_js_1.readString)(merchantData, "logo"),
            (0, validators_js_1.readString)(merchantData, "photoUrl"),
            (0, validators_js_1.readString)(merchantData, "logoUrl"),
            (0, validators_js_1.readString)(merchantData, "imageUrl"),
            (0, validators_js_1.readString)(merchantData, "profileImageUrl"),
        ];
        const storeImage = imageCandidates.find((value) => value.startsWith("https://") || value.startsWith("http://")) || "";
        const storeImagePath = [
            (0, validators_js_1.readString)(merchantData, "storagePath"),
            (0, validators_js_1.readString)(merchantData, "profileImagePath"),
            (0, validators_js_1.readString)(merchantData, "logoStoragePath"),
            ...imageCandidates,
        ].find((value) => value.startsWith("gs://") || value.startsWith(`merchants/${merchantId}/`)) || "";
        const pickupAddress = (0, validators_js_1.readString)(merchantData, "address", "pickupAddress", "storeAddress");
        if (!merchantName || !merchantPhone || (!storeImage && !storeImagePath)) {
            throw new https_1.HttpsError("failed-precondition", "بيانات اسم التاجر أو هاتفه أو صورة المتجر غير مكتملة.");
        }
        const idempotencyKey = (0, validators_js_1.readString)(data, "idempotencyKey");
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
            throw new https_1.HttpsError("invalid-argument", "مفتاح منع التكرار غير صالح.");
        }
        const idempotencyRef = db.collection("admin_order_idempotency").doc(idempotencyKey);
        const previousRequest = await idempotencyRef.get();
        if (previousRequest.exists) {
            const previous = (_k = previousRequest.data()) !== null && _k !== void 0 ? _k : {};
            if ((0, validators_js_1.readString)(previous, "merchantId") !== merchantId) {
                throw new https_1.HttpsError("permission-denied", "مفتاح الطلب مستخدم لحساب آخر.");
            }
            const previousCode = (0, validators_js_1.readString)(previous, "orderCode");
            return {
                success: true,
                orderId: (0, validators_js_1.readString)(previous, "orderId"),
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
                    var _a, _b, _c, _d, _e, _f, _g;
                    const [currentMerchantSnap, currentRestaurantSnap, currentSubscriptionSnap, codeSnap, keySnap, merchantOrdersSnap, restaurantOrdersSnap, userOrdersSnap, capacitySnap,] = await Promise.all([
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
                        const previous = (_a = keySnap.data()) !== null && _a !== void 0 ? _a : {};
                        if ((0, validators_js_1.readString)(previous, "merchantId") !== merchantId) {
                            throw new https_1.HttpsError("permission-denied", "مفتاح الطلب مستخدم لحساب آخر.");
                        }
                        return;
                    }
                    if ((!currentMerchantSnap.exists && !currentRestaurantSnap.exists) || !currentSubscriptionSnap.exists) {
                        throw new https_1.HttpsError("failed-precondition", "ملف التاجر أو الاشتراك غير موجود.");
                    }
                    const currentMerchant = currentMerchantSnap.exists
                        ? (_b = currentMerchantSnap.data()) !== null && _b !== void 0 ? _b : {}
                        : (_c = currentRestaurantSnap.data()) !== null && _c !== void 0 ? _c : {};
                    const currentSubscription = (_d = currentSubscriptionSnap.data()) !== null && _d !== void 0 ? _d : {};
                    (0, validators_js_1.assertMerchantAndSubscriptionValid)(merchantId, currentMerchant, currentSubscription, Date.now());
                    if (codeSnap.exists)
                        throw new Error("ORDER_CODE_COLLISION");
                    const maxCaptains = (0, validators_js_1.resolveEffectiveCaptainLimit)(currentMerchant, currentSubscription);
                    if (maxCaptains < validators_js_1.MIN_PACKAGE_CAPTAINS || maxCaptains > validators_js_1.MAX_PACKAGE_CAPTAINS) {
                        throw new https_1.HttpsError("failed-precondition", "باقة التاجر لا تحتوي على حد كباتن صالح (1 إلى 100).");
                    }
                    const activeOrderIds = new Set();
                    for (const snapshot of [merchantOrdersSnap, restaurantOrdersSnap, userOrdersSnap]) {
                        for (const orderDoc of snapshot.docs) {
                            if (!(0, validators_js_1.isTerminalMerchantOrderStatus)((0, validators_js_1.readNormalizedOrderStatus)((_e = orderDoc.data()) !== null && _e !== void 0 ? _e : {}))) {
                                activeOrderIds.add(orderDoc.id);
                            }
                        }
                    }
                    const activeOrderCount = activeOrderIds.size;
                    if (activeOrderCount >= maxCaptains) {
                        throw new https_1.HttpsError("resource-exhausted", `وصل التاجر إلى الحد المتزامن للباقة: ${activeOrderCount} من ${maxCaptains} طلبات نشطة.`);
                    }
                    const capacityVersion = (_g = (0, validators_js_1.readNumber)((_f = capacitySnap.data()) !== null && _f !== void 0 ? _f : {}, "capacityVersion")) !== null && _g !== void 0 ? _g : 0;
                    const orderNumber = `#ELB-${orderCode}`;
                    tx.create(codeRef, {
                        code: orderCode,
                        orderCode,
                        orderId: orderRef.id,
                        merchantId,
                        createdAt: firestore_1.FieldValue.serverTimestamp(),
                    });
                    tx.create(idempotencyRef, {
                        idempotencyKey,
                        orderId: orderRef.id,
                        orderCode,
                        merchantId,
                        createdAt: firestore_1.FieldValue.serverTimestamp(),
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
                        customerName: (0, validators_js_1.readString)(data, "customerName").slice(0, 200),
                        customerPhone: (0, validators_js_1.readString)(data, "customerPhone").slice(0, 40),
                        deliveryFee,
                        delivery_fee: deliveryFee,
                        subtotal,
                        total,
                        items,
                        notes: (0, validators_js_1.readString)(data, "notes").slice(0, 1000),
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
                        createdAt: firestore_1.FieldValue.serverTimestamp(),
                        updatedAt: firestore_1.FieldValue.serverTimestamp(),
                    });
                    const reservedOrderIds = [...activeOrderIds, orderRef.id];
                    tx.set(capacityRef, {
                        merchantId,
                        reservedOrderIds,
                        activeReservationsCount: reservedOrderIds.length,
                        captainLimitSnapshot: maxCaptains,
                        capacityVersion: capacityVersion + 1,
                        lastReservedOrderId: orderRef.id,
                        updatedAt: firestore_1.FieldValue.serverTimestamp(),
                    }, { merge: true });
                });
                const codeAfter = await codeRef.get();
                if (!codeAfter.exists) {
                    const replay = await idempotencyRef.get();
                    if (replay.exists) {
                        const previous = (_l = replay.data()) !== null && _l !== void 0 ? _l : {};
                        const previousCode = (0, validators_js_1.readString)(previous, "orderCode");
                        return {
                            success: true,
                            orderId: (0, validators_js_1.readString)(previous, "orderId"),
                            orderCode: previousCode,
                            orderNumber: `#ELB-${previousCode}`,
                            status: "pending",
                            dispatchStatus: "existing",
                            isReplay: true,
                        };
                    }
                    throw new https_1.HttpsError("aborted", "لم يتم حجز الطلب؛ أعد المحاولة.");
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
            }
            catch (err) {
                if (err instanceof Error && err.message === "ORDER_CODE_COLLISION")
                    continue;
                throw err;
            }
        }
        throw new https_1.HttpsError("resource-exhausted", "تعذر تخصيص كود طلب فريد بعد عدة محاولات.");
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Admin dispatches an existing unassigned order to a specific eligible captain.
 * The captain receives a 60-second offer; assignment is not final until acceptance.
 */
exports.adminAssignCaptain = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b, _c, _d;
    try {
        await requireAdminUid((_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid, ((_c = (_b = request.auth) === null || _b === void 0 ? void 0 : _b.token) !== null && _c !== void 0 ? _c : {}));
        const data = ((_d = request.data) !== null && _d !== void 0 ? _d : {});
        const orderId = requireOrderId(data.orderId);
        const captainId = typeof data.captainId === "string" ? data.captainId.trim() : "";
        if (!captainId || captainId.length > 128 || captainId.includes("/")) {
            throw new https_1.HttpsError("invalid-argument", "يجب تحديد كابتن صالح.");
        }
        const outcome = await service.dispatchNewOrSearchingOrder(orderId, captainId);
        if (outcome.status === "no_captains_available") {
            throw new https_1.HttpsError("failed-precondition", "الكابتن المحدد غير متاح أو خارج الشفت أو موقعه غير حديث.");
        }
        if (outcome.status !== "offered") {
            throw new https_1.HttpsError("failed-precondition", "لا يمكن تعيين كابتن لهذا الطلب في حالته الحالية.");
        }
        return Object.assign({ success: true }, outcome);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Admin requests an automatic server-side search for the nearest eligible captain.
 */
exports.adminDispatchOrder = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b, _c, _d;
    try {
        await requireAdminUid((_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid, ((_c = (_b = request.auth) === null || _b === void 0 ? void 0 : _b.token) !== null && _c !== void 0 ? _c : {}));
        const data = ((_d = request.data) !== null && _d !== void 0 ? _d : {});
        const outcome = await service.dispatchNewOrSearchingOrder(requireOrderId(data.orderId));
        if (outcome.status === "no_captains_available") {
            throw new https_1.HttpsError("failed-precondition", "لا يوجد كابتن متاح حاليًا. سيستمر النظام في البحث.");
        }
        if (outcome.status !== "offered") {
            throw new https_1.HttpsError("failed-precondition", "الطلب ليس متاحًا لبدء توزيع جديد.");
        }
        return Object.assign({ success: true }, outcome);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Admin cancellation releases any matching offer/current-order reservation.
 */
exports.adminCancelOrder = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b, _c, _d;
    try {
        const adminUid = await requireAdminUid((_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid, ((_c = (_b = request.auth) === null || _b === void 0 ? void 0 : _b.token) !== null && _c !== void 0 ? _c : {}));
        const data = ((_d = request.data) !== null && _d !== void 0 ? _d : {});
        const orderId = requireOrderId(data.orderId);
        const reason = (0, validators_js_1.readString)(data, "reason").slice(0, 500);
        const db = (0, firestore_1.getFirestore)();
        const orderRef = db.collection("orders").doc(orderId);
        const result = await db.runTransaction(async (tx) => {
            var _a;
            const orderSnap = await tx.get(orderRef);
            if (!orderSnap.exists) {
                throw new https_1.HttpsError("not-found", "الطلب غير موجود.");
            }
            const order = (_a = orderSnap.data()) !== null && _a !== void 0 ? _a : {};
            const status = (0, validators_js_1.readNormalizedOrderStatus)(order);
            if (["delivered", "completed", "done"].includes(status)) {
                throw new https_1.HttpsError("failed-precondition", "لا يمكن إلغاء طلب تم تسليمه.");
            }
            if (["cancelled", "canceled"].includes(status)) {
                return { alreadyCancelled: true };
            }
            const offeredUid = typeof order.offeredCaptainId === "string"
                ? order.offeredCaptainId.trim()
                : "";
            const assignedUid = (0, validators_js_1.extractOrderCaptainUid)(order);
            const captainIds = Array.from(new Set([offeredUid, assignedUid].filter(Boolean)));
            const captainRefs = captainIds.map((uid) => db.collection("captains").doc(uid));
            const captainSnaps = await Promise.all(captainRefs.map((ref) => tx.get(ref)));
            captainSnaps.forEach((snap, index) => {
                var _a;
                if (!snap.exists)
                    return;
                const captain = (_a = snap.data()) !== null && _a !== void 0 ? _a : {};
                const patch = {};
                if (captain.currentOrderId === orderId) {
                    patch.currentOrderId = null;
                    patch.activeMerchantId = firestore_1.FieldValue.delete();
                    patch.currentMerchantId = firestore_1.FieldValue.delete();
                    if (captain.presenceStatus === "on_trip") {
                        patch.presenceStatus = "available";
                    }
                }
                if (captain.activeOfferOrderId === orderId) {
                    patch.activeOfferOrderId = null;
                    patch.activeOfferGeneration = null;
                    patch.activeOfferExpiresAt = null;
                }
                if (Object.keys(patch).length > 0) {
                    patch.updatedAt = firestore_1.FieldValue.serverTimestamp();
                    tx.update(captainRefs[index], patch);
                }
            });
            tx.update(orderRef, {
                status: "cancelled",
                dispatchStatus: "cancelled",
                offeredCaptainId: null,
                offeredCaptainName: null,
                offerExpiresAt: null,
                cancelledAt: firestore_1.FieldValue.serverTimestamp(),
                cancelledBy: adminUid,
                cancellationReason: reason || "تم الإلغاء بواسطة الإدارة",
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            return { alreadyCancelled: false };
        });
        return Object.assign({ success: true, orderId }, result);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Admin may record a missing audit timestamp only after the server-side lifecycle reached that stage.
 */
exports.adminRecordOrderStageTimestamp = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b, _c, _d;
    try {
        await requireAdminUid((_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid, ((_c = (_b = request.auth) === null || _b === void 0 ? void 0 : _b.token) !== null && _c !== void 0 ? _c : {}));
        const data = ((_d = request.data) !== null && _d !== void 0 ? _d : {});
        const orderId = requireOrderId(data.orderId);
        const field = (0, validators_js_1.readString)(data, "field");
        const allowed = {
            acceptedAt: ["accepted", "assigned", "arrived_at_merchant", "at_store", "picked_up", "en_route", "delivered"],
            arrivedAtMerchantAt: ["arrived_at_merchant", "at_store", "arrived", "picked_up", "en_route", "delivered"],
            pickedUpAt: ["picked_up", "order_data_entered", "awaiting_merchant_confirmation", "en_route", "delivered"],
            deliveredAt: ["delivered", "completed", "done"],
        };
        if (!Object.prototype.hasOwnProperty.call(allowed, field)) {
            throw new https_1.HttpsError("invalid-argument", "حقل التوقيت غير مسموح.");
        }
        const db = (0, firestore_1.getFirestore)();
        const orderRef = db.collection("orders").doc(orderId);
        const stamp = new Date();
        const iso = stamp.toISOString();
        const result = await db.runTransaction(async (tx) => {
            var _a;
            const snap = await tx.get(orderRef);
            if (!snap.exists)
                throw new https_1.HttpsError("not-found", "الطلب غير موجود.");
            const order = (_a = snap.data()) !== null && _a !== void 0 ? _a : {};
            const status = (0, validators_js_1.readNormalizedOrderStatus)(order);
            if (!allowed[field].includes(status)) {
                throw new https_1.HttpsError("failed-precondition", "لا يمكن تسجيل هذا التوقيت قبل وصول الطلب إلى المرحلة المقابلة.");
            }
            if (order[field])
                return { timestamp: order[field], alreadyRecorded: true };
            tx.update(orderRef, {
                [field]: stamp,
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            return { timestamp: iso, alreadyRecorded: false };
        });
        return Object.assign({ success: true, orderId }, result);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Merchant approval/rejection of the captain's submitted receipt and customer details.
 */
exports.merchantConfirmOrder = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b, _c, _d;
    try {
        const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
        if (!uid)
            throw new https_1.HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً.");
        if (((_b = request.auth) === null || _b === void 0 ? void 0 : _b.token.email_verified) !== true) {
            throw new https_1.HttpsError("permission-denied", "يجب تأكيد البريد الإلكتروني لحساب التاجر.");
        }
        const data = ((_c = request.data) !== null && _c !== void 0 ? _c : {});
        const orderId = requireOrderId(data.orderId);
        const confirmed = data.confirmed === true;
        const rejectionReason = (0, validators_js_1.readString)(data, "rejectionReason").slice(0, 500);
        const db = (0, firestore_1.getFirestore)();
        const merchantRef = db.collection("merchants").doc(uid);
        const orderRef = db.collection("orders").doc(orderId);
        const merchantSnap = await merchantRef.get();
        if (!merchantSnap.exists) {
            throw new https_1.HttpsError("permission-denied", "هذا الحساب ليس حساب تاجر مسجلاً.");
        }
        const merchant = (_d = merchantSnap.data()) !== null && _d !== void 0 ? _d : {};
        if (((0, validators_js_1.readString)(merchant, "accountType").toLowerCase() !== "merchant" &&
            (0, validators_js_1.readString)(merchant, "role").toLowerCase() !== "merchant") ||
            !["approved", "active"].includes((0, validators_js_1.readString)(merchant, "status").toLowerCase())) {
            throw new https_1.HttpsError("permission-denied", "حساب التاجر غير مؤهل لاعتماد الطلب.");
        }
        const result = await db.runTransaction(async (tx) => {
            var _a;
            const snap = await tx.get(orderRef);
            if (!snap.exists)
                throw new https_1.HttpsError("not-found", "الطلب غير موجود.");
            const order = (_a = snap.data()) !== null && _a !== void 0 ? _a : {};
            const ownerId = (0, validators_js_1.readString)(order, "merchantId", "restaurantId", "storeId", "vendorId", "ownerId");
            if (ownerId !== uid) {
                throw new https_1.HttpsError("permission-denied", "هذا الطلب لا يخص متجرك.");
            }
            const status = (0, validators_js_1.readNormalizedOrderStatus)(order);
            if (order.merchantConfirmed === true && confirmed && status === "en_route") {
                return { alreadyUpdated: true, status: "en_route" };
            }
            if (status !== "awaiting_merchant_confirmation" &&
                status !== "awaiting_confirmation" &&
                status !== "merchant_rejected") {
                throw new https_1.HttpsError("failed-precondition", "الطلب ليس في انتظار مراجعة بيانات العميل والإيصال.");
            }
            if (confirmed) {
                tx.update(orderRef, {
                    status: "en_route",
                    merchantConfirmed: true,
                    rejectionReason: firestore_1.FieldValue.delete(),
                    merchantConfirmedAt: firestore_1.FieldValue.serverTimestamp(),
                    updatedAt: firestore_1.FieldValue.serverTimestamp(),
                });
                return { alreadyUpdated: false, status: "en_route" };
            }
            tx.update(orderRef, {
                status: "merchant_rejected",
                merchantConfirmed: false,
                rejectionReason: rejectionReason || "بيانات الإيصال أو العميل تحتاج إلى تصحيح",
                merchantRejectedAt: firestore_1.FieldValue.serverTimestamp(),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            return { alreadyUpdated: false, status: "merchant_rejected" };
        });
        // Captain receives the canonical order status through its authenticated Firestore listener.
        // Do not reuse the "new_order" FCM path for merchant confirmation.
        return Object.assign({ success: true, orderId }, result);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Releases a merchant's reserved package slot after an order becomes terminal.
 * The transaction checks the current order and capacity ledger so duplicate trigger
 * deliveries cannot release the same slot twice.
 */
exports.onOrderCapacityReleased = (0, firestore_2.onDocumentUpdated)({ document: "orders/{orderId}", region: "us-central1", retry: true }, async (event) => {
    var _a, _b;
    const before = (_a = event.data) === null || _a === void 0 ? void 0 : _a.before.data();
    const after = (_b = event.data) === null || _b === void 0 ? void 0 : _b.after.data();
    if (!after)
        return;
    const beforeStatus = (0, validators_js_1.readNormalizedOrderStatus)(before !== null && before !== void 0 ? before : {});
    const afterStatus = (0, validators_js_1.readNormalizedOrderStatus)(after);
    if (isClosedMerchantOrderStatus(beforeStatus) || !isClosedMerchantOrderStatus(afterStatus))
        return;
    const merchantId = (0, validators_js_1.readString)(after, "merchantId", "restaurantId", "userId");
    if (!merchantId)
        return;
    const db = (0, firestore_1.getFirestore)();
    const orderId = event.params.orderId;
    const orderRef = db.collection("orders").doc(orderId);
    const capacityRef = db.collection("merchants").doc(merchantId)
        .collection("capacity").doc("current");
    await db.runTransaction(async (tx) => {
        var _a, _b;
        const [orderSnap, capacitySnap] = await Promise.all([
            tx.get(orderRef),
            tx.get(capacityRef),
        ]);
        if (!orderSnap.exists || !capacitySnap.exists)
            return;
        const currentOrder = (_a = orderSnap.data()) !== null && _a !== void 0 ? _a : {};
        if (currentOrder.capacityReleased === true ||
            !isClosedMerchantOrderStatus((0, validators_js_1.readNormalizedOrderStatus)(currentOrder)))
            return;
        const capacity = (_b = capacitySnap.data()) !== null && _b !== void 0 ? _b : {};
        const reservedIds = Array.isArray(capacity.reservedOrderIds)
            ? capacity.reservedOrderIds.map((id) => String(id)).filter(Boolean)
            : [];
        if (!reservedIds.includes(orderId))
            return;
        const remainingIds = reservedIds.filter((id) => id !== orderId);
        tx.update(orderRef, {
            capacityReleased: true,
            capacityReleasedAt: firestore_1.FieldValue.serverTimestamp(),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        tx.set(capacityRef, {
            reservedOrderIds: remainingIds,
            activeReservationsCount: remainingIds.length,
            capacityVersion: firestore_1.FieldValue.increment(1),
            lastReleasedOrderId: orderId,
            terminalStatusAtRelease: (0, validators_js_1.readNormalizedOrderStatus)(currentOrder),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
    });
});
/**
 * Trigger 1: Auto-dispatches newly created pending orders to nearest eligible captain
 * with a server-authored 60-second offer deadline + Cloud Task watchdog.
 */
exports.onOrderCreatedDispatch = (0, firestore_2.onDocumentCreated)({ document: "orders/{orderId}", region: "us-central1", retry: true }, async (event) => {
    var _a, _b, _c;
    const orderId = event.params.orderId;
    const order = (_b = (_a = event.data) === null || _a === void 0 ? void 0 : _a.data()) !== null && _b !== void 0 ? _b : {};
    // Dashboard Functions is the only dispatcher for trusted merchant and admin order creation.
    if (order.dispatchAuthority !== "dashboard_functions" ||
        !["merchantCreateOrder", "adminCreateOrder"].includes(String((_c = order.createdByServerFunction) !== null && _c !== void 0 ? _c : ""))) {
        return;
    }
    await dispatchOrderFromEvent(orderId, "onOrderCreatedDispatch");
});
/**
 * Trigger 2: Handles admin/merchant manual re-queue to searching state without looping.
 */
exports.onOrderUpdatedDispatch = (0, firestore_2.onDocumentUpdated)({ document: "orders/{orderId}", region: "us-central1", retry: true }, async (event) => {
    var _a, _b, _c, _d, _e, _f;
    const after = (_a = event.data) === null || _a === void 0 ? void 0 : _a.after.data();
    const before = (_b = event.data) === null || _b === void 0 ? void 0 : _b.before.data();
    if (!after || !before)
        return;
    const afterStatus = (0, validators_js_1.readNormalizedOrderStatus)(after);
    const afterDispatch = String((_c = after.dispatchStatus) !== null && _c !== void 0 ? _c : "").toLowerCase();
    const beforeDispatch = String((_d = before.dispatchStatus) !== null && _d !== void 0 ? _d : "").toLowerCase();
    const afterOffered = String((_e = after.offeredCaptainId) !== null && _e !== void 0 ? _e : "").trim();
    if (after.dispatchAuthority === "dashboard_functions" &&
        ["merchantCreateOrder", "adminCreateOrder"].includes(String((_f = after.createdByServerFunction) !== null && _f !== void 0 ? _f : "")) &&
        (afterStatus === "pending" || afterStatus === "searching") &&
        afterDispatch === "searching" &&
        beforeDispatch !== "searching" &&
        !afterOffered) {
        await dispatchOrderFromEvent(event.params.orderId, "onOrderUpdatedDispatch");
    }
});
async function allowCaptainDispatchRetry(captainId) {
    const ref = (0, firestore_1.getFirestore)().collection("dispatch_retry_cooldowns").doc(captainId);
    const nowMs = Date.now();
    return (0, firestore_1.getFirestore)().runTransaction(async (tx) => {
        var _a, _b;
        const snap = await tx.get(ref);
        const lastAttemptAtMs = (_b = (0, validators_js_1.readNumber)((_a = snap.data()) !== null && _a !== void 0 ? _a : {}, "lastAttemptAtMs")) !== null && _b !== void 0 ? _b : 0;
        if (nowMs - lastAttemptAtMs < 30000)
            return false;
        tx.set(ref, {
            lastAttemptAtMs: nowMs,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
        return true;
    });
}
async function retryQueuedDashboardOrders() {
    const queued = await (0, firestore_1.getFirestore)()
        .collection("orders")
        .where("dispatchStatus", "==", "no_captains_available")
        .limit(50)
        .get();
    const toMillis = (value) => {
        if (value && typeof value === "object" && "toMillis" in value &&
            typeof value.toMillis === "function") {
            return value.toMillis();
        }
        if (typeof value === "string")
            return Date.parse(value) || 0;
        if (typeof value === "number")
            return value;
        return 0;
    };
    const pending = queued.docs
        .filter((doc) => {
        var _a;
        return doc.get("dispatchAuthority") === "dashboard_functions" &&
            ["pending", "searching"].includes((0, validators_js_1.readNormalizedOrderStatus)((_a = doc.data()) !== null && _a !== void 0 ? _a : {}));
    })
        .sort((a, b) => toMillis(a.get("createdAt")) - toMillis(b.get("createdAt")));
    for (const orderDoc of pending) {
        const outcome = await service.dispatchNewOrSearchingOrder(orderDoc.id);
        // One queue item per trigger prevents notification storms when no eligible captain exists.
        if (outcome.status === "offered" || outcome.status === "no_captains_available")
            break;
    }
}
/**
 * Retry queued orders when a captain becomes available or receives a fresh GPS location.
 * GPS updates are throttled per captain to avoid repeatedly scanning the queue.
 */
exports.retryNoCaptainOrdersWhenCaptainAvailable = (0, firestore_2.onDocumentUpdated)({ document: "captains/{captainId}", region: "us-central1", retry: true }, async (event) => {
    var _a, _b;
    const before = (_a = event.data) === null || _a === void 0 ? void 0 : _a.before.data();
    const after = (_b = event.data) === null || _b === void 0 ? void 0 : _b.after.data();
    if (!after || !isCaptainReadyForDispatch(after))
        return;
    const becameAvailable = !isCaptainReadyForDispatch(before);
    const beforeCoordinates = before ? (0, validators_js_1.extractCoordinates)(before) : null;
    const afterCoordinates = (0, validators_js_1.extractCoordinates)(after);
    const beforeLocationTime = before ? (0, validators_js_1.parseTimestampMs)(before.lastLocationUpdate) : 0;
    const afterLocationTime = (0, validators_js_1.parseTimestampMs)(after.lastLocationUpdate);
    const nowMs = Date.now();
    const wasLocationFresh = beforeLocationTime > 0 && nowMs - beforeLocationTime <= validators_js_1.MAX_LOCATION_AGE_MS;
    const isLocationFresh = afterLocationTime > 0 && nowMs - afterLocationTime <= validators_js_1.MAX_LOCATION_AGE_MS;
    const locationBecameFresh = !!afterCoordinates && isLocationFresh && (!beforeCoordinates || !wasLocationFresh);
    if (!becameAvailable && !locationBecameFresh)
        return;
    const captainId = event.params.captainId;
    if (!await allowCaptainDispatchRetry(captainId))
        return;
    await retryQueuedDashboardOrders();
});
/**
 * A captain can become eligible by entering an active scheduled shift even when
 * their online/presence fields did not change. Re-check the queue on schedule writes.
 */
exports.retryNoCaptainOrdersWhenCaptainScheduleChanges = (0, firestore_2.onDocumentWritten)({ document: "captain_schedules/{captainId}", region: "us-central1", retry: true }, async (event) => {
    var _a;
    if (!((_a = event.data) === null || _a === void 0 ? void 0 : _a.after.exists))
        return;
    const captainId = event.params.captainId;
    const captainSnap = await (0, firestore_1.getFirestore)().collection("captains").doc(captainId).get();
    if (!isCaptainReadyForDispatch(captainSnap.data()))
        return;
    if (!await allowCaptainDispatchRetry(captainId))
        return;
    await retryQueuedDashboardOrders();
});
/**
 * Task Worker: Enforces the server-side 60-second offer expiry window and
 * reassigns to the next nearest eligible captain atomically.
 */
exports.reassignOrderOffer = (0, tasks_1.onTaskDispatched)({
    region: "us-central1",
    retryConfig: {
        maxAttempts: 3,
        minBackoffSeconds: 5,
    },
    rateLimits: {
        maxConcurrentDispatches: 20,
    },
}, async (req) => {
    var _a;
    const payload = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    try {
        await service.handleReassignOfferTask(payload);
    }
    catch (err) {
        logger.error("Error in reassignOrderOffer task", {
            orderId: payload === null || payload === void 0 ? void 0 : payload.orderId,
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }
});
/**
 * Recovery sweep: Cloud Tasks is the primary 60-second watchdog; this scheduled
 * fallback repairs expired offers if task enqueueing or task execution is unavailable.
 */
exports.sweepExpiredOrderOffers = (0, scheduler_1.onSchedule)({
    schedule: "every 1 minutes",
    timeZone: "Africa/Cairo",
    region: "us-central1",
    maxInstances: 1,
}, async () => {
    try {
        const processed = await service.sweepExpiredOffers(100);
        logger.info("Expired-order offer recovery sweep completed", { processed });
    }
    catch (err) {
        logger.error("Expired-order offer recovery sweep failed", {
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }
});
/**
 * Callable 8a: Merchant submits (or resubmits) a manual Vodafone Cash subscription request.
 * Validates auth, merchant ownership, official server package/price/duration, Storage receipt,
 * and prevents duplicates. Always creates/updates in pending_review without activating subscription.
 */
exports.submitManualSubscriptionRequest = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await manualSubService.submitManualSubscriptionRequest(request.auth
            ? {
                uid: request.auth.uid,
                token: request.auth.token,
            }
            : undefined, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Callable 8: Server-authoritative approval of a manual Vodafone Cash subscription request.
 * Atomically approves the request, activates subscriptions/{merchantId} & merchants/{merchantId},
 * creates a single financial record in payments/, writes operation_logs, and notifies the merchant.
 */
exports.approveManualSubscriptionRequest = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await manualSubService.approveManualSubscriptionRequest(request.auth
            ? {
                uid: request.auth.uid,
                token: request.auth.token,
            }
            : undefined, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Callable 9: Server-authoritative rejection of a manual Vodafone Cash subscription request.
 * Records rejection reason and notifies the merchant without activating any subscription.
 */
exports.rejectManualSubscriptionRequest = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await manualSubService.rejectManualSubscriptionRequest(request.auth
            ? {
                uid: request.auth.uid,
                token: request.auth.token,
            }
            : undefined, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Callable 10: Admin requests the merchant to re-upload a clearer Vodafone Cash receipt.
 * Sets status to resubmission_required and preserves previous receipt attempts & audit history.
 */
exports.requestSubscriptionReceiptResubmission = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await manualSubService.requestSubscriptionReceiptResubmission(request.auth
            ? {
                uid: request.auth.uid,
                token: request.auth.token,
            }
            : undefined, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Compatibility alias for requestSubscriptionReceiptResubmission.
 */
exports.requestManualSubscriptionResubmission = exports.requestSubscriptionReceiptResubmission;
/**
 * Callable 11: Master-Admin-only update of Vodafone Cash wallet number, official pricing, and duration.
 */
exports.updateManualSubscriptionSettings = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await manualSubService.updateManualSubscriptionSettings(request.auth
            ? {
                uid: request.auth.uid,
                token: request.auth.token,
            }
            : undefined, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Admin-only callable used by the general Subscriptions dashboard.
 * Creates, edits, renews, suspends, reactivates or cancels the canonical merchant subscription.
 */
exports.adminManageMerchantSubscription = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await manualSubService.manageMerchantSubscription(request.auth
            ? { uid: request.auth.uid, token: request.auth.token }
            : undefined, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Admin-only callable to record a manual payment in the central financial ledger.
 * Uses an idempotency key to prevent duplicate records, and atomically activates/renews
 * subscriptions/{merchantId} + merchants/{merchantId} ONLY when explicitly linked to a paid package.
 */
exports.recordManualPayment = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await manualSubService.recordManualPayment(request.auth
            ? { uid: request.auth.uid, token: request.auth.token }
            : undefined, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Trigger 3: Notifies admins whenever a merchant submits a new manual subscription request.
 */
exports.onManualSubscriptionRequestCreated = (0, firestore_2.onDocumentCreated)({ document: "manual_subscription_requests/{requestId}", region: "us-central1", retry: true }, async (event) => {
    var _a;
    const requestId = event.params.requestId;
    const data = (_a = event.data) === null || _a === void 0 ? void 0 : _a.data();
    if (!data)
        return;
    try {
        await manualSubService.handleNewManualSubscriptionRequest(requestId, data);
    }
    catch (err) {
        logger.error("Failed to process new manual subscription request alert", {
            requestId,
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }
});
/**
 * Captain Moderation Callables: server-authoritative approval, rejection,
 * temporary suspension, reactivation, and permanent blocking.
 */
exports.adminApproveCaptain = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await captainApprovalService.approveCaptain(request.auth
            ? { uid: request.auth.uid, token: request.auth.token }
            : undefined, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
exports.adminRejectCaptain = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await captainApprovalService.rejectCaptain(request.auth
            ? { uid: request.auth.uid, token: request.auth.token }
            : undefined, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
exports.adminSuspendCaptain = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await captainApprovalService.suspendCaptain(request.auth
            ? { uid: request.auth.uid, token: request.auth.token }
            : undefined, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
exports.adminReactivateCaptain = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await captainApprovalService.reactivateCaptain(request.auth
            ? { uid: request.auth.uid, token: request.auth.token }
            : undefined, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
exports.adminBlockCaptain = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await captainApprovalService.blockCaptain(request.auth
            ? { uid: request.auth.uid, token: request.auth.token }
            : undefined, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Trigger 4: Notifies admins and logs initial registration when a new captain signs up.
 */
exports.onCaptainCreated = (0, firestore_2.onDocumentCreated)({ document: "captains/{captainId}", region: "us-central1", retry: true }, async (event) => {
    var _a;
    const captainId = event.params.captainId;
    const data = (_a = event.data) === null || _a === void 0 ? void 0 : _a.data();
    if (!data)
        return;
    try {
        await captainApprovalService.handleNewCaptainCreated(captainId, data);
    }
    catch (err) {
        logger.error("Failed to process new captain registration alert", {
            captainId,
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }
});
//# sourceMappingURL=index.js.map