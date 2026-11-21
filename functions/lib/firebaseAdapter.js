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
exports.createAdminDatabaseAdapter = createAdminDatabaseAdapter;
exports.createAdminServerEffects = createAdminServerEffects;
exports.createAdminManualSubscriptionEffects = createAdminManualSubscriptionEffects;
const firestore_1 = require("firebase-admin/firestore");
const functions_1 = require("firebase-admin/functions");
const messaging_1 = require("firebase-admin/messaging");
const storage_1 = require("firebase-admin/storage");
const logger = __importStar(require("firebase-functions/logger"));
function wrapDocRef(ref) {
    return {
        get id() {
            return ref.id;
        },
        get path() {
            return ref.path;
        },
        collection(collectionPath) {
            return wrapCollectionRef(ref.collection(collectionPath));
        },
        async get() {
            const snap = await ref.get();
            return {
                id: snap.id,
                exists: snap.exists,
                ref: wrapDocRef(snap.ref),
                data: () => snap.data(),
            };
        },
        async set(data, options) {
            await ref.set(data, options ? { merge: Boolean(options.merge) } : {});
        },
        async update(data) {
            await ref.update(data);
        },
    };
}
function wrapQuery(q) {
    const wrapper = {
        __rawQuery: q,
        where(fieldPath, opStr, value) {
            return wrapQuery(q.where(fieldPath, opStr, value));
        },
        limit(limitCount) {
            return wrapQuery(q.limit(limitCount));
        },
        async get() {
            const snap = await q.get();
            return {
                empty: snap.empty,
                size: snap.size,
                docs: snap.docs.map((d) => ({
                    id: d.id,
                    exists: d.exists,
                    ref: wrapDocRef(d.ref),
                    data: () => d.data(),
                })),
            };
        },
    };
    return wrapper;
}
function wrapCollectionRef(col) {
    const baseQuery = wrapQuery(col);
    return Object.assign(Object.assign({}, baseQuery), { doc(docId) {
            return wrapDocRef(docId ? col.doc(docId) : col.doc());
        },
        async add(data) {
            const added = await col.add(data);
            return wrapDocRef(added);
        } });
}
function unwrapDocRef(ref, firestore) {
    return firestore.doc(ref.path);
}
/**
 * Wraps the real Firebase Admin Firestore instance in the DatabaseLike interface.
 * @param {Firestore} firestore Admin SDK Firestore instance.
 * @return {DatabaseLike} DatabaseLike adapter.
 */
function createAdminDatabaseAdapter(firestore) {
    return {
        collection(collectionPath) {
            return wrapCollectionRef(firestore.collection(collectionPath));
        },
        async runTransaction(fn) {
            return firestore.runTransaction(async (adminTx) => {
                const txAdapter = {
                    async get(ref) {
                        const adminRef = unwrapDocRef(ref, firestore);
                        const snap = await adminTx.get(adminRef);
                        return {
                            id: snap.id,
                            exists: snap.exists,
                            ref: wrapDocRef(snap.ref),
                            data: () => snap.data(),
                        };
                    },
                    async getQuery(q) {
                        // Execute underlying query via tx by re-building on original Query not exposed;
                        // keep safe cast through internal symbol or fallback query execution.
                        const adminQuery = q.__rawQuery;
                        const snap = adminQuery ? await adminTx.get(adminQuery) : null;
                        if (snap) {
                            return {
                                empty: snap.empty,
                                size: snap.size,
                                docs: snap.docs.map((d) => ({
                                    id: d.id,
                                    exists: d.exists,
                                    ref: wrapDocRef(d.ref),
                                    data: () => d.data(),
                                })),
                            };
                        }
                        return q.get();
                    },
                    set(ref, data, options) {
                        const adminRef = unwrapDocRef(ref, firestore);
                        adminTx.set(adminRef, data, options ? { merge: Boolean(options.merge) } : {});
                    },
                    update(ref, data) {
                        const adminRef = unwrapDocRef(ref, firestore);
                        adminTx.update(adminRef, data);
                    },
                };
                return fn(txAdapter);
            });
        },
    };
}
/**
 * Production ServerEffectsPort backed by Admin FieldValue, FCM, and Cloud Tasks.
 * @return {ServerEffectsPort} Production effects implementation.
 */
