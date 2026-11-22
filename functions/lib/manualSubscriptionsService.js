"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManualSubscriptionsServerService = void 0;
exports.isSafeMerchantReceipt = isSafeMerchantReceipt;
const node_crypto_1 = require("node:crypto");
const types_js_1 = require("./types.js");
const validators_js_1 = require("./validators.js");
const REVIEWABLE_STATUSES = new Set([
    "pending_review",
    "pending",
    "under_review",
    "resubmission_required",
    "resubmission_requested",
]);
const ACTIVE_PENDING_STATUSES = new Set([
    "pending_review",
    "pending",
    "under_review",
]);
const RESUBMISSION_STATUSES = new Set([
    "resubmission_required",
    "resubmission_requested",
]);
function isValidDocId(id) {
    return id.length >= 1 && id.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(id);
}
/**
 * Creates a deterministic, collision-resistant document ID for a Vodafone Cash transaction reference.
 * @param {string} reference Raw transaction reference.
 * @return {string} SHA-256 lock document ID.
 */
function createTransactionReferenceLockId(reference) {
    return (0, node_crypto_1.createHash)("sha256")
        .update(reference.trim().toUpperCase(), "utf8")
        .digest("hex");
}
function normalizeStatus(raw) {
    return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}
const LEGACY_NUMERIC_PLAN_TO_CAPTAINS = {
    1: 2,
    2: 4,
    3: 6,
    4: 8,
};
/**
 * Resolves an official plan from `settings/manual_subscription_config.plans` with strict priority:
 * 1. Exact `planId` match ALWAYS takes priority (even over `maxCaptains`, and even if disabled so callers
 *    can explicitly reject a disabled package rather than silently falling back to another package).
 * 2. Legacy numeric plan ID (`1..4`) falls back to legacy captain counts (`2, 4, 6, 8`) only if no exact
 *    `planId` matched.
 * 3. `maxCaptains` lookup is used ONLY when no explicit non-numeric `planId` was provided.
 */
function findAuthoritativePlan(configuredPlans, opts) {
    var _a, _b, _c, _d, _e;
    const cleanPlanId = ((_a = opts.planId) !== null && _a !== void 0 ? _a : "").trim();
    if (cleanPlanId) {
        const exact = configuredPlans.find((p) => (0, validators_js_1.readString)(p, "planId") === cleanPlanId);
        if (exact)
            return exact;
    }
    const numericKey = opts.numericPlanId !== undefined && opts.numericPlanId !== null
        ? Math.round(opts.numericPlanId)
        : /^\d+$/.test(cleanPlanId)
            ? Number(cleanPlanId)
            : null;
    if (numericKey !== null) {
        const legacyCaps = (_b = LEGACY_NUMERIC_PLAN_TO_CAPTAINS[numericKey]) !== null && _b !== void 0 ? _b : 0;
        if (legacyCaps > 0) {
            return ((_c = configuredPlans.find((p) => {
                var _a;
                return p.isActive !== false &&
                    Math.round((_a = (0, validators_js_1.readNumber)(p, "maxCaptains", "captainsCount")) !== null && _a !== void 0 ? _a : 0) === legacyCaps;
            })) !== null && _c !== void 0 ? _c : configuredPlans.find((p) => { var _a; return Math.round((_a = (0, validators_js_1.readNumber)(p, "maxCaptains", "captainsCount")) !== null && _a !== void 0 ? _a : 0) === legacyCaps; }));
        }
        return undefined;
    }
    // If a non-numeric explicit planId was provided and did not match any configured plan,
    // NEVER fall back to an unrelated package that merely shares the same maxCaptains.
    if (cleanPlanId) {
        return undefined;
    }
    const requestedCaps = Math.round((_d = opts.maxCaptains) !== null && _d !== void 0 ? _d : 0);
    if (requestedCaps >= validators_js_1.MIN_PACKAGE_CAPTAINS && requestedCaps <= validators_js_1.MAX_PACKAGE_CAPTAINS) {
        return ((_e = configuredPlans.find((p) => {
            var _a;
            return p.isActive !== false &&
                Math.round((_a = (0, validators_js_1.readNumber)(p, "maxCaptains", "captainsCount")) !== null && _a !== void 0 ? _a : 0) === requestedCaps;
        })) !== null && _e !== void 0 ? _e : configuredPlans.find((p) => { var _a; return Math.round((_a = (0, validators_js_1.readNumber)(p, "maxCaptains", "captainsCount")) !== null && _a !== void 0 ? _a : 0) === requestedCaps; }));
    }
    return undefined;
}
function isSubscriptionCurrentlyActive(merchantData, subscriptionData, nowMs) {
    const statuses = [
        normalizeStatus(subscriptionData.status),
        normalizeStatus(subscriptionData.subscriptionStatus),
        normalizeStatus(merchantData.subscriptionStatus),
    ];
    // merchantData.status / isActive are account-level fields in legacy documents,
    // so only explicit subscription fields can block a new subscription request.
    const activeFlag = subscriptionData.isActive === true ||
        subscriptionData.isSubscribed === true ||
        merchantData.isSubscribed === true;
    const activeStatus = statuses.some((status) => ["active", "approved", "trial", "enabled", "valid", "subscribed"].includes(status));
    if (!activeFlag && !activeStatus)
        return false;
    const expiryMs = Math.max((0, validators_js_1.parseTimestampMs)(subscriptionData.expiresAt), (0, validators_js_1.parseTimestampMs)(subscriptionData.endDate), (0, validators_js_1.parseTimestampMs)(subscriptionData.subscriptionEndDate), (0, validators_js_1.parseTimestampMs)(merchantData.subscriptionExpiresAt), (0, validators_js_1.parseTimestampMs)(merchantData.subscriptionEndDate), (0, validators_js_1.parseTimestampMs)(merchantData.endDate));
    if (expiryMs === 0)
        return true;
    const expiryDate = new Date(expiryMs);
    const isDateOnlyTimestamp = expiryDate.getUTCHours() === 0 &&
        expiryDate.getUTCMinutes() === 0 &&
        expiryDate.getUTCSeconds() === 0 &&
        expiryDate.getUTCMilliseconds() === 0;
    const effectiveExpiryMs = isDateOnlyTimestamp
        ? expiryMs + 24 * 60 * 60 * 1000 - 1
        : expiryMs;
    return nowMs <= effectiveExpiryMs;
}
function legacyPlanIdForCaptainLimit(maxCaptains) {
    var _a;
    return (_a = { 2: 1, 4: 2, 6: 3, 8: 4 }[maxCaptains]) !== null && _a !== void 0 ? _a : 0;
}
function normalizePhoneDigits(raw) {
    return raw.replace(/[^\d+]/g, "").trim();
}
/**
 * Validates that the receipt image path (when stored in Firebase Storage) belongs to the merchant
 * and does not attempt cross-merchant path traversal.
 * @param {string} merchantId Owning merchant UID.
 * @param {string} receiptPath Storage path or verified URL.
 * @param {string} receiptUrl Optional download URL.
 * @return {boolean} True when valid and safely scoped to merchant.
 */
function isSafeMerchantReceipt(merchantId, receiptPath, receiptUrl) {
    const cleanPath = receiptPath.trim();
    const cleanUrl = receiptUrl.trim();
    if (!cleanPath && !cleanUrl)
        return false;
    if (cleanPath) {
        if (cleanPath.includes("..") || cleanPath.startsWith("/")) {
            return false;
        }
        const allowedPrefixes = [
            `subscription_receipts/${merchantId}/`,
            `manual_subscription_receipts/${merchantId}/`,
            `merchants/${merchantId}/subscription_receipts/`,
        ];
        if (!cleanPath.startsWith("https://") &&
            !cleanPath.startsWith("gs://") &&
            !allowedPrefixes.some((p) => cleanPath.startsWith(p))) {
            return false;
        }
        if (cleanPath.startsWith("gs://")) {
            const hasMerchantSegment = allowedPrefixes.some((p) => cleanPath.includes(`/${p}`));
            if (!hasMerchantSegment)
                return false;
        }
    }
    if (cleanUrl && !cleanUrl.startsWith("https://")) {
        // If stored as raw path inside receiptImageUrl, enforce prefix check too
        if (cleanUrl.includes("..") || cleanUrl.startsWith("/")) {
            return false;
        }
        const allowedPrefixes = [
            `subscription_receipts/${merchantId}/`,
            `manual_subscription_receipts/${merchantId}/`,
            `merchants/${merchantId}/subscription_receipts/`,
        ];
        if (!allowedPrefixes.some((p) => cleanUrl.startsWith(p))) {
            return false;
        }
    }
    return true;
}
/**
 * Authoritative server-side service for reviewing, approving, rejecting, and managing
 * manual Vodafone Cash subscription requests and payment settings.
 */
