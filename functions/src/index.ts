import {createHash} from "node:crypto";
import {initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import {setGlobalOptions} from "firebase-functions";
import * as logger from "firebase-functions/logger";
import {
  onDocumentCreated,
  onDocumentUpdated,
} from "firebase-functions/v2/firestore";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {onTaskDispatched} from "firebase-functions/v2/tasks";
import {
  createAdminDatabaseAdapter,
  createAdminManualSubscriptionEffects,
  createAdminServerEffects,
} from "./firebaseAdapter.js";
import {ManualSubscriptionsServerService} from "./manualSubscriptionsService.js";
import {OrderServerService} from "./ordersService.js";
import {DomainHttpsError, ReassignTaskPayload} from "./types.js";
import {
  isCaptainCandidateBaseEligible,
  readNormalizedOrderStatus,
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

/**
 * Limits unauthenticated pre-login phone-to-email lookups without storing raw phone
 * numbers or source IP addresses. This endpoint is needed by the captain phone-login flow.
 */
async function enforceCaptainPhoneLookupRateLimit(
  sourceIp: string,
  rawPhone: string
): Promise<void> {
  const phoneDigits = rawPhone.replace(/\\D/g, "").slice(-12);
  if (phoneDigits.length < 8) {
    throw new HttpsError("invalid-argument", "رقم الهاتف غير صالح.");
  }

  const nowMs = Date.now();
  const windowMs = 15 * 60 * 1000;
  const ipHash = createHash("sha256").update(sourceIp || "unknown").digest("hex");
  const phoneHash = createHash("sha256").update(phoneDigits).digest("hex");
  const database = getFirestore();
  const ipRef = database.collection("phone_lookup_rate_limits").doc(`ip_${ipHash}`);
  const phoneRef = database.collection("phone_lookup_rate_limits").doc(`phone_${phoneHash}`);

  const allowed = await database.runTransaction(async (tx) => {
    const [ipSnap, phoneSnap] = await Promise.all([tx.get(ipRef), tx.get(phoneRef)]);
    const ipData = ipSnap.data() ?? {};
    const phoneData = phoneSnap.data() ?? {};
    const ipStart = Number(ipData.windowStartedAt ?? 0);
    const phoneStart = Number(phoneData.windowStartedAt ?? 0);
    const ipWindowActive = ipStart > 0 && nowMs - ipStart < windowMs;
    const phoneWindowActive = phoneStart > 0 && nowMs - phoneStart < windowMs;
    const ipCount = ipWindowActive ? Number(ipData.count ?? 0) : 0;
    const phoneCount = phoneWindowActive ? Number(phoneData.count ?? 0) : 0;

    // 30 attempts per source IP and 10 attempts per phone number in each 15-minute window.
    if (ipCount >= 30 || phoneCount >= 10) return false;

    tx.set(ipRef, {
      windowStartedAt: ipWindowActive ? ipStart : nowMs,
      count: ipCount + 1,
      expiresAt: new Date(nowMs + 2 * windowMs),
      updatedAt: new Date(nowMs),
    });
    tx.set(phoneRef, {
      windowStartedAt: phoneWindowActive ? phoneStart : nowMs,
      count: phoneCount + 1,
      expiresAt: new Date(nowMs + 2 * windowMs),
      updatedAt: new Date(nowMs),
    });
    return true;
  });

  if (!allowed) {
    throw new HttpsError(
      "resource-exhausted",
      "تم تجاوز عدد محاولات البحث عن الحساب. يرجى الانتظار 15 دقيقة ثم المحاولة مرة أخرى."
    );
  }
}

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
      const phone = String(payload.phone ?? payload.phoneNumber ?? "").trim();
      await enforceCaptainPhoneLookupRateLimit(
        request.rawRequest.ip || "unknown",
        phone
      );
      return await service.resolveCaptainEmailByPhone(payload);
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
/**
 * When a captain transitions from unavailable to eligible, retry a bounded batch
 * of queued orders. This is the single authoritative replacement for the retired
 * merchant/captain-app auto-dispatch triggers.
 */
export const onCaptainAvailabilityChanged = onDocumentUpdated(
  {document: "captains/{captainId}", region: "us-central1"},
  async (event) => {
    const before = event.data?.before.data() as Record<string, unknown> | undefined;
    const after = event.data?.after.data() as Record<string, unknown> | undefined;
    if (!before || !after) return;

    const nowMs = Date.now();
    const isQueueReady = (data: Record<string, unknown>): boolean => {
      const presence = String(data.presenceStatus ?? data.availabilityStatus ?? "").trim().toLowerCase();
      const hasActiveOrder = Boolean(
        String(data.currentOrderId ?? data.activeOrderId ?? "").trim()
      );
      const isBusy = data.isBusy === true ||
        hasActiveOrder ||
        ["busy", "on_trip", "on_trip", "in_trip"].includes(presence);
      return data.isOnline === true &&
        !isBusy &&
        !["offline", "busy", "on_trip", "in_trip"].includes(presence) &&
        isCaptainCandidateBaseEligible(data, nowMs);
    };
    const wasQueueReady = isQueueReady(before);
    const isQueueReadyNow = isQueueReady(after);
    if (wasQueueReady || !isQueueReadyNow) return;

    try {
      const waiting = await getFirestore()
        .collection("orders")
        .where("status", "in", ["pending", "searching"])
        .limit(30)
        .get();

      for (const orderDoc of waiting.docs) {
        try {
          await service.dispatchNewOrSearchingOrder(orderDoc.id);
        } catch (err) {
          logger.error("Failed to retry queued order after captain became eligible", {
            captainId: event.params.captainId,
            orderId: orderDoc.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.error("Failed to load queued orders after captain availability changed", {
        captainId: event.params.captainId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
);

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
 * Trigger 3: Notifies admins whenever a merchant submits a new manual subscription request.
 */
export const onManualSubscriptionRequestCreated = onDocumentCreated(
  {document: "manual_subscription_requests/{requestId}", region: "us-central1"},
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
    }
  }
);

