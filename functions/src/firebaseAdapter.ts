import {
  CollectionReference,
  DocumentReference,
  FieldValue,
  Firestore,
  Query,
} from "firebase-admin/firestore";
import {getFunctions} from "firebase-admin/functions";
import {getMessaging} from "firebase-admin/messaging";
import {getStorage} from "firebase-admin/storage";
import * as logger from "firebase-functions/logger";
import {
  AdminManualSubFcmPayload,
  CollectionRefLike,
  DatabaseLike,
  DocRefLike,
  DocSnapshotLike,
  ManualSubscriptionEffectsPort,
  MerchantSubscriptionFcmPayload,
  OfferFcmPayload,
  QueryLike,
  QuerySnapshotLike,
  ReassignTaskPayload,
  ServerEffectsPort,
  TransactionLike,
} from "./types.js";

function wrapDocRef(ref: DocumentReference): DocRefLike {
  return {
    get id() {
      return ref.id;
    },
    get path() {
      return ref.path;
    },
    collection(collectionPath: string) {
      return wrapCollectionRef(ref.collection(collectionPath));
    },
    async get(): Promise<DocSnapshotLike> {
      const snap = await ref.get();
      return {
        id: snap.id,
        exists: snap.exists,
        ref: wrapDocRef(snap.ref),
        data: () => snap.data() as Record<string, unknown> | undefined,
      };
    },
    async set(data: Record<string, unknown>, options?: {merge?: boolean}) {
      await ref.set(data, options ? {merge: Boolean(options.merge)} : {});
    },
    async update(data: Record<string, unknown>) {
      await ref.update(data);
    },
  };
}

function wrapQuery(q: Query): QueryLike {
  const wrapper: QueryLike & {__rawQuery?: Query} = {
    __rawQuery: q,
    where(
      fieldPath: string,
      opStr: "==" | "array-contains" | "in",
      value: unknown
    ) {
      return wrapQuery(q.where(fieldPath, opStr, value));
    },
    limit(limitCount: number) {
      return wrapQuery(q.limit(limitCount));
    },
    async get(): Promise<QuerySnapshotLike> {
      const snap = await q.get();
      return {
        empty: snap.empty,
        size: snap.size,
        docs: snap.docs.map((d) => ({
          id: d.id,
          exists: d.exists,
          ref: wrapDocRef(d.ref),
          data: () => d.data() as Record<string, unknown> | undefined,
        })),
      };
    },
  };
  return wrapper;
}

function wrapCollectionRef(col: CollectionReference): CollectionRefLike {
  const baseQuery = wrapQuery(col);
  return {
    ...baseQuery,
    doc(docId?: string): DocRefLike {
      return wrapDocRef(docId ? col.doc(docId) : col.doc());
    },
    async add(data: Record<string, unknown>): Promise<DocRefLike> {
      const added = await col.add(data);
      return wrapDocRef(added);
    },
  };
}

function unwrapDocRef(ref: DocRefLike, firestore: Firestore): DocumentReference {
  return firestore.doc(ref.path);
}

/**
 * Wraps the real Firebase Admin Firestore instance in the DatabaseLike interface.
 * @param {Firestore} firestore Admin SDK Firestore instance.
 * @return {DatabaseLike} DatabaseLike adapter.
 */
export function createAdminDatabaseAdapter(firestore: Firestore): DatabaseLike {
  return {
    collection(collectionPath: string): CollectionRefLike {
      return wrapCollectionRef(firestore.collection(collectionPath));
    },
    async runTransaction<T>(fn: (tx: TransactionLike) => Promise<T>): Promise<T> {
      return firestore.runTransaction(async (adminTx) => {
        const txAdapter: TransactionLike = {
          async get(ref: DocRefLike): Promise<DocSnapshotLike> {
            const adminRef = unwrapDocRef(ref, firestore);
            const snap = await adminTx.get(adminRef);
            return {
              id: snap.id,
              exists: snap.exists,
              ref: wrapDocRef(snap.ref),
              data: () => snap.data() as Record<string, unknown> | undefined,
            };
          },
          async getQuery(q: QueryLike): Promise<QuerySnapshotLike> {
            // Execute underlying query via tx by re-building on original Query not exposed;
            // keep safe cast through internal symbol or fallback query execution.
            const adminQuery = (q as unknown as {__rawQuery?: Query}).__rawQuery;
            const snap = adminQuery ? await adminTx.get(adminQuery) : null;
            if (snap) {
              return {
                empty: snap.empty,
                size: snap.size,
                docs: snap.docs.map((d) => ({
                  id: d.id,
                  exists: d.exists,
                  ref: wrapDocRef(d.ref),
                  data: () => d.data() as Record<string, unknown> | undefined,
                })),
              };
            }
            return q.get();
          },
          set(ref: DocRefLike, data: Record<string, unknown>, options?: {merge?: boolean}) {
            const adminRef = unwrapDocRef(ref, firestore);
            adminTx.set(adminRef, data, options ? {merge: Boolean(options.merge)} : {});
          },
          update(ref: DocRefLike, data: Record<string, unknown>) {
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
export function createAdminServerEffects(): ServerEffectsPort {
  return {
    now: () => Date.now(),
    sentinels: {
      serverTimestamp: () => FieldValue.serverTimestamp(),
      deleteField: () => FieldValue.delete(),
      increment: (value: number) => FieldValue.increment(value),
      arrayUnion: (...elements: unknown[]) => FieldValue.arrayUnion(...elements),
    },
    async sendOfferNotification(payload: OfferFcmPayload): Promise<void> {
      if (!payload.fcmToken) {
        logger.info("Skipping FCM push: captain lacks fcmToken", {
          captainUid: payload.captainUid,
          orderId: payload.orderId,
        });
        return;
      }

      try {
        await getMessaging().send({
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
      } catch (err) {
        logger.warn("Failed to send offer FCM push to captain", {
          captainUid: payload.captainUid,
          orderId: payload.orderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    async enqueueReassignTask(
      payload: ReassignTaskPayload,
      delaySeconds: number
    ): Promise<void> {
      try {
        const queue = getFunctions().taskQueue("reassignOrderOffer");
        await queue.enqueue(payload, {
          scheduleDelaySeconds: Math.max(5, Math.min(delaySeconds, 300)),
        });
      } catch (err) {
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
export function createAdminManualSubscriptionEffects(): ManualSubscriptionEffectsPort {
  return {
    now: () => Date.now(),
    sentinels: {
      serverTimestamp: () => FieldValue.serverTimestamp(),
      deleteField: () => FieldValue.delete(),
      increment: (value: number) => FieldValue.increment(value),
      arrayUnion: (...elements: unknown[]) => FieldValue.arrayUnion(...elements),
    },
    async verifyStorageReceiptExists(storagePath: string): Promise<boolean> {
      const trimmed = String(storagePath || "").trim();
      if (!trimmed) return false;
      try {
        let objectPath = trimmed;
        if (trimmed.startsWith("gs://")) {
          const withoutScheme = trimmed.slice(5);
          const slashIdx = withoutScheme.indexOf("/");
          objectPath = slashIdx >= 0 ? withoutScheme.slice(slashIdx + 1) : "";
        }
        objectPath = objectPath.replace(/^\/+/, "");
        if (!objectPath) return false;

        const [exists] = await getStorage().bucket().file(objectPath).exists();
        return Boolean(exists);
      } catch (err) {
        logger.warn("Storage receipt existence verification failed", {
          storagePath: trimmed,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },
    async sendMerchantSubscriptionNotification(
      payload: MerchantSubscriptionFcmPayload
    ): Promise<void> {
      if (!payload.fcmToken) {
        logger.info("Skipping merchant subscription FCM: merchant lacks fcmToken", {
          merchantId: payload.merchantId,
          requestId: payload.requestId,
          eventType: payload.eventType,
        });
        return;
      }

      const merchantSignalTypeMap: Record<
        MerchantSubscriptionFcmPayload["eventType"],
        string
      > = {
        subscription_approved: "SUBSCRIPTION_ACTIVATED",
        subscription_rejected: "SUBSCRIPTION_REJECTED",
        subscription_resubmission_requested: "SUBSCRIPTION_RESUBMISSION_REQUIRED",
      };

      try {
        await getMessaging().send({
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
            planId: payload.planId ?? "",
            planName: payload.planName ?? "",
            maxCaptains:
              payload.maxCaptains !== undefined ? String(payload.maxCaptains) : "",
            reason: payload.reason ?? "",
            dedupeKey: payload.dedupeKey,
          },
        });
      } catch (err) {
        logger.warn("Failed to send merchant subscription FCM push", {
          merchantId: payload.merchantId,
          requestId: payload.requestId,
          eventType: payload.eventType,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    async sendAdminNewManualRequestNotification(
      payload: AdminManualSubFcmPayload
    ): Promise<void> {
      if (!payload.tokens || payload.tokens.length === 0) return;

      try {
        await getMessaging().sendEachForMulticast({
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
      } catch (err) {
        logger.warn("Failed to send admin FCM multicast for manual subscription request", {
          requestId: payload.requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