class ManualSubscriptionsServerService {
    /**
     * Constructs the ManualSubscriptionsServerService.
     * @param {DatabaseLike} db Firestore-compatible database adapter.
     * @param {ManualSubscriptionEffectsPort} effects Clock, sentinels, and FCM effects port.
     */
    constructor(db, effects) {
        this.db = db;
        this.effects = effects;
    }
    /**
     * Archives the merchant's previous non-pending subscription period into `subscription_history`
     * before overwriting `subscriptions/{merchantId}` so renewal never erases historical records.
     * @param {Parameters<DatabaseLike["runTransaction"]>[0] extends (tx: infer T) => unknown ? T : never} tx Transaction.
     * @param {string} merchantId Merchant UID.
     * @param {Record<string, unknown>} existingSub Existing subscription document data.
     * @param {string} archiveReason Reason for archiving (renewed, replaced, manual_payment, vodafone_cash_approval).
     * @param {number} nowMs Current epoch milliseconds.
     * @param {string} adminUid Acting admin UID.
     */
    archivePreviousSubscriptionInTx(tx, merchantId, existingSub, archiveReason, nowMs, adminUid) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
        const prevStatus = normalizeStatus((_a = existingSub.status) !== null && _a !== void 0 ? _a : existingSub.subscriptionStatus);
        const hasDates = Boolean((0, validators_js_1.readString)(existingSub, "startDate", "subscriptionStartDate") ||
            (0, validators_js_1.readString)(existingSub, "endDate", "subscriptionEndDate"));
        const nonArchivableStatuses = new Set([
            "",
            "pending_review",
            "pending",
            "under_review",
            "resubmission_required",
            "resubmission_requested",
            "rejected",
            "unsubscribed",
            "migrated",
        ]);
        if (!hasDates || nonArchivableStatuses.has(prevStatus)) {
            return;
        }
        const prevVersion = (_b = (0, validators_js_1.readNumber)(existingSub, "subscriptionVersion")) !== null && _b !== void 0 ? _b : 1;
        const prevEndMs = Math.max((0, validators_js_1.parseTimestampMs)(existingSub.expiresAt), (0, validators_js_1.parseTimestampMs)(existingSub.endDateMs), (0, validators_js_1.parseTimestampMs)(existingSub.endDate));
        const historicalStatus = prevStatus === "active" && prevEndMs > 0 && prevEndMs < nowMs
            ? "expired"
            : prevStatus === "active"
                ? "expired"
                : prevStatus;
        const historyId = `${merchantId}_v${prevVersion}_${nowMs}`;
        const historyRef = this.db.collection("subscription_history").doc(historyId);
        const s = this.effects.sentinels;
        tx.set(historyRef, {
            id: historyId,
            historyId,
            subscriptionNumber: (0, validators_js_1.readString)(existingSub, "subscriptionNumber") ||
                `SUB-${merchantId.slice(0, 6).toUpperCase()}-V${prevVersion}`,
            merchantId,
            restaurantId: merchantId,
            merchantName: (0, validators_js_1.readString)(existingSub, "merchantName", "restaurantName") || "تاجر مسجل",
            restaurantName: (0, validators_js_1.readString)(existingSub, "restaurantName", "merchantName") || "تاجر مسجل",
            merchantPhone: (0, validators_js_1.readString)(existingSub, "merchantPhone"),
            merchantEmail: (0, validators_js_1.readString)(existingSub, "merchantEmail"),
            planId: (_c = existingSub.planId) !== null && _c !== void 0 ? _c : 0,
            planKey: (0, validators_js_1.readString)(existingSub, "planKey", "packageId") ||
                (typeof existingSub.planId === "string" ? existingSub.planId : ""),
            packageId: (0, validators_js_1.readString)(existingSub, "packageId", "planKey") ||
                (typeof existingSub.planId === "string" ? existingSub.planId : ""),
            planName: (0, validators_js_1.readString)(existingSub, "planName", "packageName", "plan") || "باقة اشتراك",
            packageName: (0, validators_js_1.readString)(existingSub, "packageName", "planName", "plan") || "باقة اشتراك",
            maxCaptains: (_d = (0, validators_js_1.readNumber)(existingSub, "maxCaptains", "captainLimit", "captainsCount")) !== null && _d !== void 0 ? _d : 0,
            captainLimit: (_e = (0, validators_js_1.readNumber)(existingSub, "captainLimit", "maxCaptains", "captainsCount")) !== null && _e !== void 0 ? _e : 0,
            captainsCount: (_f = (0, validators_js_1.readNumber)(existingSub, "captainsCount", "maxCaptains", "captainLimit")) !== null && _f !== void 0 ? _f : 0,
            price: (_g = (0, validators_js_1.readNumber)(existingSub, "price", "amount")) !== null && _g !== void 0 ? _g : 0,
            amount: (_h = (0, validators_js_1.readNumber)(existingSub, "amount", "price")) !== null && _h !== void 0 ? _h : 0,
            durationDays: (_j = (0, validators_js_1.readNumber)(existingSub, "durationDays")) !== null && _j !== void 0 ? _j : 30,
            startDate: (0, validators_js_1.readString)(existingSub, "startDate", "subscriptionStartDate"),
            endDate: (0, validators_js_1.readString)(existingSub, "endDate", "subscriptionEndDate"),
            startDateMs: (_k = (0, validators_js_1.readNumber)(existingSub, "startDateMs")) !== null && _k !== void 0 ? _k : null,
            endDateMs: (_m = (_l = (0, validators_js_1.readNumber)(existingSub, "endDateMs")) !== null && _l !== void 0 ? _l : prevEndMs) !== null && _m !== void 0 ? _m : null,
            expiresAt: prevEndMs || null,
            status: historicalStatus,
            subscriptionStatus: historicalStatus,
            previousStatus: prevStatus,
            isActive: false,
            isSubscribed: false,
            isHistorical: true,
            paymentStatus: (0, validators_js_1.readString)(existingSub, "paymentStatus") || "paid",
            paymentMethod: (0, validators_js_1.readString)(existingSub, "paymentMethod") || "admin_manual",
            lastPaymentId: (0, validators_js_1.readString)(existingSub, "lastPaymentId") || null,
            lastRequestId: (0, validators_js_1.readString)(existingSub, "lastRequestId") || null,
            subscriptionVersion: prevVersion,
            archivedReason: archiveReason,
            archivedBy: adminUid,
            archivedAt: s.serverTimestamp(),
            archivedAtMs: nowMs,
            createdAt: (_o = existingSub.createdAt) !== null && _o !== void 0 ? _o : s.serverTimestamp(),
        });
    }
    /**
     * Verifies that the caller is an authenticated, email-verified, active/approved admin
     * using the exact same policy as `requireAdminUid` and `firestore.rules`.
     * @param {CallableAuthContext | undefined} authContext Callable auth context.
     * @return {Promise<{uid: string, email: string, name: string, isMasterAdmin: boolean}>} Admin info.
     */
    async requireAdmin(authContext) {
        var _a;
        const uid = typeof (authContext === null || authContext === void 0 ? void 0 : authContext.uid) === "string" ? authContext.uid.trim() : "";
        const adminSnap = uid ? await this.db.collection("admins").doc(uid).get() : null;
        return (0, validators_js_1.evaluateVerifiedAdminAccess)({
            authContext,
            adminDocExists: Boolean(adminSnap === null || adminSnap === void 0 ? void 0 : adminSnap.exists),
            adminDocData: (adminSnap === null || adminSnap === void 0 ? void 0 : adminSnap.exists) ? ((_a = adminSnap.data()) !== null && _a !== void 0 ? _a : {}) : undefined,
        });
    }
    /**
     * Verifies that the caller is specifically the Master Admin (المسؤول الرئيسي).
     * @param {CallableAuthContext | undefined} authContext Callable auth context.
     * @return {Promise<{uid: string, email: string, name: string}>} Master admin info.
     */
    async requireMasterAdmin(authContext) {
        const admin = await this.requireAdmin(authContext);
        if (!admin.isMasterAdmin) {
            throw new types_js_1.DomainHttpsError("permission-denied", "غير مصرح: تعديل إعدادات الدفع اليدوي وأسعار الباقات متاح للمسؤول الرئيسي فقط.");
        }
        return admin;
    }
    /**
     * 0. Merchant submits a new manual Vodafone Cash subscription request (or resubmits an existing
     * request whose status is `resubmission_required`).
     * - Derives merchant identity strictly from Firebase Auth UID (never trusts client merchantId).
     * - Verifies merchant account ownership in `merchants/{uid}`.
     * - Reads authoritative package, price, durationDays, and wallet from `settings/manual_subscription_config`.
     * - Rejects any client-tampered price or disabled package.
     * - Verifies receipt path ownership AND verifies receipt object exists in Firebase Storage.
     * - Prevents duplicate pending requests and duplicate transaction references.
     * - Always writes status = `pending_review` & paymentStatus = `pending_verification`
     *   (NEVER activates subscription or writes a payment record).
     * @param {CallableAuthContext | undefined} authContext Merchant Firebase Auth context.
     * @param {Record<string, unknown>} data Request payload.
     * @return {Promise<SubmitManualSubscriptionResult>} Created/resubmitted request summary.
     */
    async submitManualSubscriptionRequest(authContext, data) {
        var _a, _b, _c;
        const uid = typeof (authContext === null || authContext === void 0 ? void 0 : authContext.uid) === "string" ? authContext.uid.trim() : "";
        if (!uid || !isValidDocId(uid)) {
            throw new types_js_1.DomainHttpsError("unauthenticated", "يجب تسجيل الدخول بحساب التاجر أولاً لتقديم طلب الاشتراك.");
        }
        if (((_a = authContext === null || authContext === void 0 ? void 0 : authContext.token) === null || _a === void 0 ? void 0 : _a.email_verified) !== true) {
            throw new types_js_1.DomainHttpsError("permission-denied", "يجب تأكيد البريد الإلكتروني لحساب التاجر قبل تقديم طلب الاشتراك.");
        }
        const claimedMerchantId = (0, validators_js_1.readString)(data, "merchantId", "restaurantId");
        if (claimedMerchantId && claimedMerchantId !== uid) {
            throw new types_js_1.DomainHttpsError("permission-denied", "غير مصرح بتقديم طلب اشتراك نيابة عن تاجر آخر.");
        }
        const requestedPlanId = (0, validators_js_1.readString)(data, "planId", "packageId");
        const requestedNumericPlanId = (0, validators_js_1.readNumber)(data, "planId", "packageId");
        const claimedCaptainLimits = [
            (0, validators_js_1.readNumber)(data, "maxCaptains"),
            (0, validators_js_1.readNumber)(data, "captainLimit"),
            (0, validators_js_1.readNumber)(data, "captainsCount"),
        ].filter((value) => value !== null);
        const requestedMaxCaptains = (_b = claimedCaptainLimits[0]) !== null && _b !== void 0 ? _b : 0;
        const claimedAmounts = [
            (0, validators_js_1.readNumber)(data, "amount"),
            (0, validators_js_1.readNumber)(data, "expectedAmount"),
            (0, validators_js_1.readNumber)(data, "price"),
            (0, validators_js_1.readNumber)(data, "requiredAmount"),
        ].filter((value) => value !== null);
        const senderPhone = normalizePhoneDigits((0, validators_js_1.readString)(data, "senderPhone", "fromWalletNumber", "transferPhone"));
        const transactionReference = (0, validators_js_1.readString)(data, "transactionReference", "referenceNumber", "transferReference").slice(0, 120);
        const receiptImagePath = (0, validators_js_1.readString)(data, "receiptImagePath", "receiptStoragePath", "receiptPath");
        const receiptImageUrl = (0, validators_js_1.readString)(data, "receiptImageUrl", "receiptUrl");
        const merchantNote = (0, validators_js_1.readString)(data, "merchantNote", "notes").slice(0, 400);
        const providedIdempotencyKey = (0, validators_js_1.readString)(data, "idempotencyKey").trim();
        if (providedIdempotencyKey.length > 160) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "مفتاح منع التكرار أطول من الحد المسموح.");
        }
        const providedRequestId = (0, validators_js_1.readString)(data, "requestId") ||
            (providedIdempotencyKey
                ? `idem_${(0, node_crypto_1.createHash)("sha256").update(providedIdempotencyKey).digest("hex").slice(0, 48)}`
                : "");
        const idempotencyKey = providedIdempotencyKey || providedRequestId;
        if (providedRequestId && !isValidDocId(providedRequestId)) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "معرّف الطلب غير صالح.");
        }
        if (!senderPhone || senderPhone.length < 8 || senderPhone.length > 20) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "يرجى إدخال رقم المحفظة المحوّل منها بشكل صحيح.");
        }
        if (!receiptImagePath) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "يجب رفع صورة إيصال التحويل إلى Firebase Storage قبل إرسال الطلب.");
        }
        if (!isSafeMerchantReceipt(uid, receiptImagePath, receiptImageUrl)) {
            throw new types_js_1.DomainHttpsError("permission-denied", "مسار صورة الإيصال غير مرتبط بحساب التاجر الصحيح.");
        }
        // Verify receipt file genuinely exists in Firebase Storage
        const receiptExists = await this.effects.verifyStorageReceiptExists(receiptImagePath);
        if (!receiptExists) {
            throw new types_js_1.DomainHttpsError("failed-precondition", "لم يتم العثور على صورة الإيصال في Firebase Storage. يرجى إعادة رفع الإيصال.");
        }
        const nowMs = this.effects.now();
        const s = this.effects.sentinels;
        // Pre-check merchant's existing requests & duplicate transaction references
        const existingMerchantReqsSnap = await this.db
            .collection("manual_subscription_requests")
            .where("merchantId", "==", uid)
            .get();
        let resubmissionTargetDocId = "";
        for (const docSnap of existingMerchantReqsSnap.docs) {
            const d = (_c = docSnap.data()) !== null && _c !== void 0 ? _c : {};
            const st = normalizeStatus(d.status);
            if (providedRequestId && docSnap.id === providedRequestId) {
                if (RESUBMISSION_STATUSES.has(st)) {
                    resubmissionTargetDocId = docSnap.id;
                    continue;
                }
                // A repeated network submission with the same requestId + idempotency key is handled
                // inside the transaction as a safe no-op. Different keys remain rejected.
                if (ACTIVE_PENDING_STATUSES.has(st) &&
                    idempotencyKey &&
                    (0, validators_js_1.readString)(d, "idempotencyKey") === idempotencyKey) {
                    resubmissionTargetDocId = docSnap.id;
                    continue;
                }
                throw new types_js_1.DomainHttpsError("already-exists", "هذا الطلب موجود بالفعل ولا يقبل إعادة الإرسال في حالته الحالية.");
            }
            if (ACTIVE_PENDING_STATUSES.has(st) || RESUBMISSION_STATUSES.has(st)) {
                throw new types_js_1.DomainHttpsError("already-exists", "لديك طلب اشتراك قيد المراجعة أو يحتاج إلى إعادة إرسال بالفعل. يرجى متابعة الطلب الحالي.");
            }
        }
        if (transactionReference) {
            const dupRefSnap = await this.db
                .collection("manual_subscription_requests")
                .where("transactionReference", "==", transactionReference)
                .get();
            for (const dSnap of dupRefSnap.docs) {
                if (resubmissionTargetDocId && dSnap.id === resubmissionTargetDocId) {
                    continue;
                }
                throw new types_js_1.DomainHttpsError("already-exists", "رقم العملية المرجعي مستخدم في طلب اشتراك آخر بالفعل ولا يمكن إعادة استخدامه.");
            }
        }
        const requestId = resubmissionTargetDocId || providedRequestId || `subreq_${uid.slice(0, 8)}_${nowMs}`;
        const requestRef = this.db
            .collection("manual_subscription_requests")
            .doc(requestId);
        const merchantRef = this.db.collection("merchants").doc(uid);
        const subscriptionRef = this.db.collection("subscriptions").doc(uid);
        const settingsRef = this.db
            .collection("settings")
            .doc("manual_subscription_config");
        const opLogRef = this.db
            .collection("operation_logs")
            .doc(`submit_manual_sub_${requestId}_${nowMs}`);
        // Admin-SDK-only reservation documents. Client Firestore rules keep this collection closed.
        const referenceLockRef = transactionReference
            ? this.db.collection("manual_subscription_reference_locks")
                .doc(createTransactionReferenceLockId(transactionReference))
            : null;
        return this.db.runTransaction(async (tx) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w;
            const [merchantSnap, subscriptionSnap, settingsSnap, existingReqSnap, referenceLockSnap] = await Promise.all([
                tx.get(merchantRef),
                tx.get(subscriptionRef),
                tx.get(settingsRef),
                tx.get(requestRef),
                referenceLockRef ? tx.get(referenceLockRef) : Promise.resolve(null),
            ]);
            if (!merchantSnap.exists) {
                throw new types_js_1.DomainHttpsError("not-found", "حساب التاجر غير مسجل في النظام.");
            }
            const merchantData = (_a = merchantSnap.data()) !== null && _a !== void 0 ? _a : {};
            const subscriptionData = subscriptionSnap.exists ? (_b = subscriptionSnap.data()) !== null && _b !== void 0 ? _b : {} : {};
            if (isSubscriptionCurrentlyActive(merchantData, subscriptionData, nowMs)) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "لديك باقة اشتراك نشطة حالياً. لا يمكن إرسال طلب تجديد جديد قبل انتهاء صلاحيتها.");
            }
            const accountType = (0, validators_js_1.readString)(merchantData, "accountType").toLowerCase();
            const role = (0, validators_js_1.readString)(merchantData, "role").toLowerCase();
            if ((accountType && accountType !== "merchant") ||
                (!accountType && role && role !== "merchant")) {
                throw new types_js_1.DomainHttpsError("permission-denied", "هذا الإجراء مخصص لحسابات التجار فقط.");
            }
            const merchantDocUid = (0, validators_js_1.readString)(merchantData, "uid");
            if (merchantDocUid && merchantDocUid !== uid) {
                throw new types_js_1.DomainHttpsError("permission-denied", "عدم تطابق ملكية حساب التاجر.");
            }
            const merchantAccountStatus = (0, validators_js_1.readString)(merchantData, "status").toLowerCase();
            if (merchantData.isBlocked === true ||
                merchantData.isSuspended === true ||
                ["blocked", "banned", "suspended", "disabled"].includes(merchantAccountStatus)) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "حساب التاجر موقوف حالياً ولا يمكن تقديم طلب اشتراك.");
            }
            // Serialize active requests for the same merchant through merchants/{uid}.
            // A conflicting transaction retries and then observes the first request's lock.
            const activeRequestId = (0, validators_js_1.readString)(merchantData, "activeManualSubscriptionRequestId");
            if (activeRequestId && activeRequestId !== requestId) {
                const activeRequestSnap = await tx.get(this.db.collection("manual_subscription_requests").doc(activeRequestId));
                const activeStatus = normalizeStatus((_c = activeRequestSnap.data()) === null || _c === void 0 ? void 0 : _c.status);
                if (activeRequestSnap.exists &&
                    (ACTIVE_PENDING_STATUSES.has(activeStatus) || RESUBMISSION_STATUSES.has(activeStatus))) {
                    throw new types_js_1.DomainHttpsError("already-exists", "لديك طلب اشتراك آخر قيد المراجعة بالفعل. يرجى انتظار قرار الإدارة.");
                }
            }
            // Deterministic transfer-reference reservation prevents the same reference being used
            // by two merchants in concurrent submissions. This lock is never released for replay.
            if (referenceLockSnap === null || referenceLockSnap === void 0 ? void 0 : referenceLockSnap.exists) {
                const referenceLock = (_d = referenceLockSnap.data()) !== null && _d !== void 0 ? _d : {};
                const lockRequestId = (0, validators_js_1.readString)(referenceLock, "requestId");
                const lockMerchantId = (0, validators_js_1.readString)(referenceLock, "merchantId");
                if (lockRequestId !== requestId || lockMerchantId !== uid) {
                    throw new types_js_1.DomainHttpsError("already-exists", "رقم العملية المرجعي مرتبط بطلب اشتراك آخر ولا يمكن استخدامه مرة أخرى.");
                }
            }
            if (!settingsSnap.exists) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "إعدادات اشتراكات فودافون كاش غير مهيأة حالياً من الإدارة.");
            }
            const settingsData = (_e = settingsSnap.data()) !== null && _e !== void 0 ? _e : {};
            if (settingsData.isAcceptingSubscriptions === false) {
                const pauseMsg = (0, validators_js_1.readString)(settingsData, "pauseMessage");
                throw new types_js_1.DomainHttpsError("failed-precondition", pauseMsg || "استقبال طلبات الاشتراك متوقف مؤقتاً من الإدارة.");
            }
            const receiverWalletNumber = (0, validators_js_1.readString)(settingsData, "vodafoneCashNumber");
            if (!receiverWalletNumber) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "رقم محفظة فودافون كاش غير مضبوط في إعدادات النظام.");
            }
            const configuredPlans = Array.isArray(settingsData.plans)
                ? settingsData.plans
                : [];
            const matchedPlan = findAuthoritativePlan(configuredPlans, {
                planId: requestedPlanId,
                numericPlanId: requestedNumericPlanId,
                maxCaptains: requestedMaxCaptains,
            });
            if (!matchedPlan) {
                throw new types_js_1.DomainHttpsError("invalid-argument", "الباقة المختارة غير موجودة ضمن الباقات الرسمية في إعدادات السيرفر.");
            }
            if (matchedPlan.isActive === false) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "هذه الباقة غير متاحة حالياً للاشتراك.");
            }
            const officialPlanId = (0, validators_js_1.readString)(matchedPlan, "planId");
            const officialPlanName = (0, validators_js_1.readString)(matchedPlan, "planName", "label", "name") || officialPlanId;
            const officialMaxCaptains = Math.round((_f = (0, validators_js_1.readNumber)(matchedPlan, "maxCaptains", "captainsCount")) !== null && _f !== void 0 ? _f : 0);
            const officialPrice = (_g = (0, validators_js_1.readNumber)(matchedPlan, "price")) !== null && _g !== void 0 ? _g : 0;
            const rawPlanDuration = (_j = (_h = (0, validators_js_1.readNumber)(matchedPlan, "durationDays")) !== null && _h !== void 0 ? _h : (0, validators_js_1.readNumber)(settingsData, "durationDays")) !== null && _j !== void 0 ? _j : 30;
            const officialDurationDays = rawPlanDuration >= 1 && rawPlanDuration <= 365
                ? Math.round(rawPlanDuration)
                : 30;
            if (officialMaxCaptains < validators_js_1.MIN_PACKAGE_CAPTAINS ||
                officialMaxCaptains > validators_js_1.MAX_PACKAGE_CAPTAINS ||
                officialPrice <= 0) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "إعدادات الباقة الرسمية على السيرفر غير مكتملة.");
            }
            // Validate every client-supplied amount alias independently; one correct alias must not
            // hide a second tampered price field.
            if (claimedAmounts.some((claimedAmount) => Math.abs(claimedAmount - officialPrice) > 0.01)) {
                throw new types_js_1.DomainHttpsError("invalid-argument", "قيمة الاشتراك المرسلة لا تطابق السعر الرسمي للباقة على السيرفر.");
            }
            // Validate every supplied captain-limit alias independently.
            if (claimedCaptainLimits.some((claimedLimit) => Math.round(claimedLimit) !== officialMaxCaptains)) {
                throw new types_js_1.DomainHttpsError("invalid-argument", "عدد الكباتن المرسل لا يطابق الحد الرسمي للباقة على السيرفر.");
            }
            const merchantName = (0, validators_js_1.readString)(merchantData, "name", "merchantName", "restaurantName") ||
                "تاجر مسجل";
            const merchantPhone = (0, validators_js_1.readString)(merchantData, "phone", "phoneNumber");
            const merchantEmail = (0, validators_js_1.readString)(merchantData, "email", "ownerEmail") ||
                (typeof ((_k = authContext === null || authContext === void 0 ? void 0 : authContext.token) === null || _k === void 0 ? void 0 : _k.email) === "string"
                    ? authContext.token.email.trim()
                    : "");
            const nextSubscriptionVersion = Math.max((_l = (0, validators_js_1.readNumber)(subscriptionData, "subscriptionVersion")) !== null && _l !== void 0 ? _l : 0, (_m = (0, validators_js_1.readNumber)(merchantData, "subscriptionVersion")) !== null && _m !== void 0 ? _m : 0) + 1;
            const localPlanId = legacyPlanIdForCaptainLimit(officialMaxCaptains) || officialPlanId;
            const pendingSubscriptionState = {
                merchantId: uid,
                restaurantId: uid,
                status: "pending_review",
                subscriptionStatus: "pending_review",
                isActive: false,
                isSubscribed: false,
                planId: localPlanId,
                planKey: officialPlanId,
                packageId: officialPlanId,
                planName: officialPlanName,
                maxCaptains: officialMaxCaptains,
                captainLimit: officialMaxCaptains,
                captainsCount: officialMaxCaptains,
                price: officialPrice,
                amount: officialPrice,
                durationDays: officialDurationDays,
                paymentStatus: "pending_verification",
                paymentMethod: "vodafone_cash_manual",
                pendingRequestId: requestId,
                senderPhone,
                transactionReference,
                receiptStoragePath: receiptImagePath,
                resubmissionReason: null,
                rejectionReason: null,
                subscriptionVersion: nextSubscriptionVersion,
                subscriptionUpdatedAt: s.serverTimestamp(),
                updatedAt: s.serverTimestamp(),
                updatedBy: uid,
            };
            // Idempotent retry: a repeated request with the same requestId/key returns the existing
            // pending result instead of producing a second write or a misleading error.
            if (existingReqSnap.exists) {
                const existingRequest = (_o = existingReqSnap.data()) !== null && _o !== void 0 ? _o : {};
                const existingMerchantId = (0, validators_js_1.readString)(existingRequest, "merchantId", "restaurantId", "uid");
                const existingStatus = normalizeStatus(existingRequest.status);
                if (existingMerchantId === uid &&
                    idempotencyKey &&
                    (0, validators_js_1.readString)(existingRequest, "idempotencyKey") === idempotencyKey &&
                    ACTIVE_PENDING_STATUSES.has(existingStatus)) {
                    return {
                        success: true,
                        requestId,
                        requestNumber: (0, validators_js_1.readString)(existingRequest, "requestNumber") || `SUB-${requestId.slice(0, 8).toUpperCase()}`,
                        merchantId: uid,
                        planId: (0, validators_js_1.readString)(existingRequest, "planId") || officialPlanId,
                        planName: (0, validators_js_1.readString)(existingRequest, "planName") || officialPlanName,
                        maxCaptains: (_p = (0, validators_js_1.readNumber)(existingRequest, "maxCaptains")) !== null && _p !== void 0 ? _p : officialMaxCaptains,
                        amount: (_q = (0, validators_js_1.readNumber)(existingRequest, "amount")) !== null && _q !== void 0 ? _q : officialPrice,
                        durationDays: (_r = (0, validators_js_1.readNumber)(existingRequest, "durationDays")) !== null && _r !== void 0 ? _r : officialDurationDays,
                        receiverWalletNumber: (0, validators_js_1.readString)(existingRequest, "receiverWalletNumber") || receiverWalletNumber,
                        status: "pending_review",
                        paymentStatus: "pending_verification",
                        isResubmission: false,
                        message: "تم تسجيل الطلب مسبقاً؛ لا حاجة لإرساله مرة أخرى.",
                    };
                }
            }
            // Handle resubmission of an existing resubmission_required request
            if (existingReqSnap.exists) {
                const prev = (_s = existingReqSnap.data()) !== null && _s !== void 0 ? _s : {};
                const prevMerchantId = (0, validators_js_1.readString)(prev, "merchantId", "restaurantId", "uid");
                const prevStatus = normalizeStatus(prev.status);
                if (prevMerchantId !== uid || !RESUBMISSION_STATUSES.has(prevStatus)) {
                    throw new types_js_1.DomainHttpsError("already-exists", "الطلب موجود بالفعل ولا يمكن استبداله.");
                }
                const prevReceiptPath = (0, validators_js_1.readString)(prev, "receiptImagePath", "receiptPath");
                const prevReceiptUrl = (0, validators_js_1.readString)(prev, "receiptImageUrl", "receiptUrl");
                const existingArchivedReceipts = Array.isArray(prev.previousReceipts)
                    ? prev.previousReceipts
                    : [];
                const alreadyArchived = existingArchivedReceipts.some((entry) => {
                    const archivedPath = (0, validators_js_1.readString)(entry, "receiptImagePath", "receiptPath");
                    const archivedUrl = (0, validators_js_1.readString)(entry, "receiptImageUrl", "receiptUrl");
                    return ((Boolean(prevReceiptPath) && archivedPath === prevReceiptPath) ||
                        (Boolean(prevReceiptUrl) && archivedUrl === prevReceiptUrl));
                });
                const reviewEntry = {
                    action: "resubmitted",
                    reviewerId: uid,
                    reviewerEmail: merchantEmail,
                    reviewerName: merchantName,
                    note: merchantNote || "قام التاجر بإعادة رفع صورة إيصال جديدة للمراجعة",
                    timestampMs: nowMs,
                    timestampIso: new Date(nowMs).toISOString(),
                };
                const reqNum = (0, validators_js_1.readString)(prev, "requestNumber") ||
                    `SUB-${requestId.slice(0, 8).toUpperCase()}`;
                const resubmissionUpdate = {
                    senderPhone,
                    transactionReference,
                    receiptImagePath,
                    receiptImageUrl,
                    merchantNote,
                    idempotencyKey,
                    status: "pending_review",
                    paymentStatus: "pending_verification",
                    resubmittedAt: s.serverTimestamp(),
                    resubmittedAtMs: nowMs,
                    reviewHistory: s.arrayUnion(reviewEntry),
                    updatedAt: s.serverTimestamp(),
                };
                if ((prevReceiptPath || prevReceiptUrl) && !alreadyArchived) {
                    resubmissionUpdate.previousReceipts = s.arrayUnion({
                        receiptImagePath: prevReceiptPath,
                        receiptImageUrl: prevReceiptUrl,
                        senderPhone: (0, validators_js_1.readString)(prev, "senderPhone"),
                        transactionReference: (0, validators_js_1.readString)(prev, "transactionReference"),
                        replacedAtMs: nowMs,
                        replacedAtIso: new Date(nowMs).toISOString(),
                    });
                }
                tx.update(requestRef, resubmissionUpdate);
                tx.set(subscriptionRef, pendingSubscriptionState, { merge: true });
                tx.set(merchantRef, Object.assign(Object.assign({}, pendingSubscriptionState), { activeManualSubscriptionRequestId: requestId, manualSubscriptionRequestUpdatedAt: s.serverTimestamp() }), { merge: true });
                if (referenceLockRef) {
                    tx.set(referenceLockRef, {
                        requestId,
                        merchantId: uid,
                        transactionReference,
                        createdAt: s.serverTimestamp(),
                        updatedAt: s.serverTimestamp(),
                    }, { merge: true });
                }
                tx.set(opLogRef, {
                    action: "resubmit_manual_subscription_request",
                    entityType: "manual_subscription_request",
                    requestId,
                    merchantId: uid,
                    planId: (0, validators_js_1.readString)(prev, "planId") || officialPlanId,
                    amount: (_t = (0, validators_js_1.readNumber)(prev, "amount")) !== null && _t !== void 0 ? _t : officialPrice,
                    receiptImagePath,
                    createdAt: s.serverTimestamp(),
                });
                return {
                    success: true,
                    requestId,
                    requestNumber: reqNum,
                    merchantId: uid,
                    planId: (0, validators_js_1.readString)(prev, "planId") || officialPlanId,
                    planName: (0, validators_js_1.readString)(prev, "planName") || officialPlanName,
                    maxCaptains: (_u = (0, validators_js_1.readNumber)(prev, "maxCaptains")) !== null && _u !== void 0 ? _u : officialMaxCaptains,
                    amount: (_v = (0, validators_js_1.readNumber)(prev, "amount")) !== null && _v !== void 0 ? _v : officialPrice,
                    durationDays: (_w = (0, validators_js_1.readNumber)(prev, "durationDays")) !== null && _w !== void 0 ? _w : officialDurationDays,
                    receiverWalletNumber: (0, validators_js_1.readString)(prev, "receiverWalletNumber") || receiverWalletNumber,
                    status: "pending_review",
                    paymentStatus: "pending_verification",
                    isResubmission: true,
                    message: "تم إعادة إرسال الإيصال بنجاح وجارٍ مراجعته من الإدارة.",
                };
            }
            const requestNumber = `SUB-${String(nowMs).slice(-6)}`;
            const submitHistoryEntry = {
                action: "submitted",
                reviewerId: uid,
                reviewerEmail: merchantEmail,
                reviewerName: merchantName,
                note: merchantNote || "تم إرسال طلب اشتراك فودافون كاش مع إيصال التحويل",
                timestampMs: nowMs,
                timestampIso: new Date(nowMs).toISOString(),
            };
            tx.set(requestRef, {
                requestNumber,
                merchantId: uid,
                restaurantId: uid,
                merchantName,
                merchantPhone,
                merchantEmail,
                planId: officialPlanId,
                packageId: officialPlanId,
                planName: officialPlanName,
                packageName: officialPlanName,
                maxCaptains: officialMaxCaptains,
                captainLimit: officialMaxCaptains,
                amount: officialPrice,
                priceSnapshot: officialPrice,
                priceVerifiedByServer: true,
                durationDays: officialDurationDays,
                senderPhone,
                receiverWalletNumber,
                transactionReference,
                receiptImagePath,
                receiptImageUrl,
                merchantNote,
                idempotencyKey,
                status: "pending_review",
                requestStatus: "pending_review",
                paymentStatus: "pending_verification",
                previousReceipts: [],
                reviewHistory: [submitHistoryEntry],
                submittedAt: s.serverTimestamp(),
                createdAt: s.serverTimestamp(),
                updatedAt: s.serverTimestamp(),
            });
            tx.set(subscriptionRef, pendingSubscriptionState, { merge: true });
            tx.set(merchantRef, Object.assign(Object.assign({}, pendingSubscriptionState), { activeManualSubscriptionRequestId: requestId, manualSubscriptionRequestUpdatedAt: s.serverTimestamp() }), { merge: true });
            if (referenceLockRef) {
                tx.set(referenceLockRef, {
                    requestId,
                    merchantId: uid,
                    transactionReference,
                    createdAt: s.serverTimestamp(),
                    updatedAt: s.serverTimestamp(),
                }, { merge: true });
            }
            tx.set(opLogRef, {
                action: "submit_manual_subscription_request",
                entityType: "manual_subscription_request",
                requestId,
                requestNumber,
                merchantId: uid,
                merchantName,
                planId: officialPlanId,
                planName: officialPlanName,
                maxCaptains: officialMaxCaptains,
                amount: officialPrice,
                durationDays: officialDurationDays,
                receiptImagePath,
                createdAt: s.serverTimestamp(),
            });
            return {
                success: true,
                requestId,
                requestNumber,
                merchantId: uid,
                planId: officialPlanId,
                planName: officialPlanName,
                maxCaptains: officialMaxCaptains,
                amount: officialPrice,
                durationDays: officialDurationDays,
                receiverWalletNumber,
                status: "pending_review",
                paymentStatus: "pending_verification",
                isResubmission: false,
                message: "تم إرسال طلب الاشتراك بنجاح وهو الآن قيد مراجعة الإدارة.",
            };
        });
    }
    /**
     * 1. Approves a manual Vodafone Cash subscription request atomically inside a Firestore Transaction.
     * - Updates manual_subscription_requests/{requestId} -> approved + paymentStatus: paid
     * - Updates subscriptions/{merchantId} -> active, dates, planId, planName, maxCaptains, isSubscribed: true
     * - Updates merchants/{merchantId} -> synced canonical fields compatible with Merchant App
     * - Creates exactly ONE deterministic payment document: payments/manual_sub_{requestId}
     * - Records immutable audit log in operation_logs
     * - Sends merchant Firestore notification + FCM push
     * @param {CallableAuthContext | undefined} authContext Caller auth context.
     * @param {Record<string, unknown>} data Callable payload containing requestId and optional adminNote.
     * @return {Promise<ApproveManualSubscriptionResult>} Approval summary.
     */
    async approveManualSubscriptionRequest(authContext, data) {
        const admin = await this.requireAdmin(authContext);
        const requestId = (0, validators_js_1.readString)(data, "requestId");
        const adminNote = typeof (data === null || data === void 0 ? void 0 : data.adminNote) === "string" ? data.adminNote.trim().slice(0, 500) : "";
        if (!requestId || !isValidDocId(requestId)) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "معرّف طلب الاشتراك غير صالح.");
        }
        const nowMs = this.effects.now();
        const s = this.effects.sentinels;
        const requestRef = this.db
            .collection("manual_subscription_requests")
            .doc(requestId);
        const settingsRef = this.db
            .collection("settings")
            .doc("manual_subscription_config");
        const paymentDocId = `manual_sub_${requestId}`;
        const paymentRef = this.db.collection("payments").doc(paymentDocId);
        const opLogRef = this.db
            .collection("operation_logs")
            .doc(`approve_manual_sub_${requestId}`);
        let merchantFcmToken = "";
        let notifyMerchantName = "";
        const result = await this.db.runTransaction(async (tx) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
            const [reqSnap, settingsSnap, existingPaymentSnap] = await Promise.all([
                tx.get(requestRef),
                tx.get(settingsRef),
                tx.get(paymentRef),
            ]);
            if (!reqSnap.exists) {
                throw new types_js_1.DomainHttpsError("not-found", "طلب الاشتراك غير موجود أو تم حذفه.");
            }
            const reqData = (_a = reqSnap.data()) !== null && _a !== void 0 ? _a : {};
            const currentStatus = normalizeStatus(reqData.status) || "pending";
            if (currentStatus === "approved") {
                throw new types_js_1.DomainHttpsError("already-exists", "تمت الموافقة على هذا الطلب وتفعيل الاشتراك مسبقاً.");
            }
            if (currentStatus === "rejected") {
                throw new types_js_1.DomainHttpsError("failed-precondition", "لا يمكن الموافقة على طلب تم رفضه مسبقاً.");
            }
            if (!REVIEWABLE_STATUSES.has(currentStatus)) {
                throw new types_js_1.DomainHttpsError("failed-precondition", `حالة الطلب الحالية (${currentStatus}) لا تسمح بالموافقة.`);
            }
            if (existingPaymentSnap.exists) {
                throw new types_js_1.DomainHttpsError("already-exists", "تم إنشاء سجل مالي لهذا الطلب مسبقاً ولا يمكن تكرار العملية المالية.");
            }
            const merchantId = (0, validators_js_1.readString)(reqData, "merchantId", "restaurantId", "uid");
            if (!merchantId || !isValidDocId(merchantId)) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "بيانات طلب الاشتراك تفتقر إلى معرّف تاجر صالح.");
            }
            const merchantRef = this.db.collection("merchants").doc(merchantId);
            const subscriptionRef = this.db.collection("subscriptions").doc(merchantId);
            const [merchantSnap, subSnap] = await Promise.all([
                tx.get(merchantRef),
                tx.get(subscriptionRef),
            ]);
            if (!merchantSnap.exists) {
                throw new types_js_1.DomainHttpsError("not-found", "حساب التاجر المرتبط بهذا الطلب غير موجود في النظام.");
            }
            const merchantData = (_b = merchantSnap.data()) !== null && _b !== void 0 ? _b : {};
            const accountType = (0, validators_js_1.readString)(merchantData, "accountType").toLowerCase();
            const role = (0, validators_js_1.readString)(merchantData, "role").toLowerCase();
            if ((accountType && accountType !== "merchant") ||
                (!accountType && role && role !== "merchant")) {
                throw new types_js_1.DomainHttpsError("permission-denied", "الحساب المرتبط بالطلب ليس حساب تاجر معتمداً.");
            }
            const merchantDocUid = (0, validators_js_1.readString)(merchantData, "uid");
            if (merchantDocUid && merchantDocUid !== merchantId) {
                throw new types_js_1.DomainHttpsError("permission-denied", "عدم تطابق ملكية طلب الاشتراك مع هوية التاجر.");
            }
            const merchantAccountStatus = (0, validators_js_1.readString)(merchantData, "status").toLowerCase();
            if (merchantData.isBlocked === true ||
                merchantData.isSuspended === true ||
                ["blocked", "banned", "suspended", "disabled"].includes(merchantAccountStatus)) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "حساب التاجر موقوف حالياً ولا يمكن تفعيل اشتراكه.");
            }
            const receiptPath = (0, validators_js_1.readString)(reqData, "receiptImagePath", "receiptPath");
            const receiptUrl = (0, validators_js_1.readString)(reqData, "receiptImageUrl", "receiptUrl");
            if (!isSafeMerchantReceipt(merchantId, receiptPath, receiptUrl)) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "صورة إيصال التحويل مفقودة أو مسارها غير مطابق لملكية التاجر.");
            }
            if (receiptPath && !receiptPath.startsWith("https://")) {
                const existsInStorage = await this.effects.verifyStorageReceiptExists(receiptPath);
                if (!existsInStorage) {
                    throw new types_js_1.DomainHttpsError("failed-precondition", "ملف إيصال التحويل غير موجود في Firebase Storage ولا يمكن اعتماد الطلب.");
                }
            }
            if (!settingsSnap.exists) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "إعدادات الباقات الرسمية غير موجودة في قاعدة البيانات ولا يمكن اعتماد الطلب.");
            }
            const settingsData = (_c = settingsSnap.data()) !== null && _c !== void 0 ? _c : {};
            // Resolve official plan from server settings with strict planId-first priority
            const configuredPlans = Array.isArray(settingsData.plans)
                ? settingsData.plans
                : [];
            if (configuredPlans.length === 0) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "لا توجد باقات رسمية مهيأة في إعدادات النظام ولا يمكن اعتماد الطلب.");
            }
            const reqPlanId = (0, validators_js_1.readString)(reqData, "planId", "packageId");
            const reqNumericPlanId = (0, validators_js_1.readNumber)(reqData, "planId", "packageId");
            const reqMaxCaptains = (_d = (0, validators_js_1.readNumber)(reqData, "maxCaptains", "captainLimit", "captainsCount")) !== null && _d !== void 0 ? _d : 0;
            const matchedPlan = findAuthoritativePlan(configuredPlans, {
                planId: reqPlanId,
                numericPlanId: reqNumericPlanId,
                maxCaptains: reqMaxCaptains,
            });
            if (!matchedPlan) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "الباقة المطلوبة في الطلب لا تطابق أي باقة رسمية معتمدة في إعدادات النظام.");
            }
            if (matchedPlan.isActive === false) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "الباقة المطلوبة في الطلب معطّلة حالياً ولا يمكن اعتماد اشتراك جديد عليها.");
            }
            const rawDurationDays = (_g = (_f = (_e = (0, validators_js_1.readNumber)(reqData, "durationDays")) !== null && _e !== void 0 ? _e : (0, validators_js_1.readNumber)(matchedPlan, "durationDays")) !== null && _f !== void 0 ? _f : (0, validators_js_1.readNumber)(settingsData, "durationDays")) !== null && _g !== void 0 ? _g : 30;
            const durationDays = rawDurationDays >= 1 && rawDurationDays <= 365
                ? Math.round(rawDurationDays)
                : 30;
            const maxCaptains = Math.round((_h = (0, validators_js_1.readNumber)(matchedPlan, "maxCaptains", "captainsCount")) !== null && _h !== void 0 ? _h : 0);
            if (maxCaptains < validators_js_1.MIN_PACKAGE_CAPTAINS || maxCaptains > validators_js_1.MAX_PACKAGE_CAPTAINS) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "حد الكباتن في الباقة الرسمية غير صالح (يجب أن يكون بين 1 و 100).");
            }
            const planId = (0, validators_js_1.readString)(matchedPlan, "planId") ||
                reqPlanId ||
                `plan_${maxCaptains}_captains`;
            const planName = (0, validators_js_1.readString)(reqData, "planName", "packageName", "plan") ||
                (0, validators_js_1.readString)(matchedPlan, "planName", "label", "name") ||
                `باقة ${maxCaptains} كابتن`;
            const officialPlanPrice = (0, validators_js_1.readNumber)(matchedPlan, "price");
            if (officialPlanPrice === null || officialPlanPrice <= 0) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "السعر الرسمي للباقة غير مضبوط بشكل صالح.");
            }
            const reqAmount = (0, validators_js_1.readNumber)(reqData, "priceSnapshot", "amount", "price", "requiredAmount");
            const isServerVerifiedSnapshot = reqData.priceVerifiedByServer === true;
            if (!isServerVerifiedSnapshot &&
                reqAmount !== null &&
                Math.abs(reqAmount - officialPlanPrice) > 0.01) {
                throw new types_js_1.DomainHttpsError("failed-precondition", `المبلغ المسجل في الطلب (${reqAmount}) لا يطابق السعر الرسمي للباقة (${officialPlanPrice}).`);
            }
            // Preserve the immutable price snapshot for server-verified requests even if package pricing later changed.
            const amount = isServerVerifiedSnapshot
                ? (reqAmount !== null && reqAmount !== void 0 ? reqAmount : officialPlanPrice)
                : officialPlanPrice;
            if (amount <= 0) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "قيمة المبلغ المطلوب غير صالحة لإتمام تفعيل الاشتراك.");
            }
            const window = (0, validators_js_1.computeUnifiedSubscriptionWindow)(nowMs, durationDays);
            const startDateMs = window.startDateMs;
            const endDateMs = window.endDateMs;
            const startDateYmd = window.startDate;
            const endDateYmd = window.endDate;
            const subData = subSnap.exists ? (_j = subSnap.data()) !== null && _j !== void 0 ? _j : {} : {};
            const prevVersion = Math.max((_k = (0, validators_js_1.readNumber)(subData, "subscriptionVersion")) !== null && _k !== void 0 ? _k : 0, (_l = (0, validators_js_1.readNumber)(merchantData, "subscriptionVersion")) !== null && _l !== void 0 ? _l : 0);
            const nextVersion = prevVersion + 1;
            const subscriptionNumber = `SUB-${merchantId.slice(0, 6).toUpperCase()}-V${nextVersion}`;
            const numericOrKeyPlanId = legacyPlanIdForCaptainLimit(maxCaptains) || planId;
            // Preserve any prior active/expired/suspended subscription period before activating the new one
            if (subSnap.exists) {
                this.archivePreviousSubscriptionInTx(tx, merchantId, subData, "vodafone_cash_approval", nowMs, admin.uid);
            }
            const merchantName = (0, validators_js_1.readString)(merchantData, "name", "merchantName", "restaurantName") ||
                (0, validators_js_1.readString)(reqData, "merchantName", "restaurantName") ||
                "تاجر مسجل";
            const merchantPhone = (0, validators_js_1.readString)(merchantData, "phone", "phoneNumber") ||
                (0, validators_js_1.readString)(reqData, "merchantPhone");
            const merchantEmail = (0, validators_js_1.readString)(merchantData, "email", "ownerEmail") ||
                (0, validators_js_1.readString)(reqData, "merchantEmail");
            const senderPhone = (0, validators_js_1.readString)(reqData, "senderPhone", "fromWalletNumber", "transferPhone");
            const receiverWalletNumber = (0, validators_js_1.readString)(reqData, "receiverWalletNumber", "toWalletNumber") ||
                (0, validators_js_1.readString)(settingsData, "vodafoneCashNumber");
            const transactionReference = (0, validators_js_1.readString)(reqData, "transactionReference", "referenceNumber", "transferReference");
            merchantFcmToken = (0, validators_js_1.readString)(merchantData, "fcmToken");
            notifyMerchantName = merchantName;
            const reviewEntry = {
                action: "approved",
                reviewerId: admin.uid,
                reviewerEmail: admin.email,
                reviewerName: admin.name,
                note: adminNote || "تمت مراجعة إيصال فودافون كاش والموافقة على تفعيل الاشتراك",
                timestampMs: nowMs,
                timestampIso: new Date(nowMs).toISOString(),
            };
            // 1. Update manual_subscription_requests/{requestId}
            tx.update(requestRef, {
                status: "approved",
                requestStatus: "approved",
                paymentStatus: "paid",
                planId,
                packageId: planId,
                planName,
                packageName: planName,
                maxCaptains,
                captainLimit: maxCaptains,
                amount,
                durationDays,
                receiverWalletNumber,
                approvedBy: admin.uid,
                approvedByEmail: admin.email,
                approvedByName: admin.name,
                approvedAt: s.serverTimestamp(),
                approvedAtMs: nowMs,
                paymentDocId,
                subscriptionId: merchantId,
                subscriptionStartDate: startDateYmd,
                subscriptionEndDate: endDateYmd,
                subscriptionExpiresAt: endDateMs,
                adminNote,
                reviewHistory: s.arrayUnion(reviewEntry),
                updatedAt: s.serverTimestamp(),
            });
            // 2. Update subscriptions/{merchantId}
            tx.set(subscriptionRef, {
                subscriptionId: merchantId,
                subscriptionNumber,
                merchantId,
                restaurantId: merchantId,
                merchantName,
                restaurantName: merchantName,
                merchantPhone,
                merchantEmail,
                status: "active",
                subscriptionStatus: "active",
                isActive: true,
                isSubscribed: true,
                planId: numericOrKeyPlanId,
                planKey: planId,
                packageId: planId,
                planName,
                packageName: planName,
                plan: planName,
                maxCaptains,
                captainLimit: maxCaptains,
                captainsCount: maxCaptains,
                price: amount,
                amount,
                paymentStatus: "paid",
                paymentMethod: "vodafone_cash",
                lastPaymentId: paymentDocId,
                lastRequestId: requestId,
                pendingRequestId: null,
                startDate: startDateYmd,
                subscriptionStartDate: startDateYmd,
                endDate: endDateYmd,
                subscriptionEndDate: endDateYmd,
                startDateMs,
                endDateMs,
                expiresAt: endDateMs,
                subscriptionExpiresAt: endDateMs,
                activatedAt: s.serverTimestamp(),
                durationDays,
                suspensionReason: null,
                cancellationReason: null,
                approvedBy: admin.uid,
                approvedByEmail: admin.email,
                approvedAt: s.serverTimestamp(),
                updatedBy: admin.uid,
                updatedByAdminUid: admin.uid,
                subscriptionVersion: nextVersion,
                subscriptionUpdatedAt: s.serverTimestamp(),
                updatedAt: s.serverTimestamp(),
            }, { merge: true });
            // 3. Sync merchants/{merchantId} (fully compatible with Merchant App SubscriptionSyncResolver)
            tx.set(merchantRef, Object.assign(Object.assign({ subscriptionStatus: "active", isSubscribed: true, isActive: true, planId: numericOrKeyPlanId, planKey: planId, packageId: planId, planName, packageName: planName, subscriptionPlan: planName, maxCaptains, captainLimit: maxCaptains, captainsCount: maxCaptains, price: amount, paymentStatus: "paid", paymentMethod: "vodafone_cash", subscriptionStartDate: startDateYmd, subscriptionEndDate: endDateYmd, subscriptionExpiresAt: endDateMs, startDate: startDateYmd, endDate: endDateYmd, expiresAt: endDateMs, activatedAt: s.serverTimestamp(), suspensionReason: null, cancellationReason: null, lastApprovedRequestId: requestId, pendingRequestId: null, lastPaymentId: paymentDocId }, ((0, validators_js_1.readString)(merchantData, "activeManualSubscriptionRequestId") === requestId
                ? {
                    activeManualSubscriptionRequestId: null,
                    manualSubscriptionRequestUpdatedAt: s.serverTimestamp(),
                }
                : {})), { updatedBy: admin.uid, updatedByAdminUid: admin.uid, subscriptionVersion: nextVersion, subscriptionUpdatedAt: s.serverTimestamp(), updatedAt: s.serverTimestamp() }), { merge: true });
            // 4. Create single deterministic financial payment transaction
            tx.set(paymentRef, {
                id: paymentDocId,
                requestId,
                subscriptionId: merchantId,
                subscriptionNumber,
                type: "merchant_subscription",
                source: "manual_vodafone_cash",
                transactionId: transactionReference || paymentDocId,
                transactionNumber: transactionReference || paymentDocId,
                transactionReference,
                merchantId,
                restaurantId: merchantId,
                merchantName,
                restaurantName: merchantName,
                merchantPhone,
                planId,
                packageId: planId,
                planName,
                packageName: planName,
                maxCaptains,
                captainLimit: maxCaptains,
                amount,
                currency: "EGP",
                paymentMethod: "فودافون كاش (Vodafone Cash)",
                method: "vodafone_cash",
                senderPhone,
                receiverWalletNumber,
                receiptImagePath: receiptPath,
                receiptImageUrl: receiptUrl,
                status: "success",
                paymentStatus: "paid",
                approvedBy: admin.uid,
                approvedByEmail: admin.email,
                approvedAt: s.serverTimestamp(),
                approvedAtMs: nowMs,
                paidAt: s.serverTimestamp(),
                paidAtMs: nowMs,
                date: startDateYmd,
                billingMonth: startDateYmd.slice(0, 7),
                notes: `تفعيل اشتراك (${planName}) عبر فودافون كاش — طلب #${requestId}`,
                createdAt: s.serverTimestamp(),
                createdAtMs: nowMs,
                updatedAt: s.serverTimestamp(),
            });
            // 5. Write audit trail to operation_logs
            tx.set(opLogRef, {
                action: "approve_manual_subscription_request",
                entityType: "manual_subscription_request",
                requestId,
                merchantId,
                merchantName,
                paymentDocId,
                planId,
                planName,
                maxCaptains,
                amount,
                durationDays,
                startDate: startDateYmd,
                endDate: endDateYmd,
                subscriptionVersion: nextVersion,
                adminUid: admin.uid,
                adminEmail: admin.email,
                adminName: admin.name,
                note: adminNote,
                createdAt: s.serverTimestamp(),
            });
            return {
                success: true,
                requestId,
                merchantId,
                paymentDocId,
                status: "approved",
                paymentStatus: "paid",
                planId,
                planName,
                maxCaptains,
                amount,
                startDate: startDateYmd,
                endDate: endDateYmd,
                expiresAtMs: endDateMs,
                subscriptionVersion: nextVersion,
                approvedBy: admin.uid,
                message: `تمت الموافقة وتفعيل باقة "${planName}" للتاجر "${merchantName}" بنجاح.`,
            };
        });
        // Post-commit deterministic merchant notification & FCM push
        const notifTitle = "تم تفعيل اشتراكك بنجاح";
        const notifBody = `تمت مراجعة تحويل فودافون كاش وتفعيل باقة "${result.planName}" (${result.maxCaptains} كابتن) حتى ${result.endDate}.`;
        await this.db
            .collection("merchants")
            .doc(result.merchantId)
            .collection("notifications")
            .doc(`sub_approved_${requestId}`)
            .set({
            type: "subscription_approved",
            title: notifTitle,
            body: notifBody,
            requestId,
            merchantId: result.merchantId,
            merchantName: notifyMerchantName,
            planId: result.planId,
            planName: result.planName,
            maxCaptains: result.maxCaptains,
            endDate: result.endDate,
            isRead: false,
            createdAt: s.serverTimestamp(),
        }, { merge: true });
        await this.effects.sendMerchantSubscriptionNotification({
            merchantId: result.merchantId,
            fcmToken: merchantFcmToken,
            requestId,
            eventType: "subscription_approved",
            title: notifTitle,
            body: notifBody,
            planId: result.planId,
            planName: result.planName,
            maxCaptains: result.maxCaptains,
            dedupeKey: `sub_approved_${requestId}_v${result.subscriptionVersion}`,
        });
        return result;
    }
    /**
     * 2. Rejects a manual Vodafone Cash subscription request without activating the subscription.
     * @param {CallableAuthContext | undefined} authContext Caller auth context.
     * @param {Record<string, unknown>} data Payload containing requestId and rejectionReason.
     * @return {Promise<RejectManualSubscriptionResult>} Rejection result.
     */
    async rejectManualSubscriptionRequest(authContext, data) {
        const admin = await this.requireAdmin(authContext);
        const requestId = (0, validators_js_1.readString)(data, "requestId");
        const rejectionReason = (0, validators_js_1.readString)(data, "rejectionReason", "reason");
        if (!requestId || !isValidDocId(requestId)) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "معرّف طلب الاشتراك غير صالح.");
        }
        if (!rejectionReason || rejectionReason.length < 3) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "يجب كتابة سبب واضح لرفض طلب الاشتراك (3 أحرف على الأقل).");
        }
        const cleanReason = rejectionReason.slice(0, 500);
        const nowMs = this.effects.now();
        const s = this.effects.sentinels;
        const requestRef = this.db
            .collection("manual_subscription_requests")
            .doc(requestId);
        const opLogRef = this.db
            .collection("operation_logs")
            .doc(`reject_manual_sub_${requestId}`);
        let merchantFcmToken = "";
        let planName = "";
        const result = await this.db.runTransaction(async (tx) => {
            var _a, _b, _c, _d, _e, _f, _g;
            const reqSnap = await tx.get(requestRef);
            if (!reqSnap.exists) {
                throw new types_js_1.DomainHttpsError("not-found", "طلب الاشتراك غير موجود أو تم حذفه.");
            }
            const reqData = (_a = reqSnap.data()) !== null && _a !== void 0 ? _a : {};
            const currentStatus = normalizeStatus(reqData.status) || "pending";
            if (currentStatus === "approved") {
                throw new types_js_1.DomainHttpsError("failed-precondition", "لا يمكن رفض طلب تمت الموافقة عليه وتفعيل اشتراكه بالفعل.");
            }
            if (currentStatus === "rejected") {
                throw new types_js_1.DomainHttpsError("already-exists", "تم رفض هذا الطلب مسبقاً.");
            }
            const merchantId = (0, validators_js_1.readString)(reqData, "merchantId", "restaurantId", "uid");
            if (!merchantId || !isValidDocId(merchantId)) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "طلب الاشتراك لا يحتوي على معرّف تاجر صالح.");
            }
            const merchantRef = this.db.collection("merchants").doc(merchantId);
            const subscriptionRef = this.db.collection("subscriptions").doc(merchantId);
            const [merchantSnap, subscriptionSnap] = await Promise.all([
                tx.get(merchantRef),
                tx.get(subscriptionRef),
            ]);
            const merchantData = merchantSnap.exists ? (_b = merchantSnap.data()) !== null && _b !== void 0 ? _b : {} : {};
            const subscriptionData = subscriptionSnap.exists ? (_c = subscriptionSnap.data()) !== null && _c !== void 0 ? _c : {} : {};
            merchantFcmToken = (0, validators_js_1.readString)(merchantData, "fcmToken");
            planName = (0, validators_js_1.readString)(reqData, "planName", "plan") || "باقة الاشتراك";
            const reviewEntry = {
                action: "rejected",
                reviewerId: admin.uid,
                reviewerEmail: admin.email,
                reviewerName: admin.name,
                reason: cleanReason,
                note: cleanReason,
                timestampMs: nowMs,
                timestampIso: new Date(nowMs).toISOString(),
            };
            tx.update(requestRef, {
                status: "rejected",
                paymentStatus: "rejected",
                rejectionReason: cleanReason,
                rejectedBy: admin.uid,
                rejectedByEmail: admin.email,
                rejectedByName: admin.name,
                rejectedAt: s.serverTimestamp(),
                rejectedAtMs: nowMs,
                reviewHistory: s.arrayUnion(reviewEntry),
                updatedAt: s.serverTimestamp(),
            });
            const rejectedReqPlanKey = (0, validators_js_1.readString)(reqData, "planId", "packageId");
            const rejectedMaxCaps = (_d = (0, validators_js_1.readNumber)(reqData, "maxCaptains")) !== null && _d !== void 0 ? _d : 0;
            const rejectedState = {
                status: "rejected",
                subscriptionStatus: "rejected",
                isActive: false,
                isSubscribed: false,
                paymentStatus: "rejected",
                paymentMethod: "vodafone_cash_manual",
                pendingRequestId: null,
                rejectionReason: cleanReason,
                planId: legacyPlanIdForCaptainLimit(rejectedMaxCaps) || rejectedReqPlanKey,
                planKey: rejectedReqPlanKey,
                packageId: rejectedReqPlanKey,
                planName,
                maxCaptains: rejectedMaxCaps,
                captainLimit: rejectedMaxCaps,
                price: (_e = (0, validators_js_1.readNumber)(reqData, "amount")) !== null && _e !== void 0 ? _e : 0,
                subscriptionVersion: Math.max((_f = (0, validators_js_1.readNumber)(subscriptionData, "subscriptionVersion")) !== null && _f !== void 0 ? _f : 0, (_g = (0, validators_js_1.readNumber)(merchantData, "subscriptionVersion")) !== null && _g !== void 0 ? _g : 0) + 1,
                subscriptionUpdatedAt: s.serverTimestamp(),
                updatedAt: s.serverTimestamp(),
                updatedBy: admin.uid,
            };
            tx.set(subscriptionRef, rejectedState, { merge: true });
            tx.set(merchantRef, Object.assign(Object.assign(Object.assign({}, rejectedState), ((0, validators_js_1.readString)(merchantData, "activeManualSubscriptionRequestId") === requestId
                ? { activeManualSubscriptionRequestId: null }
                : {})), { manualSubscriptionRequestUpdatedAt: s.serverTimestamp() }), { merge: true });
            tx.set(opLogRef, {
                action: "reject_manual_subscription_request",
                entityType: "manual_subscription_request",
                requestId,
                merchantId,
                planName,
                rejectionReason: cleanReason,
                adminUid: admin.uid,
                adminEmail: admin.email,
                adminName: admin.name,
                createdAt: s.serverTimestamp(),
            });
            return {
                success: true,
                requestId,
                merchantId,
                status: "rejected",
                rejectionReason: cleanReason,
                rejectedBy: admin.uid,
                message: "تم رفض طلب الاشتراك وإرسال إشعار بالسبب إلى التاجر.",
            };
        });
        const notifTitle = "تم رفض طلب الاشتراك";
        const notifBody = `تعذر اعتماد طلب اشتراك (${planName}). السبب: ${cleanReason}`;
        await this.db
            .collection("merchants")
            .doc(result.merchantId)
            .collection("notifications")
            .doc(`sub_rejected_${requestId}`)
            .set({
            type: "subscription_rejected",
            title: notifTitle,
            body: notifBody,
            requestId,
            merchantId: result.merchantId,
            reason: cleanReason,
            isRead: false,
            createdAt: s.serverTimestamp(),
        }, { merge: true });
        await this.effects.sendMerchantSubscriptionNotification({
            merchantId: result.merchantId,
            fcmToken: merchantFcmToken,
            requestId,
            eventType: "subscription_rejected",
            title: notifTitle,
            body: notifBody,
            planName,
            reason: cleanReason,
            dedupeKey: `sub_rejected_${requestId}`,
        });
        return result;
    }
    /**
     * 3. Requests the merchant to re-upload their Vodafone Cash receipt without activating subscription.
     * Sets status to `resubmission_required`, records reason, archives previous receipt attempt,
     * writes audit trail, and notifies the merchant.
     * @param {CallableAuthContext | undefined} authContext Caller auth context.
     * @param {Record<string, unknown>} data Payload containing requestId and note/reason.
     * @return {Promise<ResubmissionRequestResult>} Resubmission request result.
     */
    async requestSubscriptionReceiptResubmission(authContext, data) {
        const admin = await this.requireAdmin(authContext);
        const requestId = (0, validators_js_1.readString)(data, "requestId");
        const note = (0, validators_js_1.readString)(data, "reason", "note", "resubmissionNote");
        if (!requestId || !isValidDocId(requestId)) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "معرّف طلب الاشتراك غير صالح.");
        }
        if (!note || note.length < 3) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "يرجى كتابة سبب واضح للتاجر يوضح المطلوب إعادة رفعه.");
        }
        const cleanNote = note.slice(0, 500);
        const nowMs = this.effects.now();
        const s = this.effects.sentinels;
        const requestRef = this.db
            .collection("manual_subscription_requests")
            .doc(requestId);
        const opLogRef = this.db
            .collection("operation_logs")
            .doc(`resubmit_manual_sub_${requestId}_${nowMs}`);
        let merchantFcmToken = "";
        let planName = "";
        const result = await this.db.runTransaction(async (tx) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
            const reqSnap = await tx.get(requestRef);
            if (!reqSnap.exists) {
                throw new types_js_1.DomainHttpsError("not-found", "طلب الاشتراك غير موجود أو تم حذفه.");
            }
            const reqData = (_a = reqSnap.data()) !== null && _a !== void 0 ? _a : {};
            const currentStatus = normalizeStatus(reqData.status) || "pending_review";
            if (currentStatus === "approved") {
                throw new types_js_1.DomainHttpsError("failed-precondition", "لا يمكن طلب إعادة إرسال لطلب تمت الموافقة عليه بالفعل.");
            }
            if (currentStatus === "rejected") {
                throw new types_js_1.DomainHttpsError("failed-precondition", "لا يمكن طلب إعادة إرسال لطلب مرفوض نهائياً.");
            }
            const merchantId = (0, validators_js_1.readString)(reqData, "merchantId", "restaurantId", "uid");
            if (!merchantId || !isValidDocId(merchantId)) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "طلب الاشتراك لا يحتوي على معرّف تاجر صالح.");
            }
            const merchantRef = this.db.collection("merchants").doc(merchantId);
            const subscriptionRef = this.db.collection("subscriptions").doc(merchantId);
            const [merchantSnap, subscriptionSnap] = await Promise.all([
                tx.get(merchantRef),
                tx.get(subscriptionRef),
            ]);
            const merchantData = merchantSnap.exists ? (_b = merchantSnap.data()) !== null && _b !== void 0 ? _b : {} : {};
            const subscriptionData = subscriptionSnap.exists ? (_c = subscriptionSnap.data()) !== null && _c !== void 0 ? _c : {} : {};
            const activeRequestId = (0, validators_js_1.readString)(merchantData, "activeManualSubscriptionRequestId");
            if (activeRequestId && activeRequestId !== requestId) {
                const activeRequestSnap = await tx.get(this.db.collection("manual_subscription_requests").doc(activeRequestId));
                const activeStatus = normalizeStatus((_d = activeRequestSnap.data()) === null || _d === void 0 ? void 0 : _d.status);
                if (activeRequestSnap.exists &&
                    (ACTIVE_PENDING_STATUSES.has(activeStatus) || RESUBMISSION_STATUSES.has(activeStatus))) {
                    throw new types_js_1.DomainHttpsError("already-exists", "لدى التاجر طلب اشتراك آخر قيد المراجعة ولا يمكن فتح مراجعة ثانية.");
                }
            }
            merchantFcmToken = (0, validators_js_1.readString)(merchantData, "fcmToken");
            planName = (0, validators_js_1.readString)(reqData, "planName", "plan") || "باقة الاشتراك";
            const reviewEntry = {
                action: "resubmission_required",
                reviewerId: admin.uid,
                reviewerEmail: admin.email,
                reviewerName: admin.name,
                reason: cleanNote,
                note: cleanNote,
                timestampMs: nowMs,
                timestampIso: new Date(nowMs).toISOString(),
            };
            const existingReceiptPath = (0, validators_js_1.readString)(reqData, "receiptImagePath", "receiptPath");
            const existingReceiptUrl = (0, validators_js_1.readString)(reqData, "receiptImageUrl", "receiptUrl");
            const updatePatch = {
                status: "resubmission_required",
                paymentStatus: "resubmission_required",
                resubmissionReason: cleanNote,
                resubmissionNote: cleanNote,
                lastReviewedBy: admin.uid,
                lastReviewedByEmail: admin.email,
                lastReviewedByName: admin.name,
                lastReviewedAt: s.serverTimestamp(),
                lastReviewedAtMs: nowMs,
                reviewHistory: s.arrayUnion(reviewEntry),
                updatedAt: s.serverTimestamp(),
            };
            if (existingReceiptPath || existingReceiptUrl) {
                updatePatch.previousReceipts = s.arrayUnion({
                    receiptImagePath: existingReceiptPath,
                    receiptImageUrl: existingReceiptUrl,
                    senderPhone: (0, validators_js_1.readString)(reqData, "senderPhone"),
                    transactionReference: (0, validators_js_1.readString)(reqData, "transactionReference"),
                    flaggedReason: cleanNote,
                    flaggedAtMs: nowMs,
                    flaggedAtIso: new Date(nowMs).toISOString(),
                });
            }
            const resubPlanKey = (0, validators_js_1.readString)(reqData, "planId", "packageId");
            const resubMaxCaps = (_e = (0, validators_js_1.readNumber)(reqData, "maxCaptains")) !== null && _e !== void 0 ? _e : 0;
            const resubmissionState = {
                merchantId,
                restaurantId: merchantId,
                status: "resubmission_required",
                subscriptionStatus: "resubmission_required",
                isActive: false,
                isSubscribed: false,
                planId: legacyPlanIdForCaptainLimit(resubMaxCaps) || resubPlanKey,
                planKey: resubPlanKey,
                packageId: resubPlanKey,
                planName,
                maxCaptains: resubMaxCaps,
                captainLimit: resubMaxCaps,
                captainsCount: resubMaxCaps,
                price: (_f = (0, validators_js_1.readNumber)(reqData, "amount")) !== null && _f !== void 0 ? _f : 0,
                amount: (_g = (0, validators_js_1.readNumber)(reqData, "amount")) !== null && _g !== void 0 ? _g : 0,
                durationDays: (_h = (0, validators_js_1.readNumber)(reqData, "durationDays")) !== null && _h !== void 0 ? _h : 30,
                paymentStatus: "resubmission_required",
                paymentMethod: "vodafone_cash_manual",
                pendingRequestId: requestId,
                senderPhone: (0, validators_js_1.readString)(reqData, "senderPhone"),
                transactionReference: (0, validators_js_1.readString)(reqData, "transactionReference"),
                receiptStoragePath: existingReceiptPath,
                resubmissionReason: cleanNote,
                subscriptionVersion: Math.max((_j = (0, validators_js_1.readNumber)(subscriptionData, "subscriptionVersion")) !== null && _j !== void 0 ? _j : 0, (_k = (0, validators_js_1.readNumber)(merchantData, "subscriptionVersion")) !== null && _k !== void 0 ? _k : 0) + 1,
                subscriptionUpdatedAt: s.serverTimestamp(),
                updatedAt: s.serverTimestamp(),
                updatedBy: admin.uid,
            };
            tx.update(requestRef, updatePatch);
            tx.set(subscriptionRef, resubmissionState, { merge: true });
            tx.set(merchantRef, Object.assign(Object.assign({}, resubmissionState), { activeManualSubscriptionRequestId: requestId, manualSubscriptionRequestUpdatedAt: s.serverTimestamp() }), { merge: true });
            tx.set(opLogRef, {
                action: "request_subscription_receipt_resubmission",
                entityType: "manual_subscription_request",
                requestId,
                merchantId,
                reason: cleanNote,
                note: cleanNote,
                adminUid: admin.uid,
                adminEmail: admin.email,
                adminName: admin.name,
                createdAt: s.serverTimestamp(),
            });
            return {
                success: true,
                requestId,
                merchantId,
                status: "resubmission_required",
                note: cleanNote,
                reviewedBy: admin.uid,
                message: "تم إرسال طلب إعادة رفع الإيصال إلى التاجر دون تفعيل الاشتراك.",
            };
        });
        const notifTitle = "مطلوب إعادة رفع إيصال التحويل";
        const notifBody = `يرجى إعادة رفع إيصال الاشتراك (${planName}). السبب: ${cleanNote}`;
        await this.db
            .collection("merchants")
            .doc(result.merchantId)
            .collection("notifications")
            .doc(`sub_resubmit_${requestId}_${nowMs}`)
            .set({
            type: "subscription_resubmission_requested",
            title: notifTitle,
            body: notifBody,
            requestId,
            merchantId: result.merchantId,
            note: cleanNote,
            reason: cleanNote,
            isRead: false,
            createdAt: s.serverTimestamp(),
        });
        await this.effects.sendMerchantSubscriptionNotification({
            merchantId: result.merchantId,
            fcmToken: merchantFcmToken,
            requestId,
            eventType: "subscription_resubmission_requested",
            title: notifTitle,
            body: notifBody,
            planName,
            reason: cleanNote,
            dedupeKey: `sub_resubmit_${requestId}_${nowMs}`,
        });
        return result;
    }
    /**
     * Backwards-compatible alias delegating to requestSubscriptionReceiptResubmission.
     * @param {CallableAuthContext | undefined} authContext Caller auth context.
     * @param {Record<string, unknown>} data Payload containing requestId and note/reason.
     * @return {Promise<ResubmissionRequestResult>} Resubmission request result.
     */
    async requestManualSubscriptionResubmission(authContext, data) {
        return this.requestSubscriptionReceiptResubmission(authContext, data);
    }
    /**
     * Admin-only canonical subscription management for the general dashboard.
     * Writes subscriptions/{uid} and merchants/{uid} atomically using official server package settings.
     */
    async manageMerchantSubscription(authContext, data) {
        const admin = await this.requireAdmin(authContext);
        const operation = (0, validators_js_1.readString)(data, "operation").toLowerCase() || "upsert";
        const merchantId = (0, validators_js_1.readString)(data, "merchantId", "restaurantId");
        const legacySubscriptionId = (0, validators_js_1.readString)(data, "legacySubscriptionId");
        const rawIdempotencyKey = (0, validators_js_1.readString)(data, "idempotencyKey").trim();
        if (!isValidDocId(merchantId))
            throw new types_js_1.DomainHttpsError("invalid-argument", "معرّف حساب التاجر غير صالح.");
        if (legacySubscriptionId && !isValidDocId(legacySubscriptionId)) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "معرّف سجل الاشتراك القديم غير صالح.");
        }
        if (!["upsert", "status", "renew", "delete"].includes(operation)) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "نوع عملية الاشتراك غير مدعوم.");
        }
        if (rawIdempotencyKey &&
            (rawIdempotencyKey.length < 8 ||
                rawIdempotencyKey.length > 160 ||
                !/^[a-zA-Z0-9_.:-]+$/.test(rawIdempotencyKey))) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "مفتاح منع التكرار غير صالح.");
        }
        const nowMs = this.effects.now();
        const sentinels = this.effects.sentinels;
        const merchantRef = this.db.collection("merchants").doc(merchantId);
        const subscriptionRef = this.db.collection("subscriptions").doc(merchantId);
        const settingsRef = this.db.collection("settings").doc("manual_subscription_config");
        const restaurantRef = this.db.collection("restaurants").doc(merchantId);
        const legacyRef = legacySubscriptionId && legacySubscriptionId !== merchantId
            ? this.db.collection("subscriptions").doc(legacySubscriptionId) : null;
        const idempotencyRef = rawIdempotencyKey
            ? this.db.collection("idempotency_keys").doc(`admin_sub_${(0, node_crypto_1.createHash)("sha256").update(`${merchantId}:${operation}:${rawIdempotencyKey}`, "utf8").digest("hex").slice(0, 32)}`)
            : null;
        const merchantAuditKey = (0, node_crypto_1.createHash)("sha256").update(merchantId).digest("hex").slice(0, 20);
        const auditRef = this.db.collection("operation_logs").doc("admin_subscription_" + merchantAuditKey + "_" + nowMs);
        return this.db.runTransaction(async (tx) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x;
            const [merchantSnap, subscriptionSnap, settingsSnap, restaurantSnap, legacySnap, idemSnap] = await Promise.all([
                tx.get(merchantRef), tx.get(subscriptionRef), tx.get(settingsRef), tx.get(restaurantRef),
                legacyRef ? tx.get(legacyRef) : Promise.resolve(null),
                idempotencyRef ? tx.get(idempotencyRef) : Promise.resolve(null),
            ]);
            if (idemSnap === null || idemSnap === void 0 ? void 0 : idemSnap.exists) {
                const prev = (_a = idemSnap.data()) !== null && _a !== void 0 ? _a : {};
                return {
                    success: true,
                    alreadyApplied: true,
                    merchantId: (0, validators_js_1.readString)(prev, "merchantId") || merchantId,
                    status: (0, validators_js_1.readString)(prev, "status") || "active",
                    maxCaptains: (_b = (0, validators_js_1.readNumber)(prev, "maxCaptains")) !== null && _b !== void 0 ? _b : 0,
                    startDate: (0, validators_js_1.readString)(prev, "startDate"),
                    endDate: (0, validators_js_1.readString)(prev, "endDate"),
                    subscriptionVersion: (_c = (0, validators_js_1.readNumber)(prev, "subscriptionVersion")) !== null && _c !== void 0 ? _c : 1,
                    message: "تم تنفيذ عملية الاشتراك هذه مسبقاً بنجاح (منع تكرار تلقائي).",
                };
            }
            if (!merchantSnap.exists) {
                throw new types_js_1.DomainHttpsError("not-found", "حساب التاجر غير موجود في مجموعة merchants؛ لا يمكن ربط الاشتراك بحساب دخول.");
            }
            const merchant = (_d = merchantSnap.data()) !== null && _d !== void 0 ? _d : {};
            if ((0, validators_js_1.readString)(merchant, "accountType").toLowerCase() !== "merchant") {
                throw new types_js_1.DomainHttpsError("failed-precondition", "المستند المحدد ليس حساب تاجر.");
            }
            const merchantAccountStatus = (0, validators_js_1.readString)(merchant, "status").toLowerCase();
            if (!["active", "approved"].includes(merchantAccountStatus) && merchant.isApproved !== true) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "حساب التاجر لم يحصل على موافقة الإدارة بعد.");
            }
            if (merchant.isBlocked === true || merchant.isSuspended === true ||
                ["blocked", "banned", "suspended", "disabled", "inactive"].includes((0, validators_js_1.readString)(merchant, "status").toLowerCase())) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "حساب التاجر موقوف ولا يمكن إدارة اشتراكه.");
            }
            const merchantUid = (0, validators_js_1.readString)(merchant, "uid");
            if (merchantUid && merchantUid !== merchantId) {
                throw new types_js_1.DomainHttpsError("permission-denied", "UID حساب التاجر غير مطابق لمعرّف المستند.");
            }
            const currentSub = subscriptionSnap.exists ? (_e = subscriptionSnap.data()) !== null && _e !== void 0 ? _e : {} : {};
            if (legacySnap === null || legacySnap === void 0 ? void 0 : legacySnap.exists) {
                const legacyMerchantId = (0, validators_js_1.readString)(legacySnap.data(), "merchantId", "restaurantId");
                if (legacyMerchantId && legacyMerchantId !== merchantId) {
                    throw new types_js_1.DomainHttpsError("permission-denied", "سجل الاشتراك القديم لا يخص هذا التاجر.");
                }
            }
            let maxCaptains = (_g = (_f = (0, validators_js_1.readNumber)(currentSub, "maxCaptains", "captainLimit", "captainsCount")) !== null && _f !== void 0 ? _f : (0, validators_js_1.readNumber)(merchant, "maxCaptains", "captainLimit", "captainsCount")) !== null && _g !== void 0 ? _g : 0;
            let planName = (0, validators_js_1.readString)(currentSub, "planName", "plan", "subscriptionPlan") ||
                (0, validators_js_1.readString)(merchant, "planName", "plan", "subscriptionPlan");
            let planKey = (0, validators_js_1.readString)(currentSub, "planKey", "packageId") ||
                (0, validators_js_1.readString)(merchant, "planKey", "packageId");
            let price = (_j = (_h = (0, validators_js_1.readNumber)(currentSub, "price", "amount")) !== null && _h !== void 0 ? _h : (0, validators_js_1.readNumber)(merchant, "price")) !== null && _j !== void 0 ? _j : 0;
            let startDate = (0, validators_js_1.readString)(currentSub, "startDate", "subscriptionStartDate") || (0, validators_js_1.readString)(merchant, "subscriptionStartDate");
            let endDate = (0, validators_js_1.readString)(currentSub, "endDate", "subscriptionEndDate") || (0, validators_js_1.readString)(merchant, "subscriptionEndDate");
            let durationDays = (_k = (0, validators_js_1.readNumber)(currentSub, "durationDays")) !== null && _k !== void 0 ? _k : 30;
            let requestedStatus = (0, validators_js_1.readString)(data, "status").toLowerCase();
            if (operation === "upsert" || operation === "renew") {
                if (!settingsSnap.exists)
                    throw new types_js_1.DomainHttpsError("failed-precondition", "إعدادات الباقات الرسمية غير موجودة.");
                const settings = (_l = settingsSnap.data()) !== null && _l !== void 0 ? _l : {};
                const plans = Array.isArray(settings.plans) ? settings.plans : [];
                const requestedPlanKey = (0, validators_js_1.readString)(data, "planId", "planKey", "packageId");
                const requestedNumericPlanId = (0, validators_js_1.readNumber)(data, "planId", "packageId");
                if (operation === "upsert") {
                    const requestedCaps = Math.round((_m = (0, validators_js_1.readNumber)(data, "maxCaptains", "captainsCount", "captainLimit")) !== null && _m !== void 0 ? _m : 0);
                    const selectedPlan = findAuthoritativePlan(plans, {
                        planId: requestedPlanKey,
                        numericPlanId: requestedNumericPlanId,
                        maxCaptains: requestedCaps,
                    });
                    if (!selectedPlan || selectedPlan.isActive === false) {
                        throw new types_js_1.DomainHttpsError("failed-precondition", "الباقة المختارة غير موجودة أو غير مفعلة في إعدادات الإدارة.");
                    }
                    maxCaptains = Math.round((_o = (0, validators_js_1.readNumber)(selectedPlan, "maxCaptains", "captainsCount")) !== null && _o !== void 0 ? _o : requestedCaps);
                    planKey = (0, validators_js_1.readString)(selectedPlan, "planId") || ("plan_" + maxCaptains + "_captains");
                    planName = (0, validators_js_1.readString)(selectedPlan, "planName", "label", "name") || (maxCaptains + " كابتن");
                    const officialPrice = (_p = (0, validators_js_1.readNumber)(selectedPlan, "price")) !== null && _p !== void 0 ? _p : 0;
                    const suppliedPrice = (0, validators_js_1.readNumber)(data, "price", "amount");
                    if (officialPrice <= 0 || (suppliedPrice !== null && Math.abs(suppliedPrice - officialPrice) > 0.01)) {
                        throw new types_js_1.DomainHttpsError("failed-precondition", "السعر المرسل لا يطابق السعر الرسمي للباقة.");
                    }
                    price = officialPrice;
                    const rawPlanDur = (_r = (_q = (0, validators_js_1.readNumber)(selectedPlan, "durationDays")) !== null && _q !== void 0 ? _q : (0, validators_js_1.readNumber)(settings, "durationDays")) !== null && _r !== void 0 ? _r : 30;
                    durationDays = rawPlanDur >= 1 && rawPlanDur <= 365 ? Math.round(rawPlanDur) : 30;
                    startDate = (0, validators_js_1.readString)(data, "startDate") || (0, validators_js_1.formatYmdUtc)(nowMs);
                    const expectedWindow = (0, validators_js_1.computeUnifiedSubscriptionWindow)(startDate, durationDays);
                    const suppliedEndDate = (0, validators_js_1.readString)(data, "endDate");
                    if (suppliedEndDate && suppliedEndDate !== expectedWindow.endDate) {
                        throw new types_js_1.DomainHttpsError("invalid-argument", "تاريخ انتهاء الاشتراك لا يطابق مدة الباقة الرسمية.");
                    }
                    endDate = expectedWindow.endDate;
                    requestedStatus = requestedStatus || "active";
                }
                else {
                    if (!subscriptionSnap.exists || maxCaptains <= 0) {
                        throw new types_js_1.DomainHttpsError("failed-precondition", "لا يوجد اشتراك حالي صالح للتجديد.");
                    }
                    const renewPlanKey = requestedPlanKey || planKey;
                    const selectedPlan = findAuthoritativePlan(plans, {
                        planId: renewPlanKey,
                        numericPlanId: requestedNumericPlanId,
                        maxCaptains,
                    });
                    if (!selectedPlan || selectedPlan.isActive === false) {
                        throw new types_js_1.DomainHttpsError("failed-precondition", "الباقة الحالية غير موجودة أو غير مفعلة.");
                    }
                    maxCaptains = Math.round((_s = (0, validators_js_1.readNumber)(selectedPlan, "maxCaptains", "captainsCount")) !== null && _s !== void 0 ? _s : maxCaptains);
                    planKey = (0, validators_js_1.readString)(selectedPlan, "planId") || renewPlanKey;
                    planName = (0, validators_js_1.readString)(selectedPlan, "planName", "label", "name") || planName;
                    const officialPrice = (_t = (0, validators_js_1.readNumber)(selectedPlan, "price")) !== null && _t !== void 0 ? _t : 0;
                    const suppliedPrice = (0, validators_js_1.readNumber)(data, "price", "amount");
                    if (officialPrice <= 0 || (suppliedPrice !== null && Math.abs(suppliedPrice - officialPrice) > 0.01)) {
                        throw new types_js_1.DomainHttpsError("failed-precondition", "السعر المرسل لا يطابق السعر الرسمي للباقة.");
                    }
                    price = officialPrice;
                    const rawPlanDur = (_v = (_u = (0, validators_js_1.readNumber)(selectedPlan, "durationDays")) !== null && _u !== void 0 ? _u : (0, validators_js_1.readNumber)(settings, "durationDays")) !== null && _v !== void 0 ? _v : 30;
                    durationDays = rawPlanDur >= 1 && rawPlanDur <= 365 ? Math.round(rawPlanDur) : 30;
                    const oldEndMs = (0, validators_js_1.parseYmdEndUtc)(endDate);
                    const baseMs = oldEndMs !== null && oldEndMs > nowMs ? oldEndMs + 1 : nowMs;
                    // Unified inclusive window: renewal starts immediately after the current paid-through date (or today if expired).
                    const renewWindow = (0, validators_js_1.computeUnifiedSubscriptionWindow)(baseMs, durationDays);
                    startDate = renewWindow.startDate;
                    endDate = renewWindow.endDate;
                    requestedStatus = "active";
                }
                if (durationDays < 1 || durationDays > 365)
                    throw new types_js_1.DomainHttpsError("failed-precondition", "مدة الباقة الرسمية غير صالحة.");
            }
            else if (!subscriptionSnap.exists) {
                throw new types_js_1.DomainHttpsError("not-found", "لا يوجد سجل اشتراك لتغيير حالته.");
            }
            const statuses = {
                "active": "active", "approved": "active", "ساري": "active", "نشط": "active",
                "pending": "pending", "معلق": "pending",
                "suspended": "suspended", "inactive": "suspended", "موقوف": "suspended",
                "expired": "expired", "منتهي": "expired",
                "cancelled": "cancelled", "canceled": "cancelled", "ملغي": "cancelled",
            };
            const nextStatus = operation === "delete" ? "cancelled" : statuses[requestedStatus];
            if (!nextStatus)
                throw new types_js_1.DomainHttpsError("invalid-argument", "حالة الاشتراك المطلوبة غير صالحة.");
            if (operation === "status" && nextStatus === "active") {
                const existingEnd = (0, validators_js_1.parseYmdEndUtc)(endDate);
                if (existingEnd !== null && existingEnd <= nowMs) {
                    throw new types_js_1.DomainHttpsError("failed-precondition", "انتهى الاشتراك؛ استخدم التجديد بدلاً من إعادة التفعيل.");
                }
            }
            const startMs = (0, validators_js_1.parseYmdStartUtc)(startDate);
            const endMs = (0, validators_js_1.parseYmdEndUtc)(endDate);
            const isActive = nextStatus === "active";
            if (isActive && (startMs === null || endMs === null || endMs <= nowMs)) {
                throw new types_js_1.DomainHttpsError("invalid-argument", "تاريخ بداية أو نهاية الاشتراك غير صالح أو منتهي.");
            }
            if (maxCaptains < validators_js_1.MIN_PACKAGE_CAPTAINS || maxCaptains > validators_js_1.MAX_PACKAGE_CAPTAINS || price <= 0) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "بيانات الباقة الحالية غير مكتملة.");
            }
            // Preserve prior subscription history on renewal or replacement of an existing period
            if (subscriptionSnap.exists && (operation === "renew" || operation === "upsert")) {
                const prevStartDate = (0, validators_js_1.readString)(currentSub, "startDate", "subscriptionStartDate");
                const prevEndDate = (0, validators_js_1.readString)(currentSub, "endDate", "subscriptionEndDate");
                if (operation === "renew" || prevStartDate !== startDate || prevEndDate !== endDate) {
                    this.archivePreviousSubscriptionInTx(tx, merchantId, currentSub, operation === "renew" ? "admin_renewed" : "admin_replaced", nowMs, admin.uid);
                }
            }
            const resolvedPlanKey = planKey || ("plan_" + maxCaptains + "_captains");
            const planId = legacyPlanIdForCaptainLimit(maxCaptains) || resolvedPlanKey;
            const version = Math.max((_w = (0, validators_js_1.readNumber)(currentSub, "subscriptionVersion")) !== null && _w !== void 0 ? _w : 0, (_x = (0, validators_js_1.readNumber)(merchant, "subscriptionVersion")) !== null && _x !== void 0 ? _x : 0) + 1;
            const subscriptionNumber = `SUB-${merchantId.slice(0, 6).toUpperCase()}-V${version}`;
            const merchantName = (0, validators_js_1.readString)(merchant, "name", "merchantName", "restaurantName") || "تاجر مسجل";
            const merchantPhone = (0, validators_js_1.readString)(merchant, "phone", "phoneNumber");
            const merchantEmail = (0, validators_js_1.readString)(merchant, "email", "ownerEmail");
            const common = {
                subscriptionId: merchantId, subscriptionNumber,
                merchantId, restaurantId: merchantId, merchantName, restaurantName: merchantName,
                merchantPhone, merchantEmail,
                status: nextStatus, subscriptionStatus: nextStatus, isActive, isSubscribed: isActive,
                planId, planKey: resolvedPlanKey, packageId: resolvedPlanKey, planName, packageName: planName, plan: planName,
                maxCaptains, captainLimit: maxCaptains, captainsCount: maxCaptains,
                price, amount: price, durationDays, paymentMethod: "admin_manual",
                paymentStatus: nextStatus === "pending" ? "pending" : "admin_manual",
                startDate, subscriptionStartDate: startDate, endDate, subscriptionEndDate: endDate,
                startDateMs: startMs, endDateMs: endMs, expiresAt: endMs, subscriptionExpiresAt: endMs,
                activatedAt: isActive ? (startMs !== null && startMs !== void 0 ? startMs : nowMs) : null, pendingRequestId: null,
                suspensionReason: nextStatus === "suspended" ? "تم الإيقاف بواسطة الإدارة" : null,
                cancellationReason: nextStatus === "cancelled" ? "تم الإلغاء بواسطة الإدارة" : null,
                subscriptionVersion: version, subscriptionUpdatedAt: sentinels.serverTimestamp(),
                updatedAt: sentinels.serverTimestamp(), updatedBy: admin.uid, updatedByAdminUid: admin.uid,
                lastAdminSubscriptionAction: operation,
            };
            tx.set(subscriptionRef, common, { merge: true });
            tx.set(merchantRef, {
                subscriptionStatus: nextStatus, isSubscribed: isActive, planId,
                planKey: resolvedPlanKey, packageId: resolvedPlanKey, planName, packageName: planName,
                subscriptionPlan: planName, maxCaptains, captainLimit: maxCaptains,
                captainsCount: maxCaptains, price, paymentMethod: "admin_manual",
                paymentStatus: nextStatus === "pending" ? "pending" : "admin_manual",
                subscriptionStartDate: startDate, subscriptionEndDate: endDate,
                subscriptionExpiresAt: endMs, pendingRequestId: null,
                suspensionReason: nextStatus === "suspended" ? "تم الإيقاف بواسطة الإدارة" : null,
                cancellationReason: nextStatus === "cancelled" ? "تم الإلغاء بواسطة الإدارة" : null,
                subscriptionVersion: version, subscriptionUpdatedAt: sentinels.serverTimestamp(),
                updatedAt: sentinels.serverTimestamp(), updatedBy: admin.uid, updatedByAdminUid: admin.uid,
            }, { merge: true });
            if (restaurantSnap.exists) {
                tx.set(restaurantRef, {
                    subscriptionStatus: nextStatus, isSubscribed: isActive, subscriptionPlan: planName,
                    planName, maxCaptains, captainLimit: maxCaptains, captainsCount: maxCaptains,
                    subscriptionPrice: price, price, subscriptionStartDate: startDate,
                    subscriptionEndDate: endDate, subscriptionExpiresAt: endMs,
                    subscriptionVersion: version, subscriptionUpdatedAt: sentinels.serverTimestamp(),
                    updatedAt: sentinels.serverTimestamp(),
                }, { merge: true });
            }
            if (legacyRef && (legacySnap === null || legacySnap === void 0 ? void 0 : legacySnap.exists)) {
                tx.set(legacyRef, {
                    status: "migrated",
                    subscriptionStatus: "migrated",
                    isActive: false,
                    isSubscribed: false,
                    migratedToMerchantId: merchantId,
                    migratedAt: sentinels.serverTimestamp(),
                    updatedAt: sentinels.serverTimestamp(),
                }, { merge: true });
            }
            if (idempotencyRef) {
                tx.set(idempotencyRef, {
                    idempotencyKey: rawIdempotencyKey,
                    merchantId,
                    operation,
                    status: nextStatus,
                    maxCaptains,
                    startDate,
                    endDate,
                    subscriptionVersion: version,
                    adminUid: admin.uid,
                    createdAt: sentinels.serverTimestamp(),
                });
            }
            tx.set(auditRef, {
                action: "admin_" + operation + "_merchant_subscription", entityType: "merchant_subscription",
                merchantId, status: nextStatus, planId, planKey: resolvedPlanKey,
                maxCaptains, amount: price, durationDays, startDate, endDate, paymentMethod: "admin_manual",
                adminUid: admin.uid, adminEmail: admin.email, adminName: admin.name,
                createdAt: sentinels.serverTimestamp(),
            });
            return {
                success: true, alreadyApplied: false, merchantId, status: nextStatus, maxCaptains, startDate, endDate,
                subscriptionVersion: version,
                message: operation === "renew" ?
                    "تم تجديد الاشتراك ومزامنة بيانات التاجر بنجاح." :
                    isActive ?
                        "تم تفعيل الاشتراك ومزامنة بيانات التاجر وتطبيق التاجر بنجاح." :
                        "تم تحديث حالة الاشتراك ومزامنة بيانات التاجر بنجاح.",
            };
        });
    }
    /**
     * Admin-only authoritative manual payment recording with idempotency protection.
     * - Always writes an audited financial entry in `payments/{paymentDocId}`.
     * - ONLY when `applySubscription === true` AND `paymentStatus === "paid"`, atomically archives
     *   any previous period into `subscription_history` and activates/renews `subscriptions/{merchantId}`
     *   and `merchants/{merchantId}` so the Android Merchant App reflects the subscription immediately.
     * - Non-subscription financial payments (`applySubscription === false`) NEVER touch subscriptions.
     * @param {CallableAuthContext | undefined} authContext Caller auth context.
     * @param {Record<string, unknown>} data Payment payload.
     * @return {Promise<RecordManualPaymentResult>} Recorded payment & subscription sync result.
     */
    async recordManualPayment(authContext, data) {
        var _a, _b;
        const admin = await this.requireAdmin(authContext);
        const merchantId = (0, validators_js_1.readString)(data, "merchantId", "restaurantId");
        if (!isValidDocId(merchantId)) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "يجب اختيار تاجر مسجل بمعرّف صالح.");
        }
        const rawIdempotencyKey = (0, validators_js_1.readString)(data, "idempotencyKey").trim();
        if (rawIdempotencyKey.length < 8 ||
            rawIdempotencyKey.length > 160 ||
            !/^[a-zA-Z0-9_.:-]+$/.test(rawIdempotencyKey)) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "مفتاح منع تكرار الدفعة غير صالح. يرجى المحاولة مرة أخرى.");
        }
        const rawAmount = (0, validators_js_1.readNumber)(data, "amount", "price");
        if (rawAmount === null || !Number.isFinite(rawAmount) || rawAmount <= 0 || rawAmount > 100000) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "قيمة المبلغ المدفوع يجب أن تكون رقماً موجباً صالحاً.");
        }
        const amount = Math.round(rawAmount * 100) / 100;
        const rawPaymentMethod = (0, validators_js_1.readString)(data, "paymentMethod", "method") || "كاش نقدي (Cash)";
        const paymentMethodLower = rawPaymentMethod.toLowerCase();
        const methodCode = paymentMethodLower.includes("vodafone") || paymentMethodLower.includes("فودافون")
            ? "vodafone_cash"
            : paymentMethodLower.includes("instapay") || paymentMethodLower.includes("إنستا")
                ? "instapay"
                : paymentMethodLower.includes("bank") || paymentMethodLower.includes("بنك")
                    ? "bank_transfer"
                    : paymentMethodLower.includes("wallet") || paymentMethodLower.includes("محفظة")
                        ? "wallet"
                        : "cash";
        const rawStatus = (0, validators_js_1.readString)(data, "paymentStatus", "status").toLowerCase() || "paid";
        const paymentStatus = ["pending", "pending_verification", "processing", "معلق"].includes(rawStatus)
            ? "pending"
            : ["failed", "rejected", "cancelled", "فاشلة", "مرفوض"].includes(rawStatus)
                ? "failed"
                : "paid";
        const ledgerStatus = paymentStatus === "paid" ? "success" : paymentStatus;
        const applySubscription = data.applySubscription === true;
        const subscriptionAction = (0, validators_js_1.readString)(data, "subscriptionAction").toLowerCase() || "activate";
        const requestedPlanId = (0, validators_js_1.readString)(data, "planId", "packageId", "planKey");
        const requestedMaxCaptains = Math.round((_a = (0, validators_js_1.readNumber)(data, "maxCaptains", "captainLimit", "captainsCount")) !== null && _a !== void 0 ? _a : 0);
        const transactionReference = (0, validators_js_1.readString)(data, "transactionReference", "referenceNumber", "transactionId").slice(0, 120);
        const notes = (0, validators_js_1.readString)(data, "notes").slice(0, 500);
        const nowMs = this.effects.now();
        const s = this.effects.sentinels;
        const rawPaymentDate = (0, validators_js_1.readString)(data, "paymentDate", "date");
        const paymentDateYmd = /^\d{4}-\d{2}-\d{2}$/.test(rawPaymentDate)
            ? rawPaymentDate
            : (0, validators_js_1.formatYmdUtc)(nowMs);
        const parsedPayDateMs = Date.parse(`${paymentDateYmd}T00:00:00.000Z`);
        if (!Number.isFinite(parsedPayDateMs)) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "تاريخ الدفع غير صالح.");
        }
        const paymentDocId = `manual_pay_${(0, node_crypto_1.createHash)("sha256")
            .update(`${merchantId}:${rawIdempotencyKey}`, "utf8")
            .digest("hex")
            .slice(0, 32)}`;
        const transactionId = transactionReference || `PAY-${paymentDocId.slice(-8).toUpperCase()}`;
        const paymentRef = this.db.collection("payments").doc(paymentDocId);
        const merchantRef = this.db.collection("merchants").doc(merchantId);
        const subscriptionRef = this.db.collection("subscriptions").doc(merchantId);
        const restaurantRef = this.db.collection("restaurants").doc(merchantId);
        const settingsRef = this.db.collection("settings").doc("manual_subscription_config");
        const opLogRef = this.db
            .collection("operation_logs")
            .doc(`record_manual_payment_${paymentDocId}`);
        let merchantFcmToken = "";
        const result = await this.db.runTransaction(async (tx) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
            const [existingPaymentSnap, merchantSnap, subscriptionSnap, settingsSnap, restaurantSnap] = await Promise.all([
                tx.get(paymentRef),
                tx.get(merchantRef),
                tx.get(subscriptionRef),
                tx.get(settingsRef),
                tx.get(restaurantRef),
            ]);
            // Idempotency guard: never create a duplicate payment or double-extend subscription
            if (existingPaymentSnap.exists) {
                const existing = (_a = existingPaymentSnap.data()) !== null && _a !== void 0 ? _a : {};
                return {
                    success: true,
                    alreadyRecorded: true,
                    paymentDocId,
                    transactionId: (0, validators_js_1.readString)(existing, "transactionId") || transactionId,
                    merchantId: (0, validators_js_1.readString)(existing, "merchantId") || merchantId,
                    merchantName: (0, validators_js_1.readString)(existing, "merchantName", "restaurantName") || "تاجر مسجل",
                    amount: (_b = (0, validators_js_1.readNumber)(existing, "amount")) !== null && _b !== void 0 ? _b : amount,
                    paymentMethod: (0, validators_js_1.readString)(existing, "paymentMethod") || rawPaymentMethod,
                    paymentStatus: (0, validators_js_1.readString)(existing, "paymentStatus") || paymentStatus,
                    status: (0, validators_js_1.readString)(existing, "status") || ledgerStatus,
                    applySubscription: Boolean(existing.subscriptionId),
                    subscriptionActivated: Boolean(existing.subscriptionId && existing.paymentStatus === "paid"),
                    subscriptionId: (0, validators_js_1.readString)(existing, "subscriptionId") || undefined,
                    planId: (0, validators_js_1.readString)(existing, "packageId", "planId") || undefined,
                    planName: (0, validators_js_1.readString)(existing, "planName") || undefined,
                    maxCaptains: (_c = (0, validators_js_1.readNumber)(existing, "maxCaptains")) !== null && _c !== void 0 ? _c : undefined,
                    startDate: (0, validators_js_1.readString)(existing, "subscriptionStartDate") || undefined,
                    endDate: (0, validators_js_1.readString)(existing, "subscriptionEndDate") || undefined,
                    subscriptionVersion: (_d = (0, validators_js_1.readNumber)(existing, "subscriptionVersion")) !== null && _d !== void 0 ? _d : undefined,
                    message: "تم تسجيل هذه الدفعة مسبقاً بنجاح (منع تكرار تلقائي).",
                };
            }
            if (!merchantSnap.exists) {
                throw new types_js_1.DomainHttpsError("not-found", "حساب التاجر غير موجود في قاعدة البيانات (merchants).");
            }
            const merchant = (_e = merchantSnap.data()) !== null && _e !== void 0 ? _e : {};
            if ((0, validators_js_1.readString)(merchant, "accountType").toLowerCase() !== "merchant") {
                throw new types_js_1.DomainHttpsError("failed-precondition", "الحساب المحدد ليس حساب تاجر معتمداً.");
            }
            const merchantAccountStatus = (0, validators_js_1.readString)(merchant, "status").toLowerCase();
            if (merchant.isBlocked === true ||
                merchant.isSuspended === true ||
                ["blocked", "banned", "suspended", "disabled"].includes(merchantAccountStatus)) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "حساب التاجر موقوف حالياً ولا يمكن تنفيذ العملية عليه.");
            }
            const merchantName = (0, validators_js_1.readString)(merchant, "name", "merchantName", "restaurantName") || "تاجر مسجل";
            const merchantPhone = (0, validators_js_1.readString)(merchant, "phone", "phoneNumber");
            const merchantEmail = (0, validators_js_1.readString)(merchant, "email", "ownerEmail");
            merchantFcmToken = (0, validators_js_1.readString)(merchant, "fcmToken");
            const shouldActivateSubscription = applySubscription && paymentStatus === "paid";
            let resolvedPlanKey = "";
            let resolvedPlanName = "";
            let resolvedMaxCaptains = 0;
            let resolvedDurationDays = 30;
            let startDateYmd = "";
            let endDateYmd = "";
            let endDateMs = 0;
            let nextVersion;
            let subscriptionNumber = "";
            if (applySubscription) {
                if (!settingsSnap.exists) {
                    throw new types_js_1.DomainHttpsError("failed-precondition", "إعدادات الباقات الرسمية غير موجودة في قاعدة البيانات.");
                }
                const settings = (_f = settingsSnap.data()) !== null && _f !== void 0 ? _f : {};
                const plans = Array.isArray(settings.plans)
                    ? settings.plans
                    : [];
                const requestedNumericPlanId = (0, validators_js_1.readNumber)(data, "planId", "packageId");
                const matchedPlan = findAuthoritativePlan(plans, {
                    planId: requestedPlanId,
                    numericPlanId: requestedNumericPlanId,
                    maxCaptains: requestedMaxCaptains,
                });
                if (!matchedPlan || matchedPlan.isActive === false) {
                    throw new types_js_1.DomainHttpsError("failed-precondition", "يجب اختيار باقة اشتراك رسمية ومفعّلة عند ربط الدفعة بالاشتراك.");
                }
                const officialPlanPrice = (_g = (0, validators_js_1.readNumber)(matchedPlan, "price")) !== null && _g !== void 0 ? _g : 0;
                if (officialPlanPrice <= 0) {
                    throw new types_js_1.DomainHttpsError("failed-precondition", "السعر الرسمي للباقة المختارة غير مضبوط بشكل صالح.");
                }
                if (Math.abs(amount - officialPlanPrice) > 0.01) {
                    throw new types_js_1.DomainHttpsError("failed-precondition", `المبلغ المدفوع (${amount}) لا يطابق السعر الرسمي للباقة المختارة (${officialPlanPrice}).`);
                }
                resolvedMaxCaptains = Math.round((_h = (0, validators_js_1.readNumber)(matchedPlan, "maxCaptains", "captainsCount")) !== null && _h !== void 0 ? _h : 0);
                if (resolvedMaxCaptains < validators_js_1.MIN_PACKAGE_CAPTAINS ||
                    resolvedMaxCaptains > validators_js_1.MAX_PACKAGE_CAPTAINS) {
                    throw new types_js_1.DomainHttpsError("failed-precondition", "عدد الكباتن في الباقة الرسمية غير صالح (يجب أن يكون بين 1 و 100).");
                }
                resolvedPlanKey =
                    (0, validators_js_1.readString)(matchedPlan, "planId") || `plan_${resolvedMaxCaptains}_captains`;
                resolvedPlanName =
                    (0, validators_js_1.readString)(matchedPlan, "planName", "label", "name") ||
                        `باقة ${resolvedMaxCaptains} كابتن`;
                const rawDur = (_k = (_j = (0, validators_js_1.readNumber)(matchedPlan, "durationDays")) !== null && _j !== void 0 ? _j : (0, validators_js_1.readNumber)(settings, "durationDays")) !== null && _k !== void 0 ? _k : 30;
                resolvedDurationDays = rawDur >= 1 && rawDur <= 365 ? Math.round(rawDur) : 30;
                if (shouldActivateSubscription) {
                    if (!["active", "approved"].includes(merchantAccountStatus) &&
                        merchant.isApproved !== true) {
                        throw new types_js_1.DomainHttpsError("failed-precondition", "حساب التاجر غير معتمد بعد ولا يمكن تفعيل اشتراكه قبل الموافقة على الحساب.");
                    }
                    const currentSub = subscriptionSnap.exists ? (_l = subscriptionSnap.data()) !== null && _l !== void 0 ? _l : {} : {};
                    if (subscriptionSnap.exists) {
                        this.archivePreviousSubscriptionInTx(tx, merchantId, currentSub, subscriptionAction === "renew" ? "manual_payment_renewal" : "manual_payment_activation", nowMs, admin.uid);
                    }
                    const prevEndMs = Math.max((0, validators_js_1.parseTimestampMs)(currentSub.expiresAt), (0, validators_js_1.parseTimestampMs)(currentSub.endDateMs), (_m = (0, validators_js_1.parseYmdEndUtc)((0, validators_js_1.readString)(currentSub, "endDate", "subscriptionEndDate"))) !== null && _m !== void 0 ? _m : 0);
                    const isRenewalExtension = subscriptionAction === "renew" &&
                        normalizeStatus(currentSub.status) === "active" &&
                        prevEndMs > nowMs;
                    const startBaseMs = isRenewalExtension
                        ? prevEndMs + 1
                        : Math.max(parsedPayDateMs, (_o = (0, validators_js_1.parseYmdStartUtc)((0, validators_js_1.formatYmdUtc)(nowMs))) !== null && _o !== void 0 ? _o : nowMs);
                    const payWindow = (0, validators_js_1.computeUnifiedSubscriptionWindow)(startBaseMs, resolvedDurationDays);
                    const startDateMs = payWindow.startDateMs;
                    endDateMs = payWindow.endDateMs;
                    startDateYmd = payWindow.startDate;
                    endDateYmd = payWindow.endDate;
                    nextVersion =
                        Math.max((_p = (0, validators_js_1.readNumber)(currentSub, "subscriptionVersion")) !== null && _p !== void 0 ? _p : 0, (_q = (0, validators_js_1.readNumber)(merchant, "subscriptionVersion")) !== null && _q !== void 0 ? _q : 0) + 1;
                    subscriptionNumber = `SUB-${merchantId.slice(0, 6).toUpperCase()}-V${nextVersion}`;
                    const numericOrKeyPlanId = legacyPlanIdForCaptainLimit(resolvedMaxCaptains) || resolvedPlanKey;
                    // Atomically activate/renew subscriptions/{merchantId}
                    tx.set(subscriptionRef, {
                        subscriptionId: merchantId,
                        subscriptionNumber,
                        merchantId,
                        restaurantId: merchantId,
                        merchantName,
                        restaurantName: merchantName,
                        merchantPhone,
                        merchantEmail,
                        status: "active",
                        subscriptionStatus: "active",
                        isActive: true,
                        isSubscribed: true,
                        planId: numericOrKeyPlanId,
                        planKey: resolvedPlanKey,
                        packageId: resolvedPlanKey,
                        planName: resolvedPlanName,
                        packageName: resolvedPlanName,
                        plan: resolvedPlanName,
                        maxCaptains: resolvedMaxCaptains,
                        captainLimit: resolvedMaxCaptains,
                        captainsCount: resolvedMaxCaptains,
                        price: amount,
                        amount,
                        durationDays: resolvedDurationDays,
                        paymentStatus: "paid",
                        paymentMethod: methodCode,
                        paymentMethodLabel: rawPaymentMethod,
                        lastPaymentId: paymentDocId,
                        pendingRequestId: null,
                        startDate: startDateYmd,
                        subscriptionStartDate: startDateYmd,
                        endDate: endDateYmd,
                        subscriptionEndDate: endDateYmd,
                        startDateMs,
                        endDateMs,
                        expiresAt: endDateMs,
                        subscriptionExpiresAt: endDateMs,
                        activatedAt: s.serverTimestamp(),
                        suspensionReason: null,
                        cancellationReason: null,
                        approvedBy: admin.uid,
                        approvedByEmail: admin.email,
                        approvedAt: s.serverTimestamp(),
                        updatedBy: admin.uid,
                        updatedByAdminUid: admin.uid,
                        subscriptionVersion: nextVersion,
                        subscriptionUpdatedAt: s.serverTimestamp(),
                        updatedAt: s.serverTimestamp(),
                        lastAdminSubscriptionAction: "manual_payment",
                    }, { merge: true });
                    // Atomically sync merchants/{merchantId} for Android Merchant App
                    tx.set(merchantRef, {
                        subscriptionStatus: "active",
                        isSubscribed: true,
                        isActive: true,
                        planId: numericOrKeyPlanId,
                        planKey: resolvedPlanKey,
                        packageId: resolvedPlanKey,
                        planName: resolvedPlanName,
                        packageName: resolvedPlanName,
                        subscriptionPlan: resolvedPlanName,
                        maxCaptains: resolvedMaxCaptains,
                        captainLimit: resolvedMaxCaptains,
                        captainsCount: resolvedMaxCaptains,
                        price: amount,
                        paymentStatus: "paid",
                        paymentMethod: methodCode,
                        subscriptionStartDate: startDateYmd,
                        subscriptionEndDate: endDateYmd,
                        subscriptionExpiresAt: endDateMs,
                        startDate: startDateYmd,
                        endDate: endDateYmd,
                        expiresAt: endDateMs,
                        activatedAt: s.serverTimestamp(),
                        suspensionReason: null,
                        cancellationReason: null,
                        pendingRequestId: null,
                        lastPaymentId: paymentDocId,
                        updatedBy: admin.uid,
                        updatedByAdminUid: admin.uid,
                        subscriptionVersion: nextVersion,
                        subscriptionUpdatedAt: s.serverTimestamp(),
                        updatedAt: s.serverTimestamp(),
                    }, { merge: true });
                    if (restaurantSnap.exists) {
                        tx.set(restaurantRef, {
                            subscriptionStatus: "active",
                            isSubscribed: true,
                            subscriptionPlan: resolvedPlanName,
                            planName: resolvedPlanName,
                            maxCaptains: resolvedMaxCaptains,
                            captainLimit: resolvedMaxCaptains,
                            captainsCount: resolvedMaxCaptains,
                            subscriptionPrice: amount,
                            price: amount,
                            subscriptionStartDate: startDateYmd,
                            subscriptionEndDate: endDateYmd,
                            subscriptionExpiresAt: endDateMs,
                            subscriptionVersion: nextVersion,
                            subscriptionUpdatedAt: s.serverTimestamp(),
                            updatedAt: s.serverTimestamp(),
                        }, { merge: true });
                    }
                }
            }
            // Write authoritative payment ledger record
            tx.set(paymentRef, {
                id: paymentDocId,
                idempotencyKey: rawIdempotencyKey,
                type: applySubscription ? "merchant_subscription" : "manual_financial_payment",
                source: "admin_manual_payment",
                transactionId,
                transactionNumber: transactionId,
                transactionReference,
                merchantId,
                restaurantId: merchantId,
                merchantName,
                restaurantName: merchantName,
                merchantPhone,
                subscriptionId: shouldActivateSubscription ? merchantId : null,
                subscriptionNumber: subscriptionNumber || null,
                subscriptionStartDate: startDateYmd || null,
                subscriptionEndDate: endDateYmd || null,
                subscriptionVersion: nextVersion !== null && nextVersion !== void 0 ? nextVersion : null,
                planId: resolvedPlanKey || null,
                packageId: resolvedPlanKey || null,
                planName: resolvedPlanName || null,
                packageName: resolvedPlanName || null,
                maxCaptains: resolvedMaxCaptains || null,
                captainLimit: resolvedMaxCaptains || null,
                amount,
                currency: "EGP",
                paymentMethod: rawPaymentMethod,
                method: methodCode,
                status: ledgerStatus,
                paymentStatus,
                date: paymentDateYmd,
                billingMonth: paymentDateYmd.slice(0, 7),
                notes: notes ||
                    (shouldActivateSubscription
                        ? `دفعة يدوية وتفعيل اشتراك (${resolvedPlanName})`
                        : "دفعة مالية مسجلة يدوياً من لوحة التحكم"),
                recordedBy: admin.uid,
                recordedByEmail: admin.email,
                recordedByName: admin.name,
                approvedBy: admin.uid,
                approvedByEmail: admin.email,
                paidAt: paymentStatus === "paid" ? s.serverTimestamp() : null,
                paidAtMs: paymentStatus === "paid" ? nowMs : null,
                createdAt: s.serverTimestamp(),
                createdAtMs: nowMs,
                updatedAt: s.serverTimestamp(),
            });
            tx.set(opLogRef, {
                action: "record_manual_payment",
                entityType: "payment",
                paymentDocId,
                merchantId,
                merchantName,
                amount,
                paymentMethod: rawPaymentMethod,
                paymentStatus,
                applySubscription,
                subscriptionActivated: shouldActivateSubscription,
                planId: resolvedPlanKey || null,
                planName: resolvedPlanName || null,
                maxCaptains: resolvedMaxCaptains || null,
                startDate: startDateYmd || null,
                endDate: endDateYmd || null,
                adminUid: admin.uid,
                adminEmail: admin.email,
                adminName: admin.name,
                createdAt: s.serverTimestamp(),
            });
            return {
                success: true,
                alreadyRecorded: false,
                paymentDocId,
                transactionId,
                merchantId,
                merchantName,
                amount,
                paymentMethod: rawPaymentMethod,
                paymentStatus,
                status: ledgerStatus,
                applySubscription,
                subscriptionActivated: shouldActivateSubscription,
                subscriptionId: shouldActivateSubscription ? merchantId : undefined,
                planId: resolvedPlanKey || undefined,
                planName: resolvedPlanName || undefined,
                maxCaptains: resolvedMaxCaptains || undefined,
                startDate: startDateYmd || undefined,
                endDate: endDateYmd || undefined,
                subscriptionVersion: nextVersion,
                message: shouldActivateSubscription
                    ? `تم تسجيل الدفعة بمبلغ ${amount} ج.م وتفعيل باقة "${resolvedPlanName}" للتاجر "${merchantName}" ومزامنة تطبيق التاجر بنجاح.`
                    : `تم تسجيل الدفعة المالية بمبلغ ${amount} ج.م للتاجر "${merchantName}" في سجل المدفوعات بنجاح.`,
            };
        });
        // Notify merchant if a subscription was activated or renewed
        if (!result.alreadyRecorded && result.subscriptionActivated && result.planName && result.endDate) {
            const notifTitle = "تم تفعيل اشتراكك بنجاح";
            const notifBody = `تم تسجيل دفعتك وتفعيل باقة "${result.planName}" (${result.maxCaptains} كابتن) حتى ${result.endDate}.`;
            await this.db
                .collection("merchants")
                .doc(result.merchantId)
                .collection("notifications")
                .doc(`manual_pay_${paymentDocId}`)
                .set({
                type: "subscription_approved",
                title: notifTitle,
                body: notifBody,
                paymentDocId,
                merchantId: result.merchantId,
                merchantName: result.merchantName,
                planId: result.planId || "",
                planName: result.planName,
                maxCaptains: result.maxCaptains || 0,
                endDate: result.endDate,
                isRead: false,
                createdAt: s.serverTimestamp(),
            }, { merge: true });
            await this.effects.sendMerchantSubscriptionNotification({
                merchantId: result.merchantId,
                fcmToken: merchantFcmToken,
                requestId: paymentDocId,
                eventType: "subscription_approved",
                title: notifTitle,
                body: notifBody,
                planId: result.planId || "",
                planName: result.planName,
                maxCaptains: result.maxCaptains || 0,
                dedupeKey: `manual_pay_${paymentDocId}_v${(_b = result.subscriptionVersion) !== null && _b !== void 0 ? _b : 1}`,
            });
        }
        return result;
    }
    /**
     * 4. Updates Vodafone Cash & manual subscription packages/settings in Firestore (Master Admin ONLY).
     * - Never hardcodes wallet numbers; validates wallet format, pricing, editable durationDays, features, and instructions.
     * - Protects referenced packages from destructive deletion (requires disabling instead of deleting).
     * - Atomically mirrors packages to `subscription_packages/{planId}` alongside `settings/manual_subscription_config`.
     * @param {CallableAuthContext | undefined} authContext Caller auth context.
     * @param {Record<string, unknown>} data Settings payload.
     * @return {Promise<UpdateSettingsResult>} Saved settings.
     */
    async updateManualSubscriptionSettings(authContext, data) {
        var _a, _b, _c, _d;
        const masterAdmin = await this.requireMasterAdmin(authContext);
        const s = this.effects.sentinels;
        const nowMs = this.effects.now();
        const rawWallet = normalizePhoneDigits((0, validators_js_1.readString)(data, "vodafoneCashNumber", "walletNumber"));
        const walletHolderName = typeof (data === null || data === void 0 ? void 0 : data.walletHolderName) === "string"
            ? data.walletHolderName.trim().slice(0, 120)
            : "";
        const vodafoneCashInstructions = typeof (data === null || data === void 0 ? void 0 : data.vodafoneCashInstructions) === "string"
            ? data.vodafoneCashInstructions.trim().slice(0, 1000)
            : typeof (data === null || data === void 0 ? void 0 : data.instructions) === "string"
                ? data.instructions.trim().slice(0, 1000)
                : typeof (data === null || data === void 0 ? void 0 : data.paymentInstructions) === "string"
                    ? data.paymentInstructions.trim().slice(0, 1000)
                    : "";
        const isAcceptingSubscriptions = (data === null || data === void 0 ? void 0 : data.isAcceptingSubscriptions) !== false;
        const pauseMessage = typeof (data === null || data === void 0 ? void 0 : data.pauseMessage) === "string"
            ? data.pauseMessage.trim().slice(0, 300)
            : "";
        const rawGlobalDuration = (0, validators_js_1.readNumber)(data, "durationDays");
        const durationDays = rawGlobalDuration !== null ? Math.round(rawGlobalDuration) : 30;
        if (isAcceptingSubscriptions) {
            if (!/^01[0125]\d{8}$/.test(rawWallet)) {
                throw new types_js_1.DomainHttpsError("invalid-argument", "رقم محفظة فودافون كاش غير صالح (يجب أن يكون 11 رقماً مصرياً مثل 010xxxxxxxx).");
            }
        }
        else if (rawWallet && !/^01[0125]\d{8}$/.test(rawWallet)) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "صيغة رقم المحفظة غير صالحة.");
        }
        if (durationDays < 1 || durationDays > 365) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "مدة الاشتراك بالأيام يجب أن تكون بين 1 و 365 يوماً.");
        }
        const rawPlans = Array.isArray(data === null || data === void 0 ? void 0 : data.plans) ? data.plans : [];
        if (rawPlans.length === 0) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "يجب تحديد باقة اشتراك واحدة على الأقل.");
        }
        const seenPlanIds = new Set();
        const plans = [];
        for (const item of rawPlans) {
            if (!item || typeof item !== "object")
                continue;
            const obj = item;
            const maxCaptainsRaw = (0, validators_js_1.readNumber)(obj, "maxCaptains", "captainLimit", "captainsCount");
            const priceRaw = (0, validators_js_1.readNumber)(obj, "price");
            const planDurRaw = (0, validators_js_1.readNumber)(obj, "durationDays");
            const maxCaptains = maxCaptainsRaw !== null ? Math.round(maxCaptainsRaw) : 0;
            const price = priceRaw !== null ? Math.round(priceRaw * 100) / 100 : 0;
            const planDurationDays = planDurRaw !== null ? Math.round(planDurRaw) : durationDays;
            const planId = (0, validators_js_1.readString)(obj, "planId", "id") || `plan_${maxCaptains}_captains`;
            const planName = (0, validators_js_1.readString)(obj, "planName", "label", "name") ||
                `باقة ${maxCaptains} كابتن`;
            const features = Array.isArray(obj.features)
                ? obj.features
                    .map((f) => (typeof f === "string" ? f.trim().slice(0, 160) : ""))
                    .filter(Boolean)
                    .slice(0, 12)
                : [];
            if (!isValidDocId(planId) || seenPlanIds.has(planId)) {
                throw new types_js_1.DomainHttpsError("invalid-argument", `معرّف الباقة (${planId}) غير صالح أو مكرر.`);
            }
            if (maxCaptains < 1 || maxCaptains > 100) {
                throw new types_js_1.DomainHttpsError("invalid-argument", `عدد الكباتن في الباقة "${planName}" يجب أن يكون بين 1 و 100.`);
            }
            if (price <= 0 || price > 100000) {
                throw new types_js_1.DomainHttpsError("invalid-argument", `سعر الباقة "${planName}" غير صالح.`);
            }
            if (planDurationDays < 1 || planDurationDays > 365) {
                throw new types_js_1.DomainHttpsError("invalid-argument", `مدة الباقة "${planName}" بالأيام يجب أن تكون بين 1 و 365 يوماً.`);
            }
            seenPlanIds.add(planId);
            plans.push({
                planId,
                planName,
                maxCaptains,
                captainLimit: maxCaptains,
                price,
                durationDays: planDurationDays,
                features,
                isActive: obj.isActive !== false,
                isPopular: obj.isPopular === true,
            });
        }
        if (plans.length === 0) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "قائمة باقات الاشتراك غير صالحة.");
        }
        const expectedVersion = (0, validators_js_1.readNumber)(data, "expectedVersion", "configVersion");
        if (expectedVersion !== null &&
            (!Number.isInteger(expectedVersion) || expectedVersion < 0)) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "رقم إصدار إعدادات الباقات (expectedVersion) غير صالح.");
        }
        const settingsRef = this.db
            .collection("settings")
            .doc("manual_subscription_config");
        // Safe delete check across ALL subscription, history, payment, request, and merchant collections
        const existingSettingsSnap = await settingsRef.get();
        const existingSettingsData = existingSettingsSnap.exists
            ? (_a = existingSettingsSnap.data()) !== null && _a !== void 0 ? _a : {}
            : {};
        const preCheckVersion = (_b = (0, validators_js_1.readNumber)(existingSettingsData, "configVersion")) !== null && _b !== void 0 ? _b : 0;
        if (expectedVersion !== null && expectedVersion !== preCheckVersion) {
            throw new types_js_1.DomainHttpsError("aborted", "تم تعديل إعدادات الباقات من جلسة أخرى أثناء التحرير. يرجى إعادة تحميل الصفحة ثم المحاولة مجدداً.");
        }
        const existingPlans = Array.isArray(existingSettingsData.plans)
            ? existingSettingsData.plans
            : [];
        const preCheckExistingIds = new Set(existingPlans.map((ep) => (0, validators_js_1.readString)(ep, "planId")).filter(Boolean));
        const removedPlans = existingPlans.filter((ep) => {
            const epId = (0, validators_js_1.readString)(ep, "planId");
            return Boolean(epId) && !seenPlanIds.has(epId);
        });
        for (const removed of removedPlans) {
            const removedId = (0, validators_js_1.readString)(removed, "planId");
            const removedName = (0, validators_js_1.readString)(removed, "planName", "name") || removedId;
            const removedCaps = Math.round((_c = (0, validators_js_1.readNumber)(removed, "maxCaptains", "captainsCount")) !== null && _c !== void 0 ? _c : 0);
            const removedLegacyNum = legacyPlanIdForCaptainLimit(removedCaps);
            const anotherPlanSharesLegacyCaps = removedLegacyNum > 0 &&
                plans.some((p) => p.maxCaptains === removedCaps);
            const refChecks = [
                this.db.collection("subscriptions").where("planKey", "==", removedId).limit(1).get(),
                this.db.collection("subscriptions").where("planId", "==", removedId).limit(1).get(),
                this.db.collection("subscriptions").where("packageId", "==", removedId).limit(1).get(),
                this.db.collection("subscription_history").where("planKey", "==", removedId).limit(1).get(),
                this.db.collection("subscription_history").where("planId", "==", removedId).limit(1).get(),
                this.db.collection("subscription_history").where("packageId", "==", removedId).limit(1).get(),
                this.db.collection("payments").where("planId", "==", removedId).limit(1).get(),
                this.db.collection("payments").where("packageId", "==", removedId).limit(1).get(),
                this.db.collection("payments").where("planKey", "==", removedId).limit(1).get(),
                this.db.collection("manual_subscription_requests").where("planId", "==", removedId).limit(1).get(),
                this.db.collection("manual_subscription_requests").where("packageId", "==", removedId).limit(1).get(),
                this.db.collection("manual_subscription_requests").where("planKey", "==", removedId).limit(1).get(),
                this.db.collection("merchants").where("planKey", "==", removedId).limit(1).get(),
                this.db.collection("merchants").where("packageId", "==", removedId).limit(1).get(),
                this.db.collection("merchants").where("planId", "==", removedId).limit(1).get(),
            ];
            if (removedLegacyNum > 0 && !anotherPlanSharesLegacyCaps) {
                refChecks.push(this.db.collection("subscriptions").where("planId", "==", removedLegacyNum).limit(1).get(), this.db.collection("merchants").where("planId", "==", removedLegacyNum).limit(1).get());
            }
            const snaps = await Promise.all(refChecks);
            const isReferenced = snaps.some((snap) => !snap.empty);
            if (isReferenced) {
                throw new types_js_1.DomainHttpsError("failed-precondition", `لا يمكن حذف الباقة "${removedName}" لأنها مرتبطة بسجلات اشتراكات أو مدفوعات أو طلبات سابقة. يرجى إيقافها (تعطيلها) بدلاً من حذفها للحفاظ على سلامة السجلات المالية.`);
            }
        }
        const opLogRef = this.db
            .collection("operation_logs")
            .doc(`update_manual_sub_settings_${nowMs}`);
        const savedSettings = await this.db.runTransaction(async (tx) => {
            var _a, _b, _c;
            const txSettingsSnap = await tx.get(settingsRef);
            const txData = txSettingsSnap.exists ? (_a = txSettingsSnap.data()) !== null && _a !== void 0 ? _a : {} : {};
            const txVersion = (_b = (0, validators_js_1.readNumber)(txData, "configVersion")) !== null && _b !== void 0 ? _b : 0;
            // Optimistic concurrency guard inside the transaction
            if (expectedVersion !== null && expectedVersion !== txVersion) {
                throw new types_js_1.DomainHttpsError("aborted", "تم تعديل إعدادات الباقات من جلسة أخرى أثناء الحفظ. يرجى إعادة تحميل الصفحة ثم المحاولة مجدداً.");
            }
            if (txVersion !== preCheckVersion) {
                throw new types_js_1.DomainHttpsError("aborted", "تعارض متزامن أثناء تحديث إعدادات الباقات. يرجى إعادة المحاولة.");
            }
            // Verify no plan was concurrently inserted after our safe-delete pre-check
            const txExistingPlans = Array.isArray(txData.plans)
                ? txData.plans
                : [];
            for (const ep of txExistingPlans) {
                const epId = (0, validators_js_1.readString)(ep, "planId");
                if (epId && !preCheckExistingIds.has(epId) && !seenPlanIds.has(epId)) {
                    throw new types_js_1.DomainHttpsError("aborted", "تمت إضافة باقة جديدة من جلسة أخرى أثناء التحرير. يرجى تحديث الصفحة قبل الحفظ.");
                }
            }
            const nextVersion = txVersion + 1;
            const settingsPayload = {
                vodafoneCashNumber: rawWallet,
                walletHolderName,
                vodafoneCashInstructions,
                instructions: vodafoneCashInstructions,
                paymentInstructions: vodafoneCashInstructions,
                isAcceptingSubscriptions,
                pauseMessage,
                durationDays,
                configVersion: nextVersion,
                plans,
            };
            tx.set(settingsRef, Object.assign(Object.assign({}, settingsPayload), { updatedBy: masterAdmin.uid, updatedByEmail: masterAdmin.email, updatedByName: masterAdmin.name, updatedAtMs: nowMs, updatedAt: s.serverTimestamp() }), { merge: true });
            // Mirror official packages to subscription_packages/{planId}
            for (const plan of plans) {
                const pkgRef = this.db.collection("subscription_packages").doc(plan.planId);
                tx.set(pkgRef, {
                    id: plan.planId,
                    planId: plan.planId,
                    name: plan.planName,
                    planName: plan.planName,
                    maxCaptains: plan.maxCaptains,
                    captainLimit: plan.maxCaptains,
                    price: plan.price,
                    durationDays: plan.durationDays,
                    features: (_c = plan.features) !== null && _c !== void 0 ? _c : [],
                    isActive: plan.isActive,
                    isPopular: plan.isPopular === true,
                    isDeleted: false,
                    configVersion: nextVersion,
                    updatedBy: masterAdmin.uid,
                    updatedAt: s.serverTimestamp(),
                }, { merge: true });
            }
            // Soft-mark safely deleted unreferenced packages in mirror collection
            for (const removed of removedPlans) {
                const removedId = (0, validators_js_1.readString)(removed, "planId");
                if (!removedId)
                    continue;
                const pkgRef = this.db.collection("subscription_packages").doc(removedId);
                tx.set(pkgRef, {
                    isActive: false,
                    isDeleted: true,
                    configVersion: nextVersion,
                    deletedBy: masterAdmin.uid,
                    deletedAt: s.serverTimestamp(),
                    updatedAt: s.serverTimestamp(),
                }, { merge: true });
            }
            tx.set(opLogRef, {
                action: "update_manual_subscription_settings",
                entityType: "settings",
                settingsDocId: "manual_subscription_config",
                vodafoneCashNumber: rawWallet,
                isAcceptingSubscriptions,
                durationDays,
                configVersion: nextVersion,
                plansCount: plans.length,
                deletedPlansCount: removedPlans.length,
                adminUid: masterAdmin.uid,
                adminEmail: masterAdmin.email,
                adminName: masterAdmin.name,
                createdAt: s.serverTimestamp(),
            });
            return settingsPayload;
        });
        return {
            success: true,
            configVersion: (_d = savedSettings.configVersion) !== null && _d !== void 0 ? _d : 1,
            settings: savedSettings,
            updatedBy: masterAdmin.uid,
            message: "تم حفظ إعدادات الباقات وفودافون كاش بنجاح.",
        };
    }
    /**
     * 5. Trigger handler when a merchant submits a new manual subscription request.
     * Creates a deterministic admin alert notification and dispatches admin FCM tokens if available.
     * @param {string} requestId Newly created request document ID.
     * @param {Record<string, unknown>} reqData Request fields.
     */
    async handleNewManualSubscriptionRequest(requestId, reqData) {
        var _a;
        if (!requestId || !reqData)
            return;
        const s = this.effects.sentinels;
        const merchantId = (0, validators_js_1.readString)(reqData, "merchantId", "restaurantId", "uid");
        const merchantName = (0, validators_js_1.readString)(reqData, "merchantName", "restaurantName") || "تاجر مسجل";
        const planName = (0, validators_js_1.readString)(reqData, "planName", "plan") || "باقة اشتراك";
        const amount = (_a = (0, validators_js_1.readNumber)(reqData, "amount", "price")) !== null && _a !== void 0 ? _a : 0;
        // Use a deterministic document and create it only once. A retried
        // Firestore event must not reset isRead after an admin has opened the alert.
        const notificationRef = this.db
            .collection("notifications")
            .doc(`manual_sub_req_${requestId}`);
        const notificationCreated = await this.db.runTransaction(async (tx) => {
            const existing = await tx.get(notificationRef);
            if (existing.exists)
                return false;
            tx.set(notificationRef, {
                type: "manual_subscription_request",
                targetRole: "admin",
                title: `طلب اشتراك فودافون كاش جديد — ${merchantName}`,
                message: `أرسل التاجر "${merchantName}" إيصال تحويل بمبلغ ${amount} ج.م للباقة "${planName}" بانتظار المراجعة.`,
                body: `أرسل التاجر "${merchantName}" إيصال تحويل بمبلغ ${amount} ج.م للباقة "${planName}" بانتظار المراجعة.`,
                requestId,
                merchantId,
                restaurantName: merchantName,
                planName,
                amount,
                isRead: false,
                createdAt: s.serverTimestamp(),
            });
            return true;
        });
        // The in-app notification is the durable alert. Send its push only for the
        // first successful creation so duplicate event deliveries cannot spam admins.
        if (!notificationCreated)
            return;
        // Collect admin FCM tokens if registered
        const adminTokens = new Set();
        const adminsSnap = await this.db.collection("admins").limit(20).get();
        for (const doc of adminsSnap.docs) {
            const token = (0, validators_js_1.readString)(doc.data(), "fcmToken");
            if (token)
                adminTokens.add(token);
        }
        if (adminTokens.size > 0) {
            await this.effects.sendAdminNewManualRequestNotification({
                requestId,
                merchantId,
                merchantName,
                planName,
                amount,
                tokens: Array.from(adminTokens),
            });
        }
    }
}
exports.ManualSubscriptionsServerService = ManualSubscriptionsServerService;
//# sourceMappingURL=manualSubscriptionsService.js.map