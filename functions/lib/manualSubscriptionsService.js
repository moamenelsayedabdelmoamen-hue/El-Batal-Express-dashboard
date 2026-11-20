"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManualSubscriptionsServerService = void 0;
exports.isSafeMerchantReceipt = isSafeMerchantReceipt;
const types_js_1 = require("./types.js");
const validators_js_1 = require("./validators.js");
const MASTER_ADMIN_EMAILS = new Set([
    "moamen.elsayed.abdelmoamen@gmail.com",
]);
const SUPER_ADMIN_EMAILS = new Set([
    "moamen.elsayed.abdelmoamen@gmail.com",
    "admin@elbatalexpress.com",
]);
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
function formatYmdUtc(ms) {
    return new Date(ms).toISOString().split("T")[0];
}
function normalizeStatus(raw) {
    return typeof raw === "string" ? raw.trim().toLowerCase() : "";
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
            `merchants/${merchantId}/`,
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
            `merchants/${merchantId}/`,
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
     * Verifies that the caller is an authenticated admin via token claims, verified super admin email,
     * or an existing document in `admins/{uid}`.
     * @param {CallableAuthContext | undefined} authContext Callable auth context.
     * @return {Promise<{uid: string, email: string, name: string, isMasterAdmin: boolean}>} Admin info.
     */
    async requireAdmin(authContext) {
        var _a, _b;
        const uid = typeof (authContext === null || authContext === void 0 ? void 0 : authContext.uid) === "string" ? authContext.uid.trim() : "";
        if (!uid) {
            throw new types_js_1.DomainHttpsError("unauthenticated", "يجب تسجيل الدخول بحساب مسؤول معتمد لتنفيذ هذا الإجراء.");
        }
        const token = (_a = authContext === null || authContext === void 0 ? void 0 : authContext.token) !== null && _a !== void 0 ? _a : {};
        const tokenEmail = typeof token.email === "string" ? token.email.trim().toLowerCase() : "";
        const tokenEmailVerified = token.email_verified === true;
        const tokenRole = typeof token.role === "string" ? token.role.trim().toLowerCase() : "";
        const tokenIsAdmin = token.admin === true || tokenRole === "admin";
        const tokenIsMaster = token.isMasterAdmin === true;
        let adminDocData;
        const adminSnap = await this.db.collection("admins").doc(uid).get();
        if (adminSnap.exists) {
            adminDocData = (_b = adminSnap.data()) !== null && _b !== void 0 ? _b : {};
        }
        const docRole = (0, validators_js_1.readString)(adminDocData, "role").toLowerCase();
        const docStatus = (0, validators_js_1.readString)(adminDocData, "status").toLowerCase();
        const isAdminByDoc = Boolean(adminDocData) &&
            (!docRole || docRole === "admin" || docRole === "super_admin") &&
            docStatus !== "suspended" &&
            docStatus !== "disabled";
        const isSuperByEmail = Boolean(tokenEmail) &&
            SUPER_ADMIN_EMAILS.has(tokenEmail) &&
            (tokenEmailVerified || Boolean(adminDocData));
        if (!tokenIsAdmin && !isAdminByDoc && !isSuperByEmail) {
            throw new types_js_1.DomainHttpsError("permission-denied", "غير مصرح لك بتنفيذ هذا الإجراء: يتطلب صلاحية مسؤول إدارة.");
        }
        const isMasterByEmail = Boolean(tokenEmail) &&
            MASTER_ADMIN_EMAILS.has(tokenEmail) &&
            (tokenEmailVerified || Boolean(adminDocData));
        const isMasterByDoc = (adminDocData === null || adminDocData === void 0 ? void 0 : adminDocData.isMasterAdmin) === true || (adminDocData === null || adminDocData === void 0 ? void 0 : adminDocData.isSuperAdmin) === true;
        const name = (0, validators_js_1.readString)(adminDocData, "displayName", "name") ||
            (typeof token.name === "string" && token.name.trim() ? token.name.trim() : "") ||
            tokenEmail ||
            "مسؤول النظام";
        return {
            uid,
            email: tokenEmail || (0, validators_js_1.readString)(adminDocData, "email"),
            name,
            isMasterAdmin: Boolean(tokenIsMaster || isMasterByEmail || isMasterByDoc),
        };
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
        const claimedMerchantId = (0, validators_js_1.readString)(data, "merchantId", "restaurantId");
        if (claimedMerchantId && claimedMerchantId !== uid) {
            throw new types_js_1.DomainHttpsError("permission-denied", "غير مصرح بتقديم طلب اشتراك نيابة عن تاجر آخر.");
        }
        const requestedPlanId = (0, validators_js_1.readString)(data, "planId");
        const requestedNumericPlanId = (0, validators_js_1.readNumber)(data, "planId");
        const requestedMaxCaptains = (_a = (0, validators_js_1.readNumber)(data, "maxCaptains", "captainLimit", "captainsCount")) !== null && _a !== void 0 ? _a : 0;
        const claimedAmount = (0, validators_js_1.readNumber)(data, "amount", "price", "requiredAmount");
        const senderPhone = normalizePhoneDigits((0, validators_js_1.readString)(data, "senderPhone", "fromWalletNumber", "transferPhone"));
        const transactionReference = (0, validators_js_1.readString)(data, "transactionReference", "referenceNumber", "transferReference").slice(0, 120);
        const receiptImagePath = (0, validators_js_1.readString)(data, "receiptImagePath", "receiptPath");
        const receiptImageUrl = (0, validators_js_1.readString)(data, "receiptImageUrl", "receiptUrl");
        const merchantNote = typeof (data === null || data === void 0 ? void 0 : data.merchantNote) === "string"
            ? data.merchantNote.trim().slice(0, 400)
            : "";
        const providedRequestId = (0, validators_js_1.readString)(data, "requestId");
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
            const d = (_b = docSnap.data()) !== null && _b !== void 0 ? _b : {};
            const st = normalizeStatus(d.status);
            if (providedRequestId && docSnap.id === providedRequestId) {
                if (RESUBMISSION_STATUSES.has(st)) {
                    resubmissionTargetDocId = docSnap.id;
                    continue;
                }
                throw new types_js_1.DomainHttpsError("already-exists", "هذا الطلب موجود بالفعل ولا يقبل إعادة الإرسال في حالته الحالية.");
            }
            if (ACTIVE_PENDING_STATUSES.has(st)) {
                throw new types_js_1.DomainHttpsError("already-exists", "لديك طلب اشتراك قيد المراجعة بالفعل. يرجى انتظار مراجعة الإدارة قبل إرسال طلب جديد.");
            }
        }
        if (transactionReference) {
            const dupRefSnap = await this.db
                .collection("manual_subscription_requests")
                .where("transactionReference", "==", transactionReference)
                .limit(5)
                .get();
            for (const dSnap of dupRefSnap.docs) {
                if (resubmissionTargetDocId && dSnap.id === resubmissionTargetDocId) {
                    continue;
                }
                const st = normalizeStatus((_c = dSnap.data()) === null || _c === void 0 ? void 0 : _c.status);
                if (st !== "rejected") {
                    throw new types_js_1.DomainHttpsError("already-exists", "رقم العملية المرجعي مستخدم في طلب اشتراك آخر بالفعل.");
                }
            }
        }
        const requestId = resubmissionTargetDocId || providedRequestId || `subreq_${uid.slice(0, 8)}_${nowMs}`;
        const requestRef = this.db
            .collection("manual_subscription_requests")
            .doc(requestId);
        const merchantRef = this.db.collection("merchants").doc(uid);
        const settingsRef = this.db
            .collection("settings")
            .doc("manual_subscription_config");
        const opLogRef = this.db
            .collection("operation_logs")
            .doc(`submit_manual_sub_${requestId}_${nowMs}`);
        return this.db.runTransaction(async (tx) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
            const [merchantSnap, settingsSnap, existingReqSnap] = await Promise.all([
                tx.get(merchantRef),
                tx.get(settingsRef),
                tx.get(requestRef),
            ]);
            if (!merchantSnap.exists) {
                throw new types_js_1.DomainHttpsError("not-found", "حساب التاجر غير مسجل في النظام.");
            }
            const merchantData = (_a = merchantSnap.data()) !== null && _a !== void 0 ? _a : {};
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
            if (!settingsSnap.exists) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "إعدادات اشتراكات فودافون كاش غير مهيأة حالياً من الإدارة.");
            }
            const settingsData = (_b = settingsSnap.data()) !== null && _b !== void 0 ? _b : {};
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
            const legacyNumericPlanToCaptains = {
                1: 2,
                2: 4,
                3: 6,
                4: 8,
            };
            const numericPlanKey = requestedNumericPlanId !== null
                ? Math.round(requestedNumericPlanId)
                : /^\d+$/.test(requestedPlanId)
                    ? Number(requestedPlanId)
                    : null;
            const legacyMappedCaptains = numericPlanKey !== null ? (_c = legacyNumericPlanToCaptains[numericPlanKey]) !== null && _c !== void 0 ? _c : 0 : 0;
            const matchedPlan = configuredPlans.find((p) => {
                var _a;
                const pId = (0, validators_js_1.readString)(p, "planId");
                const pCap = (_a = (0, validators_js_1.readNumber)(p, "maxCaptains", "captainsCount")) !== null && _a !== void 0 ? _a : 0;
                if (requestedPlanId && pId && pId === requestedPlanId)
                    return true;
                if (legacyMappedCaptains > 0 && pCap === legacyMappedCaptains)
                    return true;
                if (!requestedPlanId && numericPlanKey === null && requestedMaxCaptains > 0) {
                    return pCap === requestedMaxCaptains;
                }
                return false;
            });
            if (!matchedPlan) {
                throw new types_js_1.DomainHttpsError("invalid-argument", "الباقة المختارة غير موجودة ضمن الباقات الرسمية في إعدادات السيرفر.");
            }
            if (matchedPlan.isActive === false) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "هذه الباقة غير متاحة حالياً للاشتراك.");
            }
            const officialPlanId = (0, validators_js_1.readString)(matchedPlan, "planId");
            const officialPlanName = (0, validators_js_1.readString)(matchedPlan, "planName", "label", "name") || officialPlanId;
            const officialMaxCaptains = Math.round((_d = (0, validators_js_1.readNumber)(matchedPlan, "maxCaptains", "captainsCount")) !== null && _d !== void 0 ? _d : 0);
            const officialPrice = (_e = (0, validators_js_1.readNumber)(matchedPlan, "price")) !== null && _e !== void 0 ? _e : 0;
            const planDuration = (0, validators_js_1.readNumber)(matchedPlan, "durationDays");
            const defaultDuration = (_f = (0, validators_js_1.readNumber)(settingsData, "durationDays")) !== null && _f !== void 0 ? _f : 30;
            const officialDurationDays = Math.round(planDuration && planDuration >= 1 && planDuration <= 365
                ? planDuration
                : defaultDuration);
            if (officialMaxCaptains < 1 || officialPrice <= 0) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "إعدادات الباقة الرسمية على السيرفر غير مكتملة.");
            }
            // Reject client price tampering if caller supplied a forged amount
            if (claimedAmount !== null && Math.abs(claimedAmount - officialPrice) > 0.01) {
                throw new types_js_1.DomainHttpsError("invalid-argument", "قيمة الاشتراك المرسلة لا تطابق السعر الرسمي للباقة على السيرفر.");
            }
            // Reject client captainLimit tampering if caller supplied a forged captain limit
            if (requestedMaxCaptains > 0 && requestedMaxCaptains !== officialMaxCaptains) {
                throw new types_js_1.DomainHttpsError("invalid-argument", "عدد الكباتن المرسل لا يطابق الحد الرسمي للباقة على السيرفر.");
            }
            const merchantName = (0, validators_js_1.readString)(merchantData, "name", "merchantName", "restaurantName") ||
                "تاجر مسجل";
            const merchantPhone = (0, validators_js_1.readString)(merchantData, "phone", "phoneNumber");
            const merchantEmail = (0, validators_js_1.readString)(merchantData, "email", "ownerEmail") ||
                (typeof ((_g = authContext === null || authContext === void 0 ? void 0 : authContext.token) === null || _g === void 0 ? void 0 : _g.email) === "string"
                    ? authContext.token.email.trim()
                    : "");
            // Handle resubmission of an existing resubmission_required request
            if (existingReqSnap.exists) {
                const prev = (_h = existingReqSnap.data()) !== null && _h !== void 0 ? _h : {};
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
                tx.set(opLogRef, {
                    action: "resubmit_manual_subscription_request",
                    entityType: "manual_subscription_request",
                    requestId,
                    merchantId: uid,
                    planId: (0, validators_js_1.readString)(prev, "planId") || officialPlanId,
                    amount: (_j = (0, validators_js_1.readNumber)(prev, "amount")) !== null && _j !== void 0 ? _j : officialPrice,
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
                    maxCaptains: (_k = (0, validators_js_1.readNumber)(prev, "maxCaptains")) !== null && _k !== void 0 ? _k : officialMaxCaptains,
                    amount: (_l = (0, validators_js_1.readNumber)(prev, "amount")) !== null && _l !== void 0 ? _l : officialPrice,
                    durationDays: (_m = (0, validators_js_1.readNumber)(prev, "durationDays")) !== null && _m !== void 0 ? _m : officialDurationDays,
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
                planName: officialPlanName,
                maxCaptains: officialMaxCaptains,
                amount: officialPrice,
                durationDays: officialDurationDays,
                senderPhone,
                receiverWalletNumber,
                transactionReference,
                receiptImagePath,
                receiptImageUrl,
                merchantNote,
                status: "pending_review",
                paymentStatus: "pending_verification",
                previousReceipts: [],
                reviewHistory: [submitHistoryEntry],
                submittedAt: s.serverTimestamp(),
                createdAt: s.serverTimestamp(),
                updatedAt: s.serverTimestamp(),
            });
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
            var _a, _b, _c, _d, _e, _f, _g, _h, _j;
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
            const settingsData = settingsSnap.exists ? (_c = settingsSnap.data()) !== null && _c !== void 0 ? _c : {} : {};
            // Resolve official plan from server settings to guarantee authoritative price, captains & duration
            const configuredPlans = Array.isArray(settingsData.plans)
                ? settingsData.plans
                : [];
            const reqPlanId = (0, validators_js_1.readString)(reqData, "planId");
            const reqMaxCaptains = (_d = (0, validators_js_1.readNumber)(reqData, "maxCaptains", "captainLimit", "captainsCount")) !== null && _d !== void 0 ? _d : 0;
            const matchedPlan = configuredPlans.find((p) => {
                var _a;
                const pId = (0, validators_js_1.readString)(p, "planId");
                const pCap = (_a = (0, validators_js_1.readNumber)(p, "maxCaptains", "captainsCount")) !== null && _a !== void 0 ? _a : 0;
                return ((reqPlanId && pId && pId === reqPlanId) ||
                    (reqMaxCaptains > 0 && pCap === reqMaxCaptains));
            });
            if (configuredPlans.length > 0 && !matchedPlan) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "الباقة المطلوبة في الطلب لا تطابق أي باقة رسمية معتمدة في إعدادات النظام.");
            }
            const planDuration = (0, validators_js_1.readNumber)(matchedPlan, "durationDays");
            const configuredDuration = (0, validators_js_1.readNumber)(settingsData, "durationDays");
            const requestDuration = (0, validators_js_1.readNumber)(reqData, "durationDays");
            const durationDays = planDuration && planDuration >= 1 && planDuration <= 365
                ? Math.round(planDuration)
                : configuredDuration && configuredDuration >= 1 && configuredDuration <= 365
                    ? Math.round(configuredDuration)
                    : requestDuration && requestDuration >= 1 && requestDuration <= 365
                        ? Math.round(requestDuration)
                        : 30;
            const maxCaptains = (_e = (0, validators_js_1.readNumber)(matchedPlan, "maxCaptains", "captainsCount")) !== null && _e !== void 0 ? _e : (reqMaxCaptains > 0 ? Math.round(reqMaxCaptains) : 2);
            const planId = (0, validators_js_1.readString)(matchedPlan, "planId") ||
                reqPlanId ||
                `plan_${maxCaptains}_captains`;
            const planName = (0, validators_js_1.readString)(matchedPlan, "planName", "label", "name") ||
                (0, validators_js_1.readString)(reqData, "planName", "plan") ||
                `باقة ${maxCaptains} كابتن`;
            const officialPlanPrice = (0, validators_js_1.readNumber)(matchedPlan, "price");
            const reqAmount = (0, validators_js_1.readNumber)(reqData, "amount", "price", "requiredAmount");
            if (officialPlanPrice !== null &&
                reqAmount !== null &&
                Math.abs(reqAmount - officialPlanPrice) > 0.01) {
                throw new types_js_1.DomainHttpsError("failed-precondition", `المبلغ المسجل في الطلب (${reqAmount}) لا يطابق السعر الرسمي للباقة (${officialPlanPrice}).`);
            }
            const amount = (_f = officialPlanPrice !== null && officialPlanPrice !== void 0 ? officialPlanPrice : reqAmount) !== null && _f !== void 0 ? _f : 0;
            if (amount <= 0) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "قيمة المبلغ المطلوب غير صالحة لإتمام تفعيل الاشتراك.");
            }
            const startDateMs = nowMs;
            const endDateMs = nowMs + durationDays * 24 * 60 * 60 * 1000;
            const startDateYmd = formatYmdUtc(startDateMs);
            const endDateYmd = formatYmdUtc(endDateMs);
            const subData = subSnap.exists ? (_g = subSnap.data()) !== null && _g !== void 0 ? _g : {} : {};
            const prevVersion = Math.max((_h = (0, validators_js_1.readNumber)(subData, "subscriptionVersion")) !== null && _h !== void 0 ? _h : 0, (_j = (0, validators_js_1.readNumber)(merchantData, "subscriptionVersion")) !== null && _j !== void 0 ? _j : 0);
            const nextVersion = prevVersion + 1;
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
                paymentStatus: "paid",
                planId,
                planName,
                maxCaptains,
                amount,
                durationDays,
                receiverWalletNumber,
                approvedBy: admin.uid,
                approvedByEmail: admin.email,
                approvedByName: admin.name,
                approvedAt: s.serverTimestamp(),
                approvedAtMs: nowMs,
                paymentDocId,
                subscriptionStartDate: startDateYmd,
                subscriptionEndDate: endDateYmd,
                subscriptionExpiresAt: endDateMs,
                adminNote,
                reviewHistory: s.arrayUnion(reviewEntry),
                updatedAt: s.serverTimestamp(),
            });
            // 2. Update subscriptions/{merchantId}
            tx.set(subscriptionRef, {
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
                planId,
                planName,
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
                startDate: startDateYmd,
                endDate: endDateYmd,
                startDateMs,
                endDateMs,
                expiresAt: endDateMs,
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
            tx.set(merchantRef, {
                subscriptionStatus: "active",
                isSubscribed: true,
                isActive: true,
                planId,
                planName,
                subscriptionPlan: planName,
                maxCaptains,
                captainLimit: maxCaptains,
                captainsCount: maxCaptains,
                price: amount,
                paymentStatus: "paid",
                subscriptionStartDate: startDateYmd,
                subscriptionEndDate: endDateYmd,
                subscriptionExpiresAt: endDateMs,
                startDate: startDateYmd,
                endDate: endDateYmd,
                expiresAt: endDateMs,
                activatedAt: s.serverTimestamp(),
                suspensionReason: null,
                cancellationReason: null,
                lastApprovedRequestId: requestId,
                lastPaymentId: paymentDocId,
                updatedBy: admin.uid,
                updatedByAdminUid: admin.uid,
                subscriptionVersion: nextVersion,
                subscriptionUpdatedAt: s.serverTimestamp(),
                updatedAt: s.serverTimestamp(),
            }, { merge: true });
            // 4. Create single deterministic financial payment transaction
            tx.set(paymentRef, {
                id: paymentDocId,
                requestId,
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
                planName,
                maxCaptains,
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
            var _a, _b;
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
            const merchantSnap = await tx.get(this.db.collection("merchants").doc(merchantId));
            const merchantData = merchantSnap.exists ? (_b = merchantSnap.data()) !== null && _b !== void 0 ? _b : {} : {};
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
            var _a, _b;
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
            const merchantSnap = await tx.get(this.db.collection("merchants").doc(merchantId));
            const merchantData = merchantSnap.exists ? (_b = merchantSnap.data()) !== null && _b !== void 0 ? _b : {} : {};
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
            tx.update(requestRef, updatePatch);
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
     * 4. Updates Vodafone Cash & manual subscription settings in Firestore (Master Admin ONLY).
     * Never hardcodes wallet numbers; validates wallet format, pricing, and duration.
     * @param {CallableAuthContext | undefined} authContext Caller auth context.
     * @param {Record<string, unknown>} data Settings payload.
     * @return {Promise<UpdateSettingsResult>} Saved settings.
     */
    async updateManualSubscriptionSettings(authContext, data) {
        const masterAdmin = await this.requireMasterAdmin(authContext);
        const s = this.effects.sentinels;
        const nowMs = this.effects.now();
        const rawWallet = normalizePhoneDigits((0, validators_js_1.readString)(data, "vodafoneCashNumber", "walletNumber"));
        const walletHolderName = typeof (data === null || data === void 0 ? void 0 : data.walletHolderName) === "string"
            ? data.walletHolderName.trim().slice(0, 120)
            : "";
        const isAcceptingSubscriptions = (data === null || data === void 0 ? void 0 : data.isAcceptingSubscriptions) !== false;
        const pauseMessage = typeof (data === null || data === void 0 ? void 0 : data.pauseMessage) === "string"
            ? data.pauseMessage.trim().slice(0, 300)
            : "";
        const durationDaysRaw = (0, validators_js_1.readNumber)(data, "durationDays");
        const durationDays = durationDaysRaw !== null ? Math.round(durationDaysRaw) : 30;
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
            const maxCaptainsRaw = (0, validators_js_1.readNumber)(obj, "maxCaptains", "captainsCount");
            const priceRaw = (0, validators_js_1.readNumber)(obj, "price");
            const planDurationRaw = (0, validators_js_1.readNumber)(obj, "durationDays");
            const maxCaptains = maxCaptainsRaw !== null ? Math.round(maxCaptainsRaw) : 0;
            const price = priceRaw !== null ? Math.round(priceRaw * 100) / 100 : 0;
            const planDurationDays = planDurationRaw !== null ? Math.round(planDurationRaw) : durationDays;
            const planId = (0, validators_js_1.readString)(obj, "planId") || `plan_${maxCaptains}_captains`;
            const planName = (0, validators_js_1.readString)(obj, "planName", "label", "name") ||
                `${maxCaptains} كابتن - ${price} جنيه`;
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
                throw new types_js_1.DomainHttpsError("invalid-argument", `مدة الباقة "${planName}" يجب أن تكون بين 1 و 365 يوماً.`);
            }
            seenPlanIds.add(planId);
            plans.push({
                planId,
                planName,
                maxCaptains,
                price,
                durationDays: planDurationDays,
                isActive: obj.isActive !== false,
            });
        }
        if (plans.length === 0) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "قائمة باقات الاشتراك غير صالحة.");
        }
        const settingsPayload = {
            vodafoneCashNumber: rawWallet,
            walletHolderName,
            isAcceptingSubscriptions,
            pauseMessage,
            durationDays,
            plans,
        };
        const settingsRef = this.db
            .collection("settings")
            .doc("manual_subscription_config");
        const opLogRef = this.db
            .collection("operation_logs")
            .doc(`update_manual_sub_settings_${nowMs}`);
        await this.db.runTransaction(async (tx) => {
            tx.set(settingsRef, Object.assign(Object.assign({}, settingsPayload), { updatedBy: masterAdmin.uid, updatedByEmail: masterAdmin.email, updatedByName: masterAdmin.name, updatedAt: s.serverTimestamp() }), { merge: true });
            tx.set(opLogRef, {
                action: "update_manual_subscription_settings",
                entityType: "settings",
                settingsDocId: "manual_subscription_config",
                vodafoneCashNumber: rawWallet,
                isAcceptingSubscriptions,
                durationDays,
                plansCount: plans.length,
                adminUid: masterAdmin.uid,
                adminEmail: masterAdmin.email,
                adminName: masterAdmin.name,
                createdAt: s.serverTimestamp(),
            });
        });
        return {
            success: true,
            settings: settingsPayload,
            updatedBy: masterAdmin.uid,
            message: "تم حفظ إعدادات الاشتراكات وفودافون كاش بنجاح.",
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
        await this.db
            .collection("notifications")
            .doc(`manual_sub_req_${requestId}`)
            .set({
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
        }, { merge: true });
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