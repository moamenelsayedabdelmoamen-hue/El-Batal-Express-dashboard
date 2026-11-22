"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderServerService = exports.EXCLUSION_RESET_MS = exports.OFFER_WINDOW_SECONDS = exports.OFFER_WINDOW_MS = void 0;
exports.isNonEmptyTruthy = isNonEmptyTruthy;
const types_js_1 = require("./types.js");
const shifts_js_1 = require("./shifts.js");
const validators_js_1 = require("./validators.js");
exports.OFFER_WINDOW_MS = 60000;
exports.OFFER_WINDOW_SECONDS = 60;
/**
 * After this long with no captain, captains who let the offer expire or declined it
 * are offered the order again; otherwise a lone captain's missed offer strands it forever.
 */
exports.EXCLUSION_RESET_MS = 3 * 60000;
const ACTIVE_CAPTAIN_FIELDS = [
    "captainId",
    "driverId",
    "assignedCaptainId",
    "captainUid",
];
/**
 * Core server-authoritative service orchestrating El-Batal Express captain
 * assignment, order lifecycle transitions, financial settlement, and 60-second
 * offer timeouts/reassignment.
 */
class OrderServerService {
    /**
     * Constructs an OrderServerService bound to a Firestore-compatible database.
     * @param {DatabaseLike} db Database adapter.
     * @param {ServerEffectsPort} effects Clock, FieldValue sentinels, FCM & Task adapter.
     */
    constructor(db, effects) {
        this.db = db;
        this.effects = effects;
    }
    /**
     * 1. Atomic transactional acceptance of an available or offered delivery order.
     * Rejects unauthenticated, unregistered, suspended, offline, out-of-shift,
     * stale-GPS, already-occupied captains, expired offers, and invalid merchant subscriptions.
     * @param {string | undefined} authUid Authenticated Firebase UID from context.auth.
     * @param {Record<string, unknown>} data Callable payload containing orderId.
     * @return {Promise<AcceptOrderResult>} Acceptance result.
     */
    async acceptOrder(authUid, data) {
        var _a, _b;
        const uid = requireAuthUid(authUid);
        const orderId = (0, validators_js_1.requireValidOrderId)((_a = data === null || data === void 0 ? void 0 : data.orderId) !== null && _a !== void 0 ? _a : data === null || data === void 0 ? void 0 : data.rawOrderId);
        const nowMs = this.effects.now();
        const captainRef = this.db.collection("captains").doc(uid);
        const preCaptainSnap = await captainRef.get();
        if (!preCaptainSnap.exists) {
            throw new types_js_1.DomainHttpsError("permission-denied", "هذا الحساب غير مسجل ككابتن في النظام.");
        }
        const preCaptainData = (_b = preCaptainSnap.data()) !== null && _b !== void 0 ? _b : {};
        (0, validators_js_1.assertCaptainOperationalForOrder)(preCaptainData, nowMs);
        const inShift = await (0, shifts_js_1.isCaptainInActiveShift)(this.db, uid, preCaptainData, nowMs);
        if (!inShift) {
            throw new types_js_1.DomainHttpsError("failed-precondition", "عفواً، أنت خارج ساعات العمل الرسمية (الشفت) ولا يمكنك قبول طلبات حالياً.");
        }
        const orderRef = this.db.collection("orders").doc(orderId);
        const s = this.effects.sentinels;
        return this.db.runTransaction(async (tx) => {
            var _a, _b, _c, _d, _e, _f, _g;
            const [orderSnap, captainSnap, conflictId] = await Promise.all([
                tx.get(orderRef),
                tx.get(captainRef),
                this.findActiveConflictInTx(tx, uid, orderId),
            ]);
            if (!captainSnap.exists) {
                throw new types_js_1.DomainHttpsError("permission-denied", "هذا الحساب غير مسجل ككابتن في النظام.");
            }
            const captainData = (_a = captainSnap.data()) !== null && _a !== void 0 ? _a : {};
            (0, validators_js_1.assertCaptainOperationalForOrder)(captainData, nowMs);
            if (!orderSnap.exists) {
                throw new types_js_1.DomainHttpsError("not-found", "الطلب غير موجود أو تم حذفه.");
            }
            const order = (_b = orderSnap.data()) !== null && _b !== void 0 ? _b : {};
            const status = (0, validators_js_1.readNormalizedOrderStatus)(order) || "pending";
            const assignedUid = (0, validators_js_1.extractOrderCaptainUid)(order);
            const currentOrderId = (0, validators_js_1.readString)(captainData, "currentOrderId");
            if (currentOrderId && currentOrderId !== orderId) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "لديك طلب آخر مرتبط بحسابك، لا يمكن قبول طلب جديد حالياً.");
            }
            const lockedOrderId = (0, validators_js_1.readString)(captainData, "activeOfferOrderId");
            const lockGeneration = Number((_c = captainData.activeOfferGeneration) !== null && _c !== void 0 ? _c : 0) || 0;
            const orderGeneration = Number((_d = order.offerGeneration) !== null && _d !== void 0 ? _d : 0) || 0;
            if (lockedOrderId &&
                (lockedOrderId !== orderId || (lockGeneration > 0 && lockGeneration !== orderGeneration))) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "هذا العرض لم يعد محجوزاً لحسابك أو تم استبداله بعرض أحدث.");
            }
            // Idempotent retry by the same captain who already owns the accepted order
            if (assignedUid === uid &&
                (status === "accepted" || status === "assigned")) {
                return {
                    success: true,
                    alreadyAccepted: true,
                    orderId,
                    status: "accepted",
                    captainId: uid,
                    message: "تم قبول هذا الطلب مسبقاً باسمك.",
                };
            }
            if (assignedUid && assignedUid !== uid) {
                throw new types_js_1.DomainHttpsError("already-exists", "عذراً، تم قبول هذا الطلب بالفعل بواسطة كابتن آخر.");
            }
            if (!(0, validators_js_1.isOrderStatusOpenForAccept)(status)) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "عذراً، هذا الطلب ملغي أو لم يعد متاحاً للقبول.");
            }
            const excludedIds = new Set([
                ...(0, validators_js_1.readStringList)(order.excludedCaptainIds),
                ...(0, validators_js_1.readStringList)(order.timedOutCaptainIds),
            ]);
            if (excludedIds.has(uid)) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "انتهت مهلة قبول هذا الطلب لك وتم تحويله لكابتن آخر.");
            }
            const offeredUid = (0, validators_js_1.readString)(order, "offeredCaptainId");
            const offerExpiresAtMs = (0, validators_js_1.parseTimestampMs)((_e = order.offerExpiresAt) !== null && _e !== void 0 ? _e : order.offer_expires_at);
            if (!offeredUid || offeredUid !== uid) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "هذا الطلب غير معروض حالياً لحسابك.");
            }
            if (offerExpiresAtMs <= 0 || nowMs >= offerExpiresAtMs) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "انتهت مهلة الـ 60 ثانية لقبول هذا الطلب وتم تحويله لكابتن آخر.");
            }
            if (conflictId) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "لديك طلب نشط بالفعل قيد التنفيذ، لا يمكن قبول أكثر من طلب في وقت واحد.");
            }
            // Verify merchant & active subscription inside transaction
            const merchantId = (0, validators_js_1.readString)(order, "merchantId", "restaurantId", "storeId", "vendorId", "ownerId");
            if (!merchantId) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "بيانات التاجر غير مكتملة ولا يمكن قبول الطلب بأمان.");
            }
            {
                const [merchantSnap, restaurantSnap, subSnap] = await Promise.all([
                    tx.get(this.db.collection("merchants").doc(merchantId)),
                    tx.get(this.db.collection("restaurants").doc(merchantId)),
                    tx.get(this.db.collection("subscriptions").doc(merchantId)),
                ]);
                const mData = merchantSnap.exists
                    ? merchantSnap.data()
                    : restaurantSnap.exists
                        ? restaurantSnap.data()
                        : undefined;
                if (!mData || !subSnap.exists) {
                    throw new types_js_1.DomainHttpsError("failed-precondition", "ملف التاجر أو سجل الاشتراك غير موجود؛ لا يمكن قبول الطلب.");
                }
                (0, validators_js_1.assertMerchantAndSubscriptionValid)(merchantId, mData, subSnap.data(), nowMs);
            }
            const captainName = (0, validators_js_1.readString)(captainData, "fullName", "name");
            const captainPhone = (0, validators_js_1.readString)(captainData, "phone", "phoneNumber");
            const createdAtMs = (0, validators_js_1.parseTimestampMs)((_g = (_f = order.createdAt) !== null && _f !== void 0 ? _f : order.created_at) !== null && _g !== void 0 ? _g : order.timestamp);
            const searchSeconds = createdAtMs > 0 && nowMs >= createdAtMs
                ? Math.max(1, Math.round((nowMs - createdAtMs) / 1000))
                : 0;
            const orderUpdate = {
                status: "accepted",
                dispatchStatus: "assigned",
                captainId: uid,
                driverId: uid,
                assignedCaptainId: uid,
                captainUid: uid,
                captainName,
                captainPhone,
                offeredCaptainId: null,
                offerExpiresAt: null,
                eligibleCaptainIds: s.deleteField(),
                acceptedAt: s.serverTimestamp(),
                assignedAt: s.serverTimestamp(),
                updatedAt: s.serverTimestamp(),
            };
            if (searchSeconds > 0) {
                orderUpdate.captainSearchSeconds = searchSeconds;
            }
            tx.update(orderRef, orderUpdate);
            tx.update(captainRef, {
                presenceStatus: "on_trip",
                availabilityStatus: "on_trip",
                currentOrderId: orderId,
                activeMerchantId: merchantId,
                currentMerchantId: merchantId,
                captainPhotoUrl: (0, validators_js_1.readString)(captainData, "profileImageUrl", "photoUrl", "imageUrl", "personalImageUrl"),
                activeOfferOrderId: null,
                activeOfferGeneration: null,
                activeOfferExpiresAt: null,
                updatedAt: s.serverTimestamp(),
            });
            return {
                success: true,
                alreadyAccepted: false,
                orderId,
                status: "accepted",
                captainId: uid,
                message: "تم قبول الطلب بنجاح",
            };
        });
    }
    /**
     * 2. Captain marks arrival at merchant store.
     * @param {string | undefined} authUid Authenticated Firebase UID.
     * @param {Record<string, unknown>} data Callable payload containing orderId.
     * @return {Promise<SimpleLifecycleResult>} Transition result.
     */
    async captainArrivedAtMerchant(authUid, data) {
        var _a;
        const uid = requireAuthUid(authUid);
        const orderId = (0, validators_js_1.requireValidOrderId)((_a = data === null || data === void 0 ? void 0 : data.orderId) !== null && _a !== void 0 ? _a : data === null || data === void 0 ? void 0 : data.rawOrderId);
        const orderRef = this.db.collection("orders").doc(orderId);
        const s = this.effects.sentinels;
        return this.db.runTransaction(async (tx) => {
            var _a;
            const orderSnap = await tx.get(orderRef);
            if (!orderSnap.exists) {
                throw new types_js_1.DomainHttpsError("not-found", "الطلب غير موجود أو تم حذفه.");
            }
            const order = (_a = orderSnap.data()) !== null && _a !== void 0 ? _a : {};
            const assignedUid = (0, validators_js_1.extractOrderCaptainUid)(order);
            if (!assignedUid || assignedUid !== uid) {
                throw new types_js_1.DomainHttpsError("permission-denied", "غير مصرح: هذا الطلب غير مسند إلى حسابك.");
            }
            const status = (0, validators_js_1.readNormalizedOrderStatus)(order);
            if (status === "arrived_at_merchant" ||
                status === "at_store" ||
                status === "arrived" ||
                status === "arrived_store") {
                return {
                    success: true,
                    alreadyUpdated: true,
                    orderId,
                    status: "arrived_at_merchant",
                    message: "تم تسجيل الوصول إلى التاجر مسبقاً.",
                };
            }
            if (status !== "accepted" && status !== "assigned") {
                throw new types_js_1.DomainHttpsError("failed-precondition", "حالة الطلب الحالية لا تسمح بتسجيل الوصول إلى التاجر.");
            }
            tx.update(orderRef, {
                status: "arrived_at_merchant",
                captainId: uid,
                driverId: uid,
                arrivedAtMerchantAt: s.serverTimestamp(),
                arrivedAtStoreTimestamp: s.serverTimestamp(),
                updatedAt: s.serverTimestamp(),
            });
            return {
                success: true,
                alreadyUpdated: false,
                orderId,
                status: "arrived_at_merchant",
                message: "تم تسجيل الوصول إلى التاجر بنجاح",
            };
        });
    }
    /**
     * 3. Captain confirms picking up order from merchant.
     * @param {string | undefined} authUid Authenticated Firebase UID.
     * @param {Record<string, unknown>} data Callable payload containing orderId.
     * @return {Promise<SimpleLifecycleResult>} Transition result.
     */
    async confirmPickup(authUid, data) {
        var _a;
        const uid = requireAuthUid(authUid);
        const orderId = (0, validators_js_1.requireValidOrderId)((_a = data === null || data === void 0 ? void 0 : data.orderId) !== null && _a !== void 0 ? _a : data === null || data === void 0 ? void 0 : data.rawOrderId);
        const orderRef = this.db.collection("orders").doc(orderId);
        const s = this.effects.sentinels;
        return this.db.runTransaction(async (tx) => {
            var _a;
            const orderSnap = await tx.get(orderRef);
            if (!orderSnap.exists) {
                throw new types_js_1.DomainHttpsError("not-found", "الطلب غير موجود أو تم حذفه.");
            }
            const order = (_a = orderSnap.data()) !== null && _a !== void 0 ? _a : {};
            const assignedUid = (0, validators_js_1.extractOrderCaptainUid)(order);
            if (!assignedUid || assignedUid !== uid) {
                throw new types_js_1.DomainHttpsError("permission-denied", "غير مصرح: هذا الطلب غير مسند إلى حسابك.");
            }
            const status = (0, validators_js_1.readNormalizedOrderStatus)(order);
            if (status === "picked_up") {
                return {
                    success: true,
                    alreadyUpdated: true,
                    orderId,
                    status: "picked_up",
                    message: "تم تأكيد استلام الطلب من التاجر مسبقاً.",
                };
            }
            if (status !== "arrived_at_merchant" &&
                status !== "at_store" &&
                status !== "arrived" &&
                status !== "arrived_store") {
                throw new types_js_1.DomainHttpsError("failed-precondition", "يجب تسجيل الوصول إلى التاجر أولاً قبل تأكيد استلام الطلب.");
            }
            tx.update(orderRef, {
                status: "picked_up",
                captainId: uid,
                driverId: uid,
                pickedUpAt: s.serverTimestamp(),
                updatedAt: s.serverTimestamp(),
            });
            return {
                success: true,
                alreadyUpdated: false,
                orderId,
                status: "picked_up",
                message: "تم تأكيد استلام الطلب من التاجر بنجاح",
            };
        });
    }
    /**
     * 4. Captain submits customer details and Storage receipt path for merchant confirmation.
     * @param {string | undefined} authUid Authenticated Firebase UID.
     * @param {Record<string, unknown>} data Customer & receipt fields.
     * @return {Promise<SimpleLifecycleResult>} Submission result.
     */
    async submitCustomerDeliveryDetails(authUid, data) {
        var _a;
        const uid = requireAuthUid(authUid);
        const orderId = (0, validators_js_1.requireValidOrderId)((_a = data === null || data === void 0 ? void 0 : data.orderId) !== null && _a !== void 0 ? _a : data === null || data === void 0 ? void 0 : data.rawOrderId);
        const receiptImagePath = (0, validators_js_1.readString)(data, "receiptImagePath", "receiptImageUrl");
        const customerName = (0, validators_js_1.readString)(data, "customerName");
        const customerPhone = (0, validators_js_1.readString)(data, "customerPhone");
        const notes = typeof (data === null || data === void 0 ? void 0 : data.notes) === "string" ? data.notes.trim() : "";
        const expectedPrefix = `orders/${orderId}/receipts/`;
        if (!receiptImagePath || !receiptImagePath.startsWith(expectedPrefix)) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "مسار صورة الإيصال غير صالح أو لا يطابق مسار الطلب المعتمد.");
        }
        const orderRef = this.db.collection("orders").doc(orderId);
        const s = this.effects.sentinels;
        return this.db.runTransaction(async (tx) => {
            var _a;
            const orderSnap = await tx.get(orderRef);
            if (!orderSnap.exists) {
                throw new types_js_1.DomainHttpsError("not-found", "الطلب غير موجود أو تم حذفه.");
            }
            const order = (_a = orderSnap.data()) !== null && _a !== void 0 ? _a : {};
            const assignedUid = (0, validators_js_1.extractOrderCaptainUid)(order);
            if (!assignedUid || assignedUid !== uid) {
                throw new types_js_1.DomainHttpsError("permission-denied", "غير مصرح: لا يمكنك تعديل بيانات طلب غير مسند إليك.");
            }
            const status = (0, validators_js_1.readNormalizedOrderStatus)(order);
            const allowedStatuses = new Set([
                "picked_up",
                "order_data_entered",
                "data_entered",
                "merchant_rejected",
                "awaiting_merchant_confirmation",
                "awaiting_confirmation",
            ]);
            if (!allowedStatuses.has(status)) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "حالة الطلب الحالية لا تسمح برفع بيانات العميل والإيصال.");
            }
            const updateFields = {
                receiptImagePath,
                receiptImageUrl: receiptImagePath,
                orderImageUrl: receiptImagePath,
                receiptUploadedBy: uid,
                receiptUploadedAt: s.serverTimestamp(),
                receiptSubmittedAt: s.serverTimestamp(),
                notes,
                status: "awaiting_merchant_confirmation",
                merchantConfirmed: false,
                rejectionReason: s.deleteField(),
                updatedAt: s.serverTimestamp(),
            };
            if (customerName)
                updateFields.customerName = customerName;
            if (customerPhone)
                updateFields.customerPhone = customerPhone;
            tx.update(orderRef, updateFields);
            return {
                success: true,
                alreadyUpdated: false,
                orderId,
                status: "awaiting_merchant_confirmation",
                message: "تم إرسال بيانات العميل والإيصال وبانتظار تأكيد التاجر",
            };
        });
    }
    /**
     * 5. Atomic idempotent completion of delivery and server-side financial settlement.
     * Delivery earnings & commissions are calculated strictly from server order/captain fields,
     * never trusting client-submitted amounts. Uses deterministic ledger doc ID `delivery_{orderId}`
     * to guarantee duplicate calls never double-credit walletBalance or daily_wallets.
     * @param {string | undefined} authUid Authenticated Firebase UID.
     * @param {Record<string, unknown>} data Callable payload containing orderId.
     * @return {Promise<ConfirmDeliveryResult>} Financial settlement result.
     */
    async confirmDelivery(authUid, data) {
        var _a;
        const uid = requireAuthUid(authUid);
        const orderId = (0, validators_js_1.requireValidOrderId)((_a = data === null || data === void 0 ? void 0 : data.orderId) !== null && _a !== void 0 ? _a : data === null || data === void 0 ? void 0 : data.rawOrderId);
        const nowMs = this.effects.now();
        const dayKey = (0, shifts_js_1.getCairoTimeContext)(nowMs).dayKey;
        const orderRef = this.db.collection("orders").doc(orderId);
        const captainRef = this.db.collection("captains").doc(uid);
        const txDocRef = captainRef
            .collection("transactions")
            .doc(`delivery_${orderId}`);
        const dailyWalletRef = captainRef.collection("daily_wallets").doc(dayKey);
        const s = this.effects.sentinels;
        return this.db.runTransaction(async (tx) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
            const [orderSnap, captainSnap, existingLedgerSnap] = await Promise.all([
                tx.get(orderRef),
                tx.get(captainRef),
                tx.get(txDocRef),
            ]);
            if (!orderSnap.exists) {
                throw new types_js_1.DomainHttpsError("not-found", "الطلب غير موجود أو تم حذفه.");
            }
            if (!captainSnap.exists) {
                throw new types_js_1.DomainHttpsError("permission-denied", "هذا الحساب غير مسجل ككابتن في النظام.");
            }
            const order = (_a = orderSnap.data()) !== null && _a !== void 0 ? _a : {};
            const captain = (_b = captainSnap.data()) !== null && _b !== void 0 ? _b : {};
            const assignedUid = (0, validators_js_1.extractOrderCaptainUid)(order);
            if (!assignedUid || assignedUid !== uid) {
                throw new types_js_1.DomainHttpsError("permission-denied", "غير مصرح: هذا الطلب غير مسند إلى حسابك.");
            }
            const grossFee = (_c = (0, validators_js_1.readNumber)(order, "deliveryFee", "delivery_fee", "shippingFee", "fee")) !== null && _c !== void 0 ? _c : 0;
            const effectiveStatus = (0, validators_js_1.resolveEffectiveOrderStatus)(order);
            // Idempotency guard: if transaction ledger or delivered status already exists,
            // return recorded values without incrementing balances or counters a second time.
            if (existingLedgerSnap.exists ||
                effectiveStatus === "delivered" ||
                effectiveStatus === "completed" ||
                effectiveStatus === "done") {
                const ledger = (_d = existingLedgerSnap.data()) !== null && _d !== void 0 ? _d : {};
                const recordedAmount = (_f = (_e = (0, validators_js_1.readNumber)(ledger, "amount")) !== null && _e !== void 0 ? _e : (0, validators_js_1.readNumber)(order, "captainEarning")) !== null && _f !== void 0 ? _f : grossFee;
                const recordedGross = (_g = (0, validators_js_1.readNumber)(ledger, "grossDeliveryFee")) !== null && _g !== void 0 ? _g : grossFee;
                const recordedCommission = (_j = (_h = (0, validators_js_1.readNumber)(ledger, "platformCommission")) !== null && _h !== void 0 ? _h : (0, validators_js_1.readNumber)(order, "platformCommission")) !== null && _j !== void 0 ? _j : 0;
                const recordedDay = (0, validators_js_1.readString)(ledger, "dayKey") || dayKey;
                return {
                    success: true,
                    alreadyCompleted: true,
                    orderId,
                    status: "delivered",
                    earnedAmount: recordedAmount,
                    grossDeliveryFee: recordedGross,
                    platformCommission: recordedCommission,
                    dayKey: recordedDay,
                    message: "تم تأكيد تسليم هذا الطلب وتسجيل أرباحه مسبقاً.",
                };
            }
            const isEnRouteState = effectiveStatus === "en_route" ||
                effectiveStatus === "out_for_delivery" ||
                effectiveStatus === "delivering" ||
                effectiveStatus === "on_the_way";
            if (!isEnRouteState) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "لا يمكن تأكيد التسليم قبل اعتماد التاجر لبيانات الإيصال وتحول الطلب إلى حالة التوصيل.");
            }
            if (grossFee <= 0) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "قيمة توصيل الطلب على الخادم غير صالحة لإتمام التسوية المالية.");
            }
            const rawRate = (_k = (0, validators_js_1.readNumber)(captain, "commissionRate")) !== null && _k !== void 0 ? _k : 0;
            const commissionRate = rawRate > 0 && rawRate < 1 ? rawRate : 0;
            const platformCommission = Math.round(grossFee * commissionRate * 100) / 100;
            const earnedAmount = Math.round((grossFee - platformCommission) * 100) / 100;
            const orderNumber = (0, validators_js_1.readString)(order, "orderNumber", "order_number") || orderId;
            const merchantId = (0, validators_js_1.readString)(order, "merchantId", "restaurantId", "storeId");
            tx.update(orderRef, {
                status: "delivered",
                dispatchStatus: "delivered",
                merchantConfirmed: true,
                deliveredAt: s.serverTimestamp(),
                completedAt: s.serverTimestamp(),
                updatedAt: s.serverTimestamp(),
                deliveryFee: grossFee,
                captainEarning: earnedAmount,
                platformCommission,
            });
            tx.set(txDocRef, {
                orderId,
                orderNumber,
                merchantId,
                captainId: uid,
                type: "delivery_earning",
                grossDeliveryFee: grossFee,
                platformCommission,
                amount: earnedAmount,
                currency: "EGP",
                dayKey,
                createdAt: s.serverTimestamp(),
            });
            tx.update(captainRef, {
                walletBalance: s.increment(earnedAmount),
                totalOrdersCount: s.increment(1),
                presenceStatus: "available",
                // The captain app also writes availabilityStatus; dispatch rejects "on_trip" in either field.
                availabilityStatus: "available",
                currentOrderId: null,
                activeMerchantId: s.deleteField(),
                currentMerchantId: s.deleteField(),
                activeOfferOrderId: null,
                activeOfferGeneration: null,
                activeOfferExpiresAt: null,
                updatedAt: s.serverTimestamp(),
            });
            tx.set(dailyWalletRef, {
                dayKey,
                captainId: uid,
                totalEarnings: s.increment(earnedAmount),
                deliveredOrdersCount: s.increment(1),
                updatedAt: s.serverTimestamp(),
            }, { merge: true });
            return {
                success: true,
                alreadyCompleted: false,
                orderId,
                status: "delivered",
                earnedAmount,
                grossDeliveryFee: grossFee,
                platformCommission,
                dayKey,
                message: "تم تأكيد تسليم الطلب وإضافة الأرباح لمحفظتك بنجاح",
            };
        });
    }
    /**
     * 6. Server-verified offer expiry / decline callable.
     * For reason="expired", refuses execution unless server clock confirms now >= offerExpiresAt
     * so client devices cannot manipulate timers or prematurely drop offers.
     * @param {string | undefined} authUid Authenticated Firebase UID.
     * @param {Record<string, unknown>} data Callable payload with orderId & reason.
     * @return {Promise<DispatchOutcome>} Reassignment outcome.
     */
    async expireDeliveryOffer(authUid, data) {
        var _a, _b, _c, _d;
        const uid = requireAuthUid(authUid);
        const orderId = (0, validators_js_1.requireValidOrderId)((_a = data === null || data === void 0 ? void 0 : data.orderId) !== null && _a !== void 0 ? _a : data === null || data === void 0 ? void 0 : data.rawOrderId);
        const reason = (0, validators_js_1.readString)(data, "reason").toLowerCase() || "expired";
        if (reason !== "expired" && reason !== "declined") {
            throw new types_js_1.DomainHttpsError("invalid-argument", "سبب إنهاء العرض غير صالح.");
        }
        const nowMs = this.effects.now();
        const preOrderSnap = await this.db.collection("orders").doc(orderId).get();
        if (!preOrderSnap.exists) {
            return { status: "ignored_stale", orderId };
        }
        const preOrder = (_b = preOrderSnap.data()) !== null && _b !== void 0 ? _b : {};
        const status = (0, validators_js_1.readNormalizedOrderStatus)(preOrder) || "pending";
        const assignedUid = (0, validators_js_1.extractOrderCaptainUid)(preOrder);
        if (assignedUid || !(0, validators_js_1.isOrderStatusOpenForAccept)(status)) {
            return { status: "ignored_stale", orderId };
        }
        const offeredUid = (0, validators_js_1.readString)(preOrder, "offeredCaptainId");
        if (!offeredUid || offeredUid !== uid) {
            return { status: "ignored_stale", orderId };
        }
        const offerExpiresAtMs = (0, validators_js_1.parseTimestampMs)((_c = preOrder.offerExpiresAt) !== null && _c !== void 0 ? _c : preOrder.offer_expires_at);
        if (offerExpiresAtMs <= 0) {
            return { status: "ignored_stale", orderId };
        }
        if (reason !== "declined" && nowMs < offerExpiresAtMs) {
            throw new types_js_1.DomainHttpsError("failed-precondition", "لم تنتهِ مهلة قبول الطلب على الخادم بعد.");
        }
        const expectedGen = Number((_d = preOrder.offerGeneration) !== null && _d !== void 0 ? _d : 0) || 0;
        return this.executeOfferRotation(orderId, uid, expectedGen, reason === "declined" ? "declined" : "expired", false);
    }
    /**
     * 7. Dispatches a newly created or re-queued order to the nearest eligible captain
     * with a server-authored 60-second offer deadline and Cloud Task watchdog.
     * @param {string} orderId Order document ID.
     * @return {Promise<DispatchOutcome>} Dispatch outcome.
     */
    async dispatchNewOrSearchingOrder(orderId, requestedCaptainId) {
        var _a, _b;
        const orderRef = this.db.collection("orders").doc(orderId);
        const preSnap = await orderRef.get();
        if (!preSnap.exists) {
            return { status: "ignored_stale", orderId };
        }
        const preOrder = (_a = preSnap.data()) !== null && _a !== void 0 ? _a : {};
        const nowMs = this.effects.now();
        const status = (0, validators_js_1.readNormalizedOrderStatus)(preOrder) || "pending";
        const assignedUid = (0, validators_js_1.extractOrderCaptainUid)(preOrder);
        if (assignedUid || !(0, validators_js_1.isOrderStatusOpenForAccept)(status)) {
            return { status: "ignored_already_active", orderId };
        }
        const existingOfferedUid = (0, validators_js_1.readString)(preOrder, "offeredCaptainId");
        const existingExpiryMs = (0, validators_js_1.parseTimestampMs)(preOrder.offerExpiresAt);
        if (existingOfferedUid && existingExpiryMs > nowMs) {
            // A prior trigger attempt may have committed the offer but failed while
            // enqueueing its Cloud Task. Re-enqueue the same generation's watchdog.
            // Duplicate tasks are safe because the worker checks captain + generation
            // transactionally before rotating an offer.
            const existingGeneration = Number((_b = preOrder.offerGeneration) !== null && _b !== void 0 ? _b : 0) || 0;
            if (existingGeneration > 0) {
                await this.effects.enqueueReassignTask({
                    orderId,
                    expectedCaptainId: existingOfferedUid,
                    expectedOfferGeneration: existingGeneration,
                }, Math.max(5, Math.ceil((existingExpiryMs - nowMs) / 1000)));
            }
            return {
                status: "ignored_already_active",
                orderId,
                offeredCaptainId: existingOfferedUid,
                offerGeneration: existingGeneration,
                offerExpiresAtMs: existingExpiryMs,
            };
        }
        // Validate merchant & active subscription before searching/offering
        const merchantId = (0, validators_js_1.readString)(preOrder, "merchantId", "restaurantId", "storeId", "vendorId", "ownerId");
        if (!merchantId) {
            throw new types_js_1.DomainHttpsError("failed-precondition", "لا يمكن توزيع الطلب دون معرف تاجر صالح.");
        }
        const [mSnap, rSnap, sSnap] = await Promise.all([
            this.db.collection("merchants").doc(merchantId).get(),
            this.db.collection("restaurants").doc(merchantId).get(),
            this.db.collection("subscriptions").doc(merchantId).get(),
        ]);
        const mData = mSnap.exists
            ? mSnap.data()
            : rSnap.exists
                ? rSnap.data()
                : undefined;
        if (!mData || !sSnap.exists) {
            throw new types_js_1.DomainHttpsError("failed-precondition", "ملف التاجر أو سجل الاشتراك غير موجود؛ لا يمكن توزيع الطلب.");
        }
        (0, validators_js_1.assertMerchantAndSubscriptionValid)(merchantId, mData, sSnap.data(), nowMs);
        const excludedSet = new Set([
            ...(0, validators_js_1.readStringList)(preOrder.excludedCaptainIds),
            ...(0, validators_js_1.readStringList)(preOrder.timedOutCaptainIds),
        ]);
        const allCandidates = await this.findNearestEligibleCaptains(preOrder, excludedSet, nowMs);
        const requestedUid = typeof requestedCaptainId === "string" && requestedCaptainId.trim()
            ? requestedCaptainId.trim()
            : (0, validators_js_1.readString)(preOrder, "requestedCaptainId");
        const candidates = requestedUid
            ? allCandidates.filter((candidate) => candidate.uid === requestedUid)
            : allCandidates;
        const s = this.effects.sentinels;
        let selectedOfferPayload = null;
        let taskPayload = null;
        const outcome = await this.db.runTransaction(async (tx) => {
            var _a, _b, _c, _d, _e, _f;
            const snap = await tx.get(orderRef);
            if (!snap.exists) {
                return { status: "ignored_stale", orderId };
            }
            const latest = (_a = snap.data()) !== null && _a !== void 0 ? _a : {};
            const latestStatus = (0, validators_js_1.readNormalizedOrderStatus)(latest) || "pending";
            if ((0, validators_js_1.extractOrderCaptainUid)(latest) || !(0, validators_js_1.isOrderStatusOpenForAccept)(latestStatus)) {
                return { status: "ignored_already_active", orderId };
            }
            const curOffered = (0, validators_js_1.readString)(latest, "offeredCaptainId");
            const curExpiry = (0, validators_js_1.parseTimestampMs)(latest.offerExpiresAt);
            if (curOffered && curExpiry > nowMs) {
                return { status: "ignored_already_active", orderId };
            }
            let selectedCandidate = null;
            for (const candidate of candidates) {
                const candidateRef = this.db.collection("captains").doc(candidate.uid);
                const candidateSnap = await tx.get(candidateRef);
                if (!candidateSnap.exists)
                    continue;
                const captainData = (_b = candidateSnap.data()) !== null && _b !== void 0 ? _b : {};
                if (!(0, validators_js_1.isCaptainCandidateBaseEligible)(captainData, nowMs))
                    continue;
                const currentOrderId = (0, validators_js_1.readString)(captainData, "currentOrderId");
                if (currentOrderId && currentOrderId !== orderId)
                    continue;
                const activeOfferOrderId = (0, validators_js_1.readString)(captainData, "activeOfferOrderId");
                const activeOfferExpiry = (0, validators_js_1.parseTimestampMs)(captainData.activeOfferExpiresAt);
                if (activeOfferOrderId &&
                    activeOfferOrderId !== orderId &&
                    activeOfferExpiry > nowMs) {
                    continue;
                }
                selectedCandidate = candidate;
                break;
            }
            const previousOfferedUid = curOffered;
            const previousGeneration = Number((_c = latest.offerGeneration) !== null && _c !== void 0 ? _c : 0) || 0;
            let previousCaptainData;
            if (previousOfferedUid && previousOfferedUid !== (selectedCandidate === null || selectedCandidate === void 0 ? void 0 : selectedCandidate.uid)) {
                const previousCaptainSnap = await tx.get(this.db.collection("captains").doc(previousOfferedUid));
                if (previousCaptainSnap.exists)
                    previousCaptainData = previousCaptainSnap.data();
            }
            if (!selectedCandidate) {
                if (previousCaptainData &&
                    (0, validators_js_1.readString)(previousCaptainData, "activeOfferOrderId") === orderId &&
                    Number((_d = previousCaptainData.activeOfferGeneration) !== null && _d !== void 0 ? _d : 0) === previousGeneration) {
                    tx.update(this.db.collection("captains").doc(previousOfferedUid), {
                        activeOfferOrderId: null,
                        activeOfferGeneration: null,
                        activeOfferExpiresAt: null,
                        updatedAt: s.serverTimestamp(),
                    });
                }
                tx.update(orderRef, {
                    status: "searching",
                    dispatchStatus: "no_captains_available",
                    noCaptainsSinceMs: nowMs,
                    offeredCaptainId: null,
                    offeredCaptainName: null,
                    offerExpiresAt: null,
                    eligibleCaptainIds: s.deleteField(),
                    updatedAt: s.serverTimestamp(),
                });
                return { status: "no_captains_available", orderId };
            }
            const nextGen = (Number((_e = latest.offerGeneration) !== null && _e !== void 0 ? _e : 0) || 0) + 1;
            const offerExpiresAtMs = nowMs + exports.OFFER_WINDOW_MS;
            if (previousCaptainData &&
                (0, validators_js_1.readString)(previousCaptainData, "activeOfferOrderId") === orderId &&
                Number((_f = previousCaptainData.activeOfferGeneration) !== null && _f !== void 0 ? _f : 0) === previousGeneration) {
                tx.update(this.db.collection("captains").doc(previousOfferedUid), {
                    activeOfferOrderId: null,
                    activeOfferGeneration: null,
                    activeOfferExpiresAt: null,
                    updatedAt: s.serverTimestamp(),
                });
            }
            tx.update(this.db.collection("captains").doc(selectedCandidate.uid), {
                activeOfferOrderId: orderId,
                activeOfferGeneration: nextGen,
                activeOfferExpiresAt: offerExpiresAtMs,
                updatedAt: s.serverTimestamp(),
            });
            tx.update(orderRef, {
                status: "pending",
                dispatchStatus: "offered",
                offeredCaptainId: selectedCandidate.uid,
                offeredCaptainName: selectedCandidate.name,
                offerSentAt: s.serverTimestamp(),
                offerExpiresAt: offerExpiresAtMs,
                offerGeneration: nextGen,
                eligibleCaptainIds: s.deleteField(),
                requestedCaptainId: s.deleteField(),
                updatedAt: s.serverTimestamp(),
            });
            selectedOfferPayload = this.buildOfferFcmPayload(orderId, latest, selectedCandidate, offerExpiresAtMs, nextGen);
            taskPayload = {
                orderId,
                expectedCaptainId: selectedCandidate.uid,
                expectedOfferGeneration: nextGen,
            };
            return {
                status: "offered",
                orderId,
                offeredCaptainId: selectedCandidate.uid,
                offerGeneration: nextGen,
                offerExpiresAtMs,
            };
        });
        if (outcome.status === "no_captains_available") {
            await this.createAdminNoCaptainNotification(orderId, preOrder, "لا يوجد كباتن متاحون حالياً (متصلين وداخل الشفت وبموقع حديث)");
        }
        else if (selectedOfferPayload && taskPayload) {
            await this.effects.sendOfferNotification(selectedOfferPayload);
            await this.effects.enqueueReassignTask(taskPayload, exports.OFFER_WINDOW_SECONDS);
        }
        return outcome;
    }
    /**
     * 8. Authoritative Cloud Task handler executed 60 seconds after an offer was sent.
     * Exits cleanly if order was already accepted, cancelled, reassigned, or superseded.
     * @param {ReassignTaskPayload} payload Task payload scheduled when offer started.
     * @return {Promise<DispatchOutcome>} Reassignment outcome.
     */
    async handleReassignOfferTask(payload) {
        var _a;
        const orderId = (0, validators_js_1.requireValidOrderId)(payload === null || payload === void 0 ? void 0 : payload.orderId);
        const expectedCaptainId = typeof (payload === null || payload === void 0 ? void 0 : payload.expectedCaptainId) === "string"
            ? payload.expectedCaptainId.trim()
            : "";
        const expectedGen = Number((_a = payload === null || payload === void 0 ? void 0 : payload.expectedOfferGeneration) !== null && _a !== void 0 ? _a : 0) || 0;
        if (!expectedCaptainId) {
            return { status: "ignored_stale", orderId };
        }
        return this.executeOfferRotation(orderId, expectedCaptainId, expectedGen, "expired", true);
    }
    /**
     * Periodic recovery sweep for expired offers if Cloud Tasks enqueueing or execution fails.
     * All reassignments still pass through the same expected-captain/generation transaction.
     * @param {number} limit Maximum number of open orders to scan.
     * @return {Promise<number>} Number of expired offers submitted for idempotent rotation.
     */
    async sweepExpiredOffers(limit = 100) {
        var _a, _b, _c;
        const nowMs = this.effects.now();
        const snap = await this.db
            .collection("orders")
            .where("status", "in", ["pending", "offered"])
            .limit(Math.max(1, Math.min(limit, 200)))
            .get();
        let processed = 0;
        for (const doc of snap.docs) {
            const order = (_a = doc.data()) !== null && _a !== void 0 ? _a : {};
            if ((0, validators_js_1.extractOrderCaptainUid)(order))
                continue;
            const expectedCaptainId = (0, validators_js_1.readString)(order, "offeredCaptainId");
            const offerExpiresAtMs = (0, validators_js_1.parseTimestampMs)((_b = order.offerExpiresAt) !== null && _b !== void 0 ? _b : order.offer_expires_at);
            const expectedOfferGeneration = Number((_c = order.offerGeneration) !== null && _c !== void 0 ? _c : 0) || 0;
            if (!expectedCaptainId ||
                offerExpiresAtMs <= 0 ||
                offerExpiresAtMs > nowMs ||
                expectedOfferGeneration <= 0) {
                continue;
            }
            await this.handleReassignOfferTask({
                orderId: doc.id,
                expectedCaptainId,
                expectedOfferGeneration,
            });
            processed += 1;
        }
        return processed;
    }
    /**
     * Re-dispatches orders stuck in no_captains_available only because every nearby
     * captain already missed or declined them. Once EXCLUSION_RESET_MS has passed,
     * the exclusions are cleared so those captains get a fresh offer.
     * Orders with no exclusions are left to the captain-available triggers.
     * @param {number} limit Maximum number of queued orders to scan.
     * @return {Promise<number>} Number of orders re-dispatched.
     */
    async retryOrdersWithExpiredExclusions(limit = 20) {
        var _a;
        const nowMs = this.effects.now();
        const snap = await this.db
            .collection("orders")
            .where("dispatchStatus", "==", "no_captains_available")
            .limit(Math.max(1, Math.min(limit, 100)))
            .get();
        const s = this.effects.sentinels;
        let retried = 0;
        for (const doc of snap.docs) {
            const order = (_a = doc.data()) !== null && _a !== void 0 ? _a : {};
            if (!isExclusionResetDue(order, nowMs))
                continue;
            const orderRef = this.db.collection("orders").doc(doc.id);
            const reset = await this.db.runTransaction(async (tx) => {
                var _a;
                const latestSnap = await tx.get(orderRef);
                const latest = (_a = latestSnap.data()) !== null && _a !== void 0 ? _a : {};
                if (!latestSnap.exists || !isExclusionResetDue(latest, nowMs))
                    return false;
                tx.update(orderRef, {
                    excludedCaptainIds: [],
                    timedOutCaptainIds: [],
                    exclusionResetCount: s.increment(1),
                    updatedAt: s.serverTimestamp(),
                });
                return true;
            });
            if (!reset)
                continue;
            try {
                await this.dispatchNewOrSearchingOrder(doc.id);
                retried += 1;
            }
            catch (err) {
                // One bad order (e.g. lapsed subscription) must not block the rest of the queue.
                console.warn("Exclusion-reset re-dispatch failed", doc.id, err);
            }
        }
        return retried;
    }
    /**
     * 9. Read-only phone lookup for Captain login/reset flows (eliminates need for client direct query).
     * @param {Record<string, unknown>} data Payload containing phone and optional phone variants.
     * @return {Promise<{found: boolean, email: string | null}>} Email resolution result.
     */
    async resolveCaptainEmailByPhone(data) {
        const rawPhone = (0, validators_js_1.readString)(data, "phone", "phoneNumber");
        const rawVariants = (0, validators_js_1.readStringList)(data === null || data === void 0 ? void 0 : data.variants);
        const candidateStrings = Array.from(new Set([rawPhone, ...rawVariants].filter((v) => v.length > 0))).slice(0, 10);
        if (candidateStrings.length === 0) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "رقم الهاتف مطلوب للبحث عن الحساب.");
        }
        const numericCandidates = Array.from(new Set(candidateStrings
            .map((s) => s.replace(/\D/g, ""))
            .flatMap((digits) => {
            const vals = [digits, digits.replace(/^0+/, ""), digits.replace(/^20/, "")];
            return vals
                .map((v) => Number(v))
                .filter((n) => Number.isSafeInteger(n) && n > 0);
        }))).slice(0, 10);
        const searchFields = ["phone", "phoneNumber", "mobile", "phone_number"];
        for (const field of searchFields) {
            const strSnap = await this.db
                .collection("captains")
                .where(field, "in", candidateStrings)
                .limit(5)
                .get();
            for (const doc of strSnap.docs) {
                const d = doc.data();
                if ((0, validators_js_1.isEligibleCaptainIdentity)(d)) {
                    const email = (0, validators_js_1.readString)(d, "email");
                    if (email.includes("@")) {
                        return { found: true, email };
                    }
                }
            }
            if (numericCandidates.length > 0) {
                const numSnap = await this.db
                    .collection("captains")
                    .where(field, "in", numericCandidates)
                    .limit(5)
                    .get();
                for (const doc of numSnap.docs) {
                    const d = doc.data();
                    if ((0, validators_js_1.isEligibleCaptainIdentity)(d)) {
                        const email = (0, validators_js_1.readString)(d, "email");
                        if (email.includes("@")) {
                            return { found: true, email };
                        }
                    }
                }
            }
        }
        return { found: false, email: null };
    }
    async executeOfferRotation(orderId, timedOutCaptainId, expectedOfferGeneration, rotationReason, enforceOfferGenerationMatch) {
        var _a;
        const orderRef = this.db.collection("orders").doc(orderId);
        const preSnap = await orderRef.get();
        if (!preSnap.exists) {
            return { status: "ignored_stale", orderId };
        }
        const preOrder = (_a = preSnap.data()) !== null && _a !== void 0 ? _a : {};
        const nowMs = this.effects.now();
        const preStatus = (0, validators_js_1.readNormalizedOrderStatus)(preOrder) || "pending";
        if ((0, validators_js_1.extractOrderCaptainUid)(preOrder) ||
            !(0, validators_js_1.isOrderStatusOpenForAccept)(preStatus)) {
            return { status: "ignored_stale", orderId };
        }
        const excludedSet = new Set([
            ...(0, validators_js_1.readStringList)(preOrder.excludedCaptainIds),
            ...(0, validators_js_1.readStringList)(preOrder.timedOutCaptainIds),
            timedOutCaptainId,
        ]);
        const candidates = await this.findNearestEligibleCaptains(preOrder, excludedSet, nowMs);
        const s = this.effects.sentinels;
        let offerFcm = null;
        let nextTask = null;
        let rescheduleRemainingSec = null;
        const outcome = await this.db.runTransaction(async (tx) => {
            var _a, _b, _c, _d, _e, _f, _g;
            const snap = await tx.get(orderRef);
            if (!snap.exists) {
                return { status: "ignored_stale", orderId };
            }
            const latest = (_a = snap.data()) !== null && _a !== void 0 ? _a : {};
            const status = (0, validators_js_1.readNormalizedOrderStatus)(latest) || "pending";
            const assignedUid = (0, validators_js_1.extractOrderCaptainUid)(latest);
            // Ignore stale task if order was already accepted, cancelled, or delivered
            if (assignedUid || !(0, validators_js_1.isOrderStatusOpenForAccept)(status)) {
                return { status: "ignored_stale", orderId };
            }
            const currentOffered = (0, validators_js_1.readString)(latest, "offeredCaptainId");
            const currentGen = Number((_b = latest.offerGeneration) !== null && _b !== void 0 ? _b : 0) || 0;
            if (currentOffered !== timedOutCaptainId) {
                return { status: "ignored_stale", orderId };
            }
            if (enforceOfferGenerationMatch && currentGen !== expectedOfferGeneration) {
                return { status: "ignored_stale", orderId };
            }
            const currentExpiryMs = (0, validators_js_1.parseTimestampMs)((_c = latest.offerExpiresAt) !== null && _c !== void 0 ? _c : latest.offer_expires_at);
            if (rotationReason === "expired" && currentExpiryMs <= 0) {
                return { status: "ignored_stale", orderId };
            }
            if (rotationReason === "expired" &&
                currentExpiryMs > nowMs) {
                rescheduleRemainingSec = Math.max(2, Math.ceil((currentExpiryMs - nowMs) / 1000));
                return { status: "rescheduled_early", orderId };
            }
            const oldCaptainRef = this.db.collection("captains").doc(timedOutCaptainId);
            const oldCaptainSnap = await tx.get(oldCaptainRef);
            const oldCaptainData = oldCaptainSnap.exists ? (_d = oldCaptainSnap.data()) !== null && _d !== void 0 ? _d : {} : {};
            const oldLockMatches = (0, validators_js_1.readString)(oldCaptainData, "activeOfferOrderId") === orderId &&
                Number((_e = oldCaptainData.activeOfferGeneration) !== null && _e !== void 0 ? _e : 0) === currentGen;
            let reservedNextCandidate = null;
            for (const candidate of candidates) {
                const candidateRef = this.db.collection("captains").doc(candidate.uid);
                const candidateSnap = await tx.get(candidateRef);
                if (!candidateSnap.exists)
                    continue;
                const captainData = (_f = candidateSnap.data()) !== null && _f !== void 0 ? _f : {};
                if (!(0, validators_js_1.isCaptainCandidateBaseEligible)(captainData, nowMs))
                    continue;
                const currentOrderId = (0, validators_js_1.readString)(captainData, "currentOrderId");
                if (currentOrderId && currentOrderId !== orderId)
                    continue;
                const activeOfferOrderId = (0, validators_js_1.readString)(captainData, "activeOfferOrderId");
                const activeOfferExpiry = (0, validators_js_1.parseTimestampMs)(captainData.activeOfferExpiresAt);
                if (activeOfferOrderId &&
                    activeOfferOrderId !== orderId &&
                    activeOfferExpiry > nowMs) {
                    continue;
                }
                reservedNextCandidate = candidate;
                break;
            }
            if (!reservedNextCandidate) {
                if (oldLockMatches) {
                    tx.update(oldCaptainRef, {
                        activeOfferOrderId: null,
                        activeOfferGeneration: null,
                        activeOfferExpiresAt: null,
                        updatedAt: s.serverTimestamp(),
                    });
                }
                tx.update(orderRef, {
                    status: "searching",
                    dispatchStatus: "no_captains_available",
                    noCaptainsSinceMs: nowMs,
                    offeredCaptainId: null,
                    offeredCaptainName: null,
                    offerExpiresAt: null,
                    eligibleCaptainIds: s.deleteField(),
                    excludedCaptainIds: s.arrayUnion(timedOutCaptainId),
                    timedOutCaptainIds: rotationReason === "expired"
                        ? s.arrayUnion(timedOutCaptainId)
                        : (_g = latest.timedOutCaptainIds) !== null && _g !== void 0 ? _g : [],
                    updatedAt: s.serverTimestamp(),
                });
                return { status: "no_captains_available", orderId };
            }
            const nextGen = currentGen + 1;
            const offerExpiresAtMs = nowMs + exports.OFFER_WINDOW_MS;
            if (oldLockMatches) {
                tx.update(oldCaptainRef, {
                    activeOfferOrderId: null,
                    activeOfferGeneration: null,
                    activeOfferExpiresAt: null,
                    updatedAt: s.serverTimestamp(),
                });
            }
            tx.update(this.db.collection("captains").doc(reservedNextCandidate.uid), {
                activeOfferOrderId: orderId,
                activeOfferGeneration: nextGen,
                activeOfferExpiresAt: offerExpiresAtMs,
                updatedAt: s.serverTimestamp(),
            });
            const updateFields = {
                status: "pending",
                dispatchStatus: "offered",
                offeredCaptainId: reservedNextCandidate.uid,
                offeredCaptainName: reservedNextCandidate.name,
                offerSentAt: s.serverTimestamp(),
                offerExpiresAt: offerExpiresAtMs,
                offerGeneration: nextGen,
                eligibleCaptainIds: s.deleteField(),
                excludedCaptainIds: s.arrayUnion(timedOutCaptainId),
                updatedAt: s.serverTimestamp(),
            };
            if (rotationReason === "expired") {
                updateFields.timedOutCaptainIds = s.arrayUnion(timedOutCaptainId);
            }
            tx.update(orderRef, updateFields);
            offerFcm = this.buildOfferFcmPayload(orderId, latest, reservedNextCandidate, offerExpiresAtMs, nextGen);
            nextTask = {
                orderId,
                expectedCaptainId: reservedNextCandidate.uid,
                expectedOfferGeneration: nextGen,
            };
            return {
                status: "reassigned",
                orderId,
                offeredCaptainId: reservedNextCandidate.uid,
                offerGeneration: nextGen,
                offerExpiresAtMs,
            };
        });
        if (outcome.status === "rescheduled_early" && rescheduleRemainingSec) {
            await this.effects.enqueueReassignTask({
                orderId,
                expectedCaptainId: timedOutCaptainId,
                expectedOfferGeneration,
            }, rescheduleRemainingSec);
            return outcome;
        }
        if (outcome.status === "no_captains_available") {
            await this.createAdminNoCaptainNotification(orderId, preOrder, "انتهت مهلة قبول الطلب لجميع الكباتن المتاحين ولم يتم قبوله");
        }
        else if (offerFcm && nextTask) {
            await this.effects.sendOfferNotification(offerFcm);
            await this.effects.enqueueReassignTask(nextTask, exports.OFFER_WINDOW_SECONDS);
        }
        return outcome;
    }
    async findNearestEligibleCaptains(orderData, excludedIds, nowMs) {
        var _a;
        const onlineSnap = await this.db
            .collection("captains")
            .where("isOnline", "==", true)
            .limit(100)
            .get();
        const origin = await this.resolvePickupCoordinates(orderData);
        if (!origin)
            return [];
        const eligible = [];
        for (const doc of onlineSnap.docs) {
            const uid = doc.id;
            if (excludedIds.has(uid))
                continue;
            const data = (_a = doc.data()) !== null && _a !== void 0 ? _a : {};
            if (!(0, validators_js_1.isCaptainCandidateBaseEligible)(data, nowMs))
                continue;
            const inShift = await (0, shifts_js_1.isCaptainInActiveShift)(this.db, uid, data, nowMs);
            if (!inShift)
                continue;
            const activeOrderId = (0, validators_js_1.readString)(data, "currentOrderId");
            if (activeOrderId)
                continue;
            const activeOfferOrderId = (0, validators_js_1.readString)(data, "activeOfferOrderId");
            const activeOfferExpiry = (0, validators_js_1.parseTimestampMs)(data.activeOfferExpiresAt);
            if (activeOfferOrderId && activeOfferExpiry > nowMs)
                continue;
            const hasConflict = await this.hasActiveConflictOutsideTx(uid);
            if (hasConflict)
                continue;
            const coords = (0, validators_js_1.extractCoordinates)(data);
            if (!coords)
                continue;
            const distanceKm = (0, validators_js_1.haversineDistanceKm)(origin.lat, origin.lng, coords.lat, coords.lng);
            eligible.push({
                uid,
                name: (0, validators_js_1.readString)(data, "fullName", "name") || "كابتن",
                phone: (0, validators_js_1.readString)(data, "phone", "phoneNumber"),
                fcmToken: (0, validators_js_1.readString)(data, "fcmToken"),
                lat: coords.lat,
                lng: coords.lng,
                distanceKm: Math.round(distanceKm * 100) / 100,
            });
        }
        eligible.sort((a, b) => a.distanceKm - b.distanceKm);
        return eligible;
    }
    async resolvePickupCoordinates(orderData) {
        var _a;
        const direct = (0, validators_js_1.extractCoordinates)(orderData);
        if (direct)
            return direct;
        const merchantId = (0, validators_js_1.readString)(orderData, "merchantId", "restaurantId", "storeId", "vendorId", "ownerId");
        if (!merchantId)
            return null;
        for (const collectionName of ["merchants", "restaurants"]) {
            const snap = await this.db.collection(collectionName).doc(merchantId).get();
            if (!snap.exists)
                continue;
            const merchantData = (_a = snap.data()) !== null && _a !== void 0 ? _a : {};
            const coords = (0, validators_js_1.extractCoordinates)(merchantData);
            if (coords)
                return coords;
        }
        return null;
    }
    async hasActiveConflictOutsideTx(captainUid) {
        var _a;
        for (const field of ACTIVE_CAPTAIN_FIELDS) {
            const snap = await this.db
                .collection("orders")
                .where(field, "==", captainUid)
                .limit(10)
                .get();
            for (const doc of snap.docs) {
                const status = (0, validators_js_1.resolveEffectiveOrderStatus)((_a = doc.data()) !== null && _a !== void 0 ? _a : {});
                if ((0, validators_js_1.isOrderStatusBlockingActiveTrip)(status)) {
                    return true;
                }
            }
        }
        return false;
    }
    async findActiveConflictInTx(tx, captainUid, targetOrderId) {
        var _a;
        for (const field of ACTIVE_CAPTAIN_FIELDS) {
            const q = this.db
                .collection("orders")
                .where(field, "==", captainUid)
                .limit(10);
            const snap = await tx.getQuery(q);
            for (const doc of snap.docs) {
                if (doc.id === targetOrderId)
                    continue;
                const status = (0, validators_js_1.resolveEffectiveOrderStatus)((_a = doc.data()) !== null && _a !== void 0 ? _a : {});
                if ((0, validators_js_1.isOrderStatusBlockingActiveTrip)(status)) {
                    return doc.id;
                }
            }
        }
        return null;
    }
    buildOfferFcmPayload(orderId, order, candidate, offerExpiresAtMs, offerGeneration) {
        var _a, _b;
        const itemsArr = Array.isArray(order.items) ? order.items : [];
        const itemsSummary = (0, validators_js_1.readString)(order, "itemsSummary", "description") || "طلب توصيل جديد";
        const merchantId = (0, validators_js_1.readString)(order, "merchantId", "restaurantId", "storeId");
        const storeName = (0, validators_js_1.readString)(order, "storeName", "restaurantName", "merchantName", "vendorName");
        const storePhone = (0, validators_js_1.readString)(order, "storePhone", "merchantPhone");
        const storeImage = (0, validators_js_1.readString)(order, "storeImage", "merchantLogo", "storeLogo");
        const storeImagePath = (0, validators_js_1.readString)(order, "storeImagePath", "merchantStoragePath");
        const deliveryFee = (0, validators_js_1.readNumber)(order, "deliveryFee", "delivery_fee", "shippingFee");
        if (!merchantId || !storeName || !storePhone || (!storeImage && !storeImagePath)) {
            throw new types_js_1.DomainHttpsError("failed-precondition", "بيانات اسم التاجر أو هاتفه أو صورته غير مكتملة؛ تم إيقاف إرسال العرض.");
        }
        if (deliveryFee === null || deliveryFee < 0) {
            throw new types_js_1.DomainHttpsError("failed-precondition", "لم يتم تسجيل أجرة التوصيل من تطبيق التاجر؛ لن يتم إرسال عرض بقيمة افتراضية.");
        }
        return {
            captainUid: candidate.uid,
            fcmToken: candidate.fcmToken,
            orderId,
            orderNumber: (0, validators_js_1.readString)(order, "orderNumber", "order_number") || orderId,
            orderCode: (0, validators_js_1.readString)(order, "orderCode", "order_code"),
            merchantId,
            storeName,
            storePhone,
            storeImage,
            storeImagePath,
            storeLocationUrl: (0, validators_js_1.readString)(order, "storeLocationUrl", "locationUrl"),
            pickupAddress: (0, validators_js_1.readString)(order, "pickupAddress", "storeAddress", "merchantAddress") ||
                "موقع التاجر",
            deliveryAddress: (0, validators_js_1.readString)(order, "deliveryAddress", "customerAddress", "dropoffAddress") || "عنوان العميل",
            deliveryFee,
            distanceKm: candidate.distanceKm,
            offerExpiresAtMs,
            itemsSummary,
            itemsCount: (_a = (0, validators_js_1.readNumber)(order, "itemsCount")) !== null && _a !== void 0 ? _a : (itemsArr.length > 0 ? itemsArr.length : 1),
            orderTotalAmount: (_b = (0, validators_js_1.readNumber)(order, "orderTotalAmount", "totalAmount", "total")) !== null && _b !== void 0 ? _b : 0.0,
            customerName: (0, validators_js_1.readString)(order, "customerName") || "عميل البطل",
            customerPhone: (0, validators_js_1.readString)(order, "customerPhone"),
            offerGeneration,
        };
    }
    async createAdminNoCaptainNotification(orderId, order, reason) {
        const orderNumber = (0, validators_js_1.readString)(order, "orderNumber", "order_number") || orderId;
        const restaurantName = (0, validators_js_1.readString)(order, "merchantName", "restaurantName", "storeName") ||
            "مطعم غير محدد";
        const s = this.effects.sentinels;
        // Stable notification ID makes duplicate Firestore event delivery harmless
        // and avoids producing several admin alerts for the same unresolved order.
        const notificationRef = this.db.collection("notifications")
            .doc(`captain_assignment_failed_${orderId}`);
        await this.db.runTransaction(async (tx) => {
            const existing = await tx.get(notificationRef);
            if (existing.exists)
                return;
            tx.set(notificationRef, {
                type: "captain_assignment_failed",
                targetRole: "admin",
                title: `تعذر تعيين كابتن للطلب #${orderNumber}`,
                message: `${reason} — ${restaurantName}`,
                orderId,
                orderNumber,
                restaurantName,
                reason,
                isRead: false,
                createdAt: s.serverTimestamp(),
            });
        });
    }
}
exports.OrderServerService = OrderServerService;
/**
 * True when an order has waited EXCLUSION_RESET_MS with no captain and has
 * excluded captains that could be offered it again.
 * @param {Record<string, unknown>} order Order document data.
 * @param {number} nowMs Current time in milliseconds.
 * @return {boolean} Whether the exclusions should be cleared and the order re-dispatched.
 */