function createAdminServerEffects() {
    return {
        now: () => Date.now(),
        sentinels: {
            serverTimestamp: () => firestore_1.FieldValue.serverTimestamp(),
            deleteField: () => firestore_1.FieldValue.delete(),
            increment: (value) => firestore_1.FieldValue.increment(value),
            arrayUnion: (...elements) => firestore_1.FieldValue.arrayUnion(...elements),
        },
        async sendOfferNotification(payload) {
            if (!payload.fcmToken) {
                logger.info("Skipping FCM push: captain lacks fcmToken", {
                    captainUid: payload.captainUid,
                    orderId: payload.orderId,
                });
                return;
            }
            try {
                await (0, messaging_1.getMessaging)().send({
                    token: payload.fcmToken,
                    android: {
                        priority: "high",
                        ttl: 60 * 1000,
                    },
                    data: {
                        type: "new_order",
                        orderId: payload.orderId,
                        orderNumber: payload.orderNumber,
                        orderCode: payload.orderCode,
                        merchantId: payload.merchantId,
                        storeName: payload.storeName,
                        storePhone: payload.storePhone,
                        storeImage: payload.storeImage,
                        storeImagePath: payload.storeImagePath,
                        storeLocationUrl: payload.storeLocationUrl,
                        pickupAddress: payload.pickupAddress,
                        deliveryAddress: payload.deliveryAddress,
                        deliveryFee: String(payload.deliveryFee),
                        distanceKm: String(payload.distanceKm),
                        offerExpiresAt: String(payload.offerExpiresAtMs),
                        itemsSummary: payload.itemsSummary,
                        itemsCount: String(payload.itemsCount),
                        orderTotalAmount: String(payload.orderTotalAmount),
                        customerName: payload.customerName,
                        customerPhone: payload.customerPhone,
                        offerGeneration: String(payload.offerGeneration),
                    },
                });
            }
            catch (err) {
                logger.warn("Failed to send offer FCM push to captain", {
                    captainUid: payload.captainUid,
                    orderId: payload.orderId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        },
        async enqueueReassignTask(payload, delaySeconds) {
            try {
                const queue = (0, functions_1.getFunctions)().taskQueue("reassignOrderOffer");
                await queue.enqueue(payload, {
                    scheduleDelaySeconds: Math.max(5, Math.min(delaySeconds, 300)),
                });
            }
            catch (err) {
                logger.warn("Failed to enqueue Cloud Task reassignOrderOffer", {
                    orderId: payload.orderId,
                    expectedCaptainId: payload.expectedCaptainId,
                    error: err instanceof Error ? err.message : String(err),
                });
                throw err;
            }
        },
    };
}
/**
 * Production ManualSubscriptionEffectsPort backed by Admin FieldValue and FCM.
 * Strictly sends subscription updates to the merchant's own fcmToken (never captains).
 * @return {ManualSubscriptionEffectsPort} Production effects implementation.
 */
function createAdminManualSubscriptionEffects() {
    return {
        now: () => Date.now(),
        sentinels: {
            serverTimestamp: () => firestore_1.FieldValue.serverTimestamp(),
            deleteField: () => firestore_1.FieldValue.delete(),
            increment: (value) => firestore_1.FieldValue.increment(value),
            arrayUnion: (...elements) => firestore_1.FieldValue.arrayUnion(...elements),
        },
        async verifyStorageReceiptExists(storagePath) {
            const trimmed = String(storagePath || "").trim();
            if (!trimmed)
                return false;
            try {
                let objectPath = trimmed;
                if (trimmed.startsWith("gs://")) {
                    const withoutScheme = trimmed.slice(5);
                    const slashIdx = withoutScheme.indexOf("/");
                    objectPath = slashIdx >= 0 ? withoutScheme.slice(slashIdx + 1) : "";
                }
                objectPath = objectPath.replace(/^\/+/, "");
                if (!objectPath)
                    return false;
                const [exists] = await (0, storage_1.getStorage)().bucket().file(objectPath).exists();
                return Boolean(exists);
            }
            catch (err) {
                logger.warn("Storage receipt existence verification failed", {
                    storagePath: trimmed,
                    error: err instanceof Error ? err.message : String(err),
                });
                return false;
            }
        },
        async sendMerchantSubscriptionNotification(payload) {
            var _a, _b, _c;
            if (!payload.fcmToken) {
                logger.info("Skipping merchant subscription FCM: merchant lacks fcmToken", {
                    merchantId: payload.merchantId,
                    requestId: payload.requestId,
                    eventType: payload.eventType,
                });
                return;
            }
            const merchantSignalTypeMap = {
                subscription_approved: "SUBSCRIPTION_ACTIVATED",
                subscription_rejected: "SUBSCRIPTION_REJECTED",
                subscription_resubmission_requested: "SUBSCRIPTION_RESUBMISSION_REQUIRED",
            };
            try {
                await (0, messaging_1.getMessaging)().send({
                    token: payload.fcmToken,
                    notification: {
                        title: payload.title,
                        body: payload.body,
                    },
                    android: {
                        priority: "high",
                        notification: {
                            channelId: "subscription_sync_channel",
                            sound: "default",
                        },
                    },
                    data: {
                        type: merchantSignalTypeMap[payload.eventType] || "SUBSCRIPTION_UPDATED",
                        eventType: payload.eventType,
                        requestId: payload.requestId,
                        merchantId: payload.merchantId,
                        planId: (_a = payload.planId) !== null && _a !== void 0 ? _a : "",
                        planName: (_b = payload.planName) !== null && _b !== void 0 ? _b : "",
                        maxCaptains: payload.maxCaptains !== undefined ? String(payload.maxCaptains) : "",
                        reason: (_c = payload.reason) !== null && _c !== void 0 ? _c : "",
                        dedupeKey: payload.dedupeKey,
                    },
                });
            }
            catch (err) {
                logger.warn("Failed to send merchant subscription FCM push", {
                    merchantId: payload.merchantId,
                    requestId: payload.requestId,
                    eventType: payload.eventType,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        },
        async sendAdminNewManualRequestNotification(payload) {
            if (!payload.tokens || payload.tokens.length === 0)
                return;
            try {
                await (0, messaging_1.getMessaging)().sendEachForMulticast({
                    tokens: payload.tokens,
                    notification: {
                        title: `طلب اشتراك جديد — ${payload.merchantName}`,
                        body: `تحويل فودافون كاش بمبلغ ${payload.amount} ج.م للباقة "${payload.planName}" بانتظار المراجعة.`,
                    },
                    data: {
                        type: "manual_subscription_request",
                        requestId: payload.requestId,
                        merchantId: payload.merchantId,
                        merchantName: payload.merchantName,
                        planName: payload.planName,
                        amount: String(payload.amount),
                    },
                });
            }
            catch (err) {
                logger.warn("Failed to send admin FCM multicast for manual subscription request", {
                    requestId: payload.requestId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        },
    };
}
//# sourceMappingURL=firebaseAdapter.js.map