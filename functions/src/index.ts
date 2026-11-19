import {initializeApp} from "firebase-admin/app";
import {randomInt} from "node:crypto";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {getMessaging} from "firebase-admin/messaging";
import {setGlobalOptions} from "firebase-functions";
import * as logger from "firebase-functions/logger";
import {
  onDocumentCreated,
  onDocumentUpdated,
} from "firebase-functions/v2/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {onTaskDispatched} from "firebase-functions/v2/tasks";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {
  createAdminDatabaseAdapter,
  createAdminServerEffects,
} from "./firebaseAdapter.js";
import {OrderServerService} from "./ordersService.js";
import {DomainHttpsError, ReassignTaskPayload} from "./types.js";
import {
  assertMerchantAndSubscriptionValid,
  extractCoordinates,
  extractOrderCaptainUid,
  readNormalizedOrderStatus,
  readNumber,
  readString,
} from "./validators.js";

initializeApp();
setGlobalOptions({region: "us-central1", maxInstances: 10});

const service = new OrderServerService(
  createAdminDatabaseAdapter(getFirestore()),
  createAdminServerEffects()
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

/**
 * Callable 1: Authoritative order acceptance by authenticated captain.
 */
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
      return await service.resolveCaptainEmailByPhone(payload);
    } catch (err) {
      throw mapError(err);
    }
  }
);



const ADMIN_EMAIL_ALLOWLIST = new Set([
  "moamen.elsayed.abdelmoamen@gmail.com",
  "admin@elbatalexpress.com",
]);

async function requireAdminUid(
  uid: string | undefined,
  claims: Record<string, unknown>
): Promise<string> {
  const cleanUid = typeof uid === "string" ? uid.trim() : "";
  if (!cleanUid) {
    throw new HttpsError("unauthenticated", "يجب تسجيل الدخول كمدير أولاً.");
  }

  const adminDoc = await getFirestore().collection("admins").doc(cleanUid).get();
  const email = typeof claims.email === "string"
    ? claims.email.trim().toLowerCase()
    : "";
  const verifiedAllowlistedEmail =
    claims.email_verified === true && ADMIN_EMAIL_ALLOWLIST.has(email);
  const trustedClaims =
    claims.role === "admin" || claims.admin === true;

  if (!adminDoc.exists && !verifiedAllowlistedEmail && !trustedClaims) {
    throw new HttpsError(
      "permission-denied",
      "هذا الحساب لا يمتلك صلاحية تنفيذ عمليات إدارة الطلبات."
    );
  }
  return cleanUid;
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

      const orderRef = db.collection("orders").doc();
      const orderNumber = `#ELB-${randomInt(100000, 1000000)}`;
      const merchantName = readString(merchantData, "name", "merchantName", "restaurantName");
      const pickupAddress = readString(merchantData, "address", "pickupAddress", "storeAddress");
      await orderRef.create({
        orderNumber,
        orderCode: orderNumber,
        order_code: orderNumber,
        order_codes: orderNumber,
        merchantId,
        restaurantId: merchantId,
        merchantName,
        restaurantName: merchantName,
        storeName: merchantName,
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
        captainId: null,
        driverId: null,
        offeredCaptainId: null,
        offerGeneration: 0,
        offerExpiresAt: null,
        excludedCaptainIds: [],
        timedOutCaptainIds: [],
        eligibleCaptainIds: [],
        requestedCaptainId: requestedCaptainId || null,
        dispatchedBy: adminUid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        success: true,
        orderId: orderRef.id,
        orderNumber,
        status: "pending",
        dispatchStatus: "searching",
      };
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

      let captainId = "";
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
        captainId = extractOrderCaptainUid(order);
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

      if (confirmed && captainId && !result.alreadyUpdated) {
        try {
          const captainSnap = await db.collection("captains").doc(captainId).get();
          const fcmToken = readString(captainSnap.data(), "fcmToken", "fcm_token");
          if (fcmToken) {
            await getMessaging().send({
              token: fcmToken,
              android: {priority: "high"},
              data: {type: "merchant_confirmed", orderId},
            });
          }
        } catch (err) {
          logger.warn("Failed to notify captain after merchant confirmation", {
            orderId,
            captainId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return {success: true, orderId, ...result};
    } catch (err) {
      throw mapError(err);
    }
  }
);


/**
 * Trigger 1: Auto-dispatches newly created pending orders to nearest eligible captain
 * with a server-authored 60-second offer deadline + Cloud Task watchdog.
 */
export const onOrderCreatedDispatch = onDocumentCreated(
  {document: "orders/{orderId}", region: "us-central1"},
  async (event) => {
    const orderId = event.params.orderId;
    try {
      await service.dispatchNewOrSearchingOrder(orderId);
    } catch (err) {
      logger.error("Failed initial dispatch for created order", {
        orderId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
);

/**
 * Trigger 2: Handles admin/merchant manual re-queue to searching state without looping.
 */
export const onOrderUpdatedDispatch = onDocumentUpdated(
  {document: "orders/{orderId}", region: "us-central1"},
  async (event) => {
    const after = event.data?.after.data() as Record<string, unknown> | undefined;
    const before = event.data?.before.data() as Record<string, unknown> | undefined;
    if (!after || !before) return;

    const afterStatus = readNormalizedOrderStatus(after);
    const afterDispatch = String(after.dispatchStatus ?? "").toLowerCase();
    const beforeDispatch = String(before.dispatchStatus ?? "").toLowerCase();
    const afterOffered = String(after.offeredCaptainId ?? "").trim();

    if (
      (afterStatus === "pending" || afterStatus === "searching") &&
      afterDispatch === "searching" &&
      beforeDispatch !== "searching" &&
      !afterOffered
    ) {
      try {
        await service.dispatchNewOrSearchingOrder(event.params.orderId);
      } catch (err) {
        logger.error("Failed re-queued dispatch for updated order", {
          orderId: event.params.orderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
      logger.info("Expired-order offer recovery sweep completed", {processed});
    } catch (err) {
      logger.error("Expired-order offer recovery sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
);