function isExclusionResetDue(order, nowMs) {
    var _a, _b;
    if (String((_a = order.dispatchStatus) !== null && _a !== void 0 ? _a : "").toLowerCase() !== "no_captains_available")
        return false;
    if (order.dispatchAuthority !== "dashboard_functions")
        return false;
    if (!["pending", "searching"].includes((0, validators_js_1.readNormalizedOrderStatus)(order)))
        return false;
    if ((0, validators_js_1.extractOrderCaptainUid)(order))
        return false;
    const excluded = [
        ...(0, validators_js_1.readStringList)(order.excludedCaptainIds),
        ...(0, validators_js_1.readStringList)(order.timedOutCaptainIds),
    ];
    if (excluded.length === 0)
        return false;
    const sinceMs = Number((_b = order.noCaptainsSinceMs) !== null && _b !== void 0 ? _b : 0) || (0, validators_js_1.parseTimestampMs)(order.updatedAt);
    return sinceMs > 0 && nowMs - sinceMs >= exports.EXCLUSION_RESET_MS;
}
function requireAuthUid(authUid) {
    const uid = typeof authUid === "string" ? authUid.trim() : "";
    if (!uid) {
        throw new types_js_1.DomainHttpsError("unauthenticated", "يجب تسجيل الدخول أولاً لتنفيذ هذه العملية.");
    }
    return uid;
}
function isNonEmptyTruthy(v) {
    return (0, validators_js_1.isTruthyFlag)(v);
}
//# sourceMappingURL=ordersService.js.map