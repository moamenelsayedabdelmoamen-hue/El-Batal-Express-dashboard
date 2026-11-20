import {randomBytes, randomInt} from "node:crypto";
import {
  FieldValue,
  Firestore,
  GeoPoint,
  Timestamp,
} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";

const PLAN_CATALOG = {
  1: {planName: "الباقة الأساسية", captainLimit: 2, price: 400},
  2: {planName: "الباقة المتوسطة", captainLimit: 4, price: 800},
  3: {planName: "الباقة المميزة", captainLimit: 6, price: 1200},
  4: {planName: "الباقة المتقدمة", captainLimit: 8, price: 1600},
} as const;

const TERMINAL_ORDER_STATUSES = new Set([
  "delivered", "completed", "complete", "done", "cancelled", "canceled",
  "rejected", "declined", "expired", "failed", "closed",
  "تم التسليم", "تم التوصيل", "مكتمل", "مكتملة", "ملغي", "ملغى",
  "تم الإلغاء", "تم الالغاء", "مرفوض", "مرفوضة", "منتهي", "منتهية",
]);

type SubscriptionResult = {
  isValid: boolean;
  isActive: boolean;
  isSubscribed: boolean;
  status: string;
  planId: number;
  planName: string;
  maxCaptains: number;
  captainLimit: number;
  price: number;
  startDate: number | null;
  activatedAt: number | null;
  endDate: number | null;
  expiresAt: number | null;
  remainingMillis: number;
  remainingDays: number;
  remainingHours: number;
  activeCaptainsCount: number;
  remainingCaptains: number;
  subscriptionVersion: number;
  errorMessage?: string;
};

function stringValue(data: Record<string, unknown> | undefined, ...keys: string[]): string {
  if (!data) return "";
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function numberValue(data: Record<string, unknown> | undefined, ...keys: string[]): number | null {
  if (!data) return null;
  for (const key of keys) {
    const raw = data[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim()) {
      const parsed = Number(raw.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function timestampMs(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Timestamp) return raw.toMillis();
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const numeric = Number(raw.trim());
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
    }
    const parsed = Date.parse(raw.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof raw === "object") {
    const value = raw as {toMillis?: () => number; seconds?: number; _seconds?: number};
    if (typeof value.toMillis === "function") {
      try {
        const parsed = value.toMillis();
        return Number.isFinite(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
    const seconds = value.seconds ?? value._seconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) return seconds * 1000;
  }
  return null;
}

function normalizeSubscriptionStatus(raw: unknown): string {
  const value = String(raw ?? "").trim().toLowerCase();
  if (["active", "activated", "subscribed", "enabled", "valid", "approved", "paid", "نشط", "نشطة", "ساري", "سارية", "مفعل", "مفعّل", "مفعلة", "مفعّلة"].includes(value)) return "active";
  if (["suspended", "suspend", "paused", "blocked", "موقوف", "موقوفة", "متوقف", "متوقفة"].includes(value)) return "suspended";
  if (["inactive", "disabled", "deactivated", "غير نشط", "غير نشطة"].includes(value)) return "inactive";
  if (["cancelled", "canceled", "cancel", "revoked", "ملغي", "ملغى", "ملغاة"].includes(value)) return "cancelled";
  if (["expired", "منتهي", "منتهية", "منتهي الصلاحية"].includes(value)) return "expired";
  if (["pending_review", "under_review", "in_review", "في انتظار مراجعة الإدارة", "قيد مراجعة الإدارة"].includes(value)) return "pending_review";
  if (["pending", "قيد المراجعة", "معلق", "معلقة", "بانتظار التفعيل"].includes(value)) return "pending";
  if (["rejected", "مرفوض", "مرفوضة", "تم الرفض"].includes(value)) return "rejected";
  if (["resubmission_required", "resubmit_required", "مطلوب إعادة إرسال الإيصال"].includes(value)) return "resubmission_required";
  if (["pending_payment", "awaiting_payment", "في انتظار الدفع"].includes(value)) return "pending_payment";
  if (["payment_failed", "failed", "unpaid"].includes(value)) return "payment_failed";
  return value || "unsubscribed";
}

function isMerchantAccount(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  const accountType = stringValue(data, "accountType").toLowerCase();
  const role = stringValue(data, "role").toLowerCase();
  return accountType === "merchant" || (!accountType && role === "merchant");
}

function isActiveOrder(data: Record<string, unknown>): boolean {
  const status = stringValue(data, "status", "order_status", "orderStatus", "state").toLowerCase();
  if (!status) return false;
  if (TERMINAL_ORDER_STATUSES.has(status)) return false;
  return !status.includes("تم التسليم") &&
    !status.includes("تم التوصيل") &&
    !status.includes("تم الإلغاء") &&
    !status.includes("تم الالغاء") &&
    !status.includes("مكتمل") &&
    !status.includes("مرفوض");
}

function randomSixDigitCode(): string {
  const first = randomInt(1, 10);
  const pool = Array.from({length: 10}, (_, index) => index).filter((n) => n !== first);
  const digits = [first];
  for (let i = 0; i < 5; i += 1) digits.push(pool.splice(randomInt(0, pool.length), 1)[0]);
  return digits.join("");
}

function selectSubscription(
  canonical: Record<string, unknown> | undefined,
  fallbackDocs: Array<Record<string, unknown>>,
  merchant: Record<string, unknown>
): Record<string, unknown> {
  const candidates = [canonical, ...fallbackDocs].filter(
    (item): item is Record<string, unknown> => Boolean(item)
  );
  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    const bestVersion = Number(best.subscriptionVersion ?? 0);
    const candidateVersion = Number(candidate.subscriptionVersion ?? 0);
    const bestTime = timestampMs(best.subscriptionUpdatedAt ?? best.updatedAt ?? best.activatedAt) ?? 0;
    const candidateTime = timestampMs(candidate.subscriptionUpdatedAt ?? candidate.updatedAt ?? candidate.activatedAt) ?? 0;
    if (candidateVersion > bestVersion || (candidateVersion === bestVersion && candidateTime > bestTime)) best = candidate;
  }

  const merchantVersion = Number(merchant.subscriptionVersion ?? 0);
  const selectedVersion = Number(best?.subscriptionVersion ?? 0);
  const merchantTime = timestampMs(merchant.subscriptionUpdatedAt ?? merchant.updatedAt) ?? 0;
  const selectedTime = timestampMs(best?.subscriptionUpdatedAt ?? best?.updatedAt ?? best?.activatedAt) ?? 0;
  const mirrorIsNewer = merchantVersion > selectedVersion ||
    (merchantVersion === selectedVersion && merchantTime > selectedTime);
  if (mirrorIsNewer && (merchant.subscriptionStatus || merchant.planStatus)) {
    return {
      ...(best ?? {}),
      status: merchant.subscriptionStatus ?? merchant.planStatus,
      subscriptionStatus: merchant.subscriptionStatus ?? merchant.planStatus,
      planId: merchant.planId ?? best?.planId,
      planName: merchant.planName ?? best?.planName,
      maxCaptains: merchant.maxCaptains ?? best?.maxCaptains,
      captainLimit: merchant.captainLimit ?? best?.captainLimit,
      price: merchant.price ?? best?.price,
      startDate: merchant.subscriptionStartDate ?? merchant.activatedAt ?? best?.startDate,
      activatedAt: merchant.activatedAt ?? merchant.subscriptionStartDate ?? best?.activatedAt,
      endDate: merchant.subscriptionEndDate ?? merchant.expiresAt ?? best?.endDate,
      expiresAt: merchant.expiresAt ?? merchant.subscriptionEndDate ?? best?.expiresAt,
      isActive: merchant.isActive ?? best?.isActive,
      isSubscribed: merchant.isSubscribed ?? best?.isSubscribed,
      paymentStatus: merchant.paymentStatus ?? best?.paymentStatus,
      subscriptionVersion: merchantVersion,
      subscriptionUpdatedAt: merchant.subscriptionUpdatedAt,
    };
  }
  if (best) return best;
  return {
    status: merchant.subscriptionStatus ?? merchant.planStatus ?? "unsubscribed",
    planId: merchant.planId,
    planName: merchant.planName,
    maxCaptains: merchant.maxCaptains,
    captainLimit: merchant.captainLimit,
    isActive: merchant.isActive,
    isSubscribed: merchant.isSubscribed,
    paymentStatus: merchant.paymentStatus,
    startDate: merchant.subscriptionStartDate,
    endDate: merchant.subscriptionEndDate,
    expiresAt: merchant.expiresAt,
    subscriptionVersion: merchant.subscriptionVersion,
  };
}

function evaluateSubscription(
  merchant: Record<string, unknown>,
  subscription: Record<string, unknown>,
  activeCount: number,
  requestedCaptains: number,
  now: number
): SubscriptionResult {
  const version = Math.max(
    Number(merchant.subscriptionVersion ?? 0),
    Number(subscription.subscriptionVersion ?? 0),
    1
  );
  const base = {
    planId: 0,
    planName: "غير مشترك",
    maxCaptains: 0,
    captainLimit: 0,
    price: 0,
    startDate: null as number | null,
    activatedAt: null as number | null,
    endDate: null as number | null,
    expiresAt: null as number | null,
    remainingMillis: 0,
    remainingDays: 0,
    remainingHours: 0,
    activeCaptainsCount: activeCount,
    remainingCaptains: 0,
    subscriptionVersion: version,
  };
  const accountStatus = stringValue(merchant, "status").toLowerCase();
  const approved = ["approved", "active"].includes(accountStatus) ||
    (!accountStatus && merchant.isApproved === true);
  if (!isMerchantAccount(merchant)) {
    return {...base, isValid: false, isActive: false, isSubscribed: false, status: "not_found", errorMessage: "تعذر العثور على بيانات حساب التاجر."};
  }
  if (!approved || merchant.isBlocked === true || merchant.isSuspended === true) {
    return {...base, isValid: false, isActive: false, isSubscribed: false, status: "merchant_pending", errorMessage: "حساب التاجر في انتظار الاعتماد أو موقوف من الإدارة."};
  }

  const status = normalizeSubscriptionStatus(
    subscription.status ?? subscription.subscriptionStatus ?? subscription.planStatus
  );
  const planIdRaw = Number(subscription.planId ?? 0);
  const planId = Number.isInteger(planIdRaw) && planIdRaw >= 1 && planIdRaw <= 4 ? planIdRaw : 0;
  const plan = planId ? PLAN_CATALOG[planId as keyof typeof PLAN_CATALOG] : undefined;
  const limitRaw = Number(subscription.captainLimit ?? subscription.maxCaptains ?? 0);
  const captainLimit = [2, 4, 6, 8].includes(limitRaw) ? limitRaw : (plan?.captainLimit ?? 0);
  const effectivePlanId = planId || ({2: 1, 4: 2, 6: 3, 8: 4} as Record<number, number>)[captainLimit] || 0;
  const effectivePlan = effectivePlanId ? PLAN_CATALOG[effectivePlanId as keyof typeof PLAN_CATALOG] : undefined;
  const planName = stringValue(subscription, "planName") || effectivePlan?.planName || "غير مشترك";
  const price = Number(subscription.price ?? effectivePlan?.price ?? 0) || 0;
  const startDate = timestampMs(subscription.activatedAt ?? subscription.startDate ?? subscription.subscriptionStartDate);
  const endDate = timestampMs(subscription.expiresAt ?? subscription.endDate ?? subscription.subscriptionEndDate ?? subscription.expiryDate);
  const paymentStatus = stringValue(subscription, "paymentStatus").toLowerCase();
  const explicitlyDisabled = subscription.isActive === false && subscription.isSubscribed !== true;

  let errorMessage = "";
  if (status !== "active" || explicitlyDisabled || captainLimit <= 0) {
    const messages: Record<string, string> = {
      suspended: "تم إيقاف اشتراكك من قبل الإدارة.",
      inactive: "اشتراكك غير نشط حالياً.",
      cancelled: "تم إلغاء اشتراكك. يرجى التواصل مع الإدارة أو الاشتراك في باقة جديدة.",
      expired: "انتهت فترة اشتراكك، يرجى تجديد الاشتراك.",
      pending: "اشتراكك في انتظار مراجعة الإدارة ولم يتم تفعيله بعد.",
      pending_review: "طلب الاشتراك في انتظار مراجعة الإدارة ولم يتم تفعيله بعد.",
      rejected: "تم رفض طلب الاشتراك من الإدارة.",
      resubmission_required: "مطلوب إعادة إرسال إيصال الاشتراك.",
      pending_payment: "لم يتم تأكيد الدفع لهذا الاشتراك.",
      payment_failed: "لم يتم تأكيد الدفع لهذا الاشتراك.",
    };
    errorMessage = messages[status] || "لا يوجد اشتراك نشط لهذا التاجر.";
  } else if (["failed", "unpaid", "pending"].includes(paymentStatus)) {
    errorMessage = "لم يتم تأكيد الدفع لهذا الاشتراك.";
  } else if (endDate !== null && now >= endDate) {
    errorMessage = "انتهت فترة اشتراكك، يرجى تجديد الاشتراك.";
  }

  if (errorMessage) {
    return {
      ...base,
      isValid: false,
      isActive: false,
      isSubscribed: false,
      status: endDate !== null && now >= endDate && status === "active" ? "expired" : status,
      planId: effectivePlanId,
      planName,
      maxCaptains: captainLimit,
      captainLimit,
      price,
      startDate,
      activatedAt: startDate,
      endDate,
      expiresAt: endDate,
      errorMessage,
    };
  }

  const remaining = Math.max(0, captainLimit - activeCount);
  if (activeCount + requestedCaptains > captainLimit) {
    return {
      ...base,
      isValid: false,
      isActive: true,
      isSubscribed: true,
      status: "active",
      planId: effectivePlanId,
      planName,
      maxCaptains: captainLimit,
      captainLimit,
      price,
      startDate,
      activatedAt: startDate,
      endDate,
      expiresAt: endDate,
      remainingMillis: endDate === null ? 0 : Math.max(0, endDate - now),
      remainingDays: endDate === null ? 0 : Math.floor(Math.max(0, endDate - now) / 86400000),
      remainingHours: endDate === null ? 0 : Math.floor(Math.max(0, endDate - now) / 3600000),
      remainingCaptains: remaining,
      errorMessage: remaining === 0
        ? `وصلت إلى الحد الأقصى لعدد الكباتن المتزامنين في باقتك (${captainLimit}).`
        : `المتبقي لك ${remaining} كابتن فقط من أصل ${captainLimit} في باقتك الحالية.`,
    };
  }

  return {
    ...base,
    isValid: true,
    isActive: true,
    isSubscribed: true,
    status: "active",
    planId: effectivePlanId,
    planName,
    maxCaptains: captainLimit,
    captainLimit,
    price,
    startDate,
    activatedAt: startDate,
    endDate,
    expiresAt: endDate,
    remainingMillis: endDate === null ? 0 : Math.max(0, endDate - now),
    remainingDays: endDate === null ? 0 : Math.floor(Math.max(0, endDate - now) / 86400000),
    remainingHours: endDate === null ? 0 : Math.floor(Math.max(0, endDate - now) / 3600000),
    remainingCaptains: remaining,
  };
}

function parseDeliveryFee(raw: unknown): number | null {
  const value = String(raw ?? "").trim().replace(/جنيه|EGP|LE/gi, "").replace(/\s+/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 && amount <= 10000 ? amount : null;
}

function readMerchantCoordinates(
  merchant: Record<string, unknown>,
  payload: Record<string, unknown>
): {lat: number; lng: number} | null {
  const location = merchant.location;
  let lat: number | null = numberValue(merchant, "latitude", "lat");
  let lng: number | null = numberValue(merchant, "longitude", "lng");
  if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && location && typeof location === "object") {
    const loc = location as Record<string, unknown>;
    lat = numberValue(loc, "latitude", "_latitude", "lat");
    lng = numberValue(loc, "longitude", "_longitude", "lng");
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    lat = numberValue(payload, "merchantLatitude");
    lng = numberValue(payload, "merchantLongitude");
  }
  if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) return null;
  return {lat, lng};
}

function collectOrders(
  snapshots: Array<{docs: Array<{id: string; data(): FirebaseFirestore.DocumentData}>}>
): {allIds: Set<string>; activeIds: Set<string>; finishedIds: Set<string>} {
  const allIds = new Set<string>();
  const activeIds = new Set<string>();
  const finishedIds = new Set<string>();
  for (const snapshot of snapshots) {
    for (const doc of snapshot.docs) {
      allIds.add(doc.id);
      if (isActiveOrder(doc.data())) activeIds.add(doc.id);
      else finishedIds.add(doc.id);
    }
  }
  return {allIds, activeIds, finishedIds};
}

export class MerchantOrderService {
  constructor(private readonly db: Firestore) {}

  private async readSubscription(
    merchantId: string,
    merchant: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const [canonical, byMerchant, byRestaurant, byUser] = await Promise.all([
      this.db.collection("subscriptions").doc(merchantId).get(),
      this.db.collection("subscriptions").where("merchantId", "==", merchantId).get(),
      this.db.collection("subscriptions").where("restaurantId", "==", merchantId).get(),
      this.db.collection("subscriptions").where("userId", "==", merchantId).get(),
    ]);
    const fallback = [...byMerchant.docs, ...byRestaurant.docs, ...byUser.docs]
      .filter((doc) => doc.id !== merchantId)
      .map((doc) => doc.data());
    return selectSubscription(
      canonical.exists ? canonical.data() : undefined,
      fallback,
      merchant
    );
  }

  private async countActiveOrders(merchantId: string): Promise<number> {
    const [byMerchant, byRestaurant, byUser] = await Promise.all([
      this.db.collection("orders").where("merchantId", "==", merchantId).get(),
      this.db.collection("orders").where("restaurantId", "==", merchantId).get(),
      this.db.collection("orders").where("userId", "==", merchantId).get(),
    ]);
    return collectOrders([byMerchant, byRestaurant, byUser]).activeIds.size;
  }

  async getMerchantSubscription(merchantId: string): Promise<Record<string, unknown>> {
    const merchantSnap = await this.db.collection("merchants").doc(merchantId).get();
    const merchant = merchantSnap.data() ?? {};
    const [subscription, activeCount] = await Promise.all([
      this.readSubscription(merchantId, merchant),
      this.countActiveOrders(merchantId),
    ]);
    return {
      ...evaluateSubscription(merchant, subscription, activeCount, 1, Date.now()),
      merchantId,
      serverTimeMs: Date.now(),
    };
  }

  async validateMerchantSubscription(
    merchantId: string,
    requestedCaptains: number
  ): Promise<Record<string, unknown>> {
    const safeRequested = Math.max(1, Math.min(8, Math.floor(requestedCaptains || 1)));
    const merchantSnap = await this.db.collection("merchants").doc(merchantId).get();
    const merchant = merchantSnap.data() ?? {};
    const [subscription, activeCount] = await Promise.all([
      this.readSubscription(merchantId, merchant),
      this.countActiveOrders(merchantId),
    ]);
    const result = evaluateSubscription(merchant, subscription, activeCount, safeRequested, Date.now());
    return {...result, allowed: result.isValid, requestedCaptains: safeRequested, merchantId, serverTimeMs: Date.now()};
  }

  async requestCaptains(
    merchantId: string,
    payload: Record<string, unknown>,
    actionName: "requestCaptains" | "createOrderWithCode"
  ): Promise<Record<string, unknown>> {
    const suppliedMerchantId = stringValue(payload, "merchantId", "restaurantId");
    if (suppliedMerchantId && suppliedMerchantId !== merchantId) {
      throw new HttpsError("permission-denied", "لا يمكنك إنشاء طلب لحساب تاجر آخر.");
    }
    const requestId = stringValue(payload, "requestId", "idempotencyKey") || randomBytes(8).toString("hex");
    const idempotencyKey = stringValue(payload, "idempotencyKey") || requestId;
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
      throw new HttpsError("invalid-argument", "مفتاح الطلب غير صالح. يرجى إعادة المحاولة.");
    }
    const destinationAddress = stringValue(payload, "destinationAddress", "address", "deliveryAddress");
    if (!destinationAddress || destinationAddress.length > 500) {
      throw new HttpsError("invalid-argument", "بيانات عنوان العميل غير مكتملة. يرجى إدخال عنوان التوصيل.");
    }
    const requested = Number(payload.requestedCaptains ?? 1);
    if (requested !== 1) {
      throw new HttpsError("invalid-argument", "يتم إنشاء طلب واحد لكل كابتن. أرسل طلباً منفصلاً لكل كابتن.");
    }

    const feeText = stringValue(payload, "serviceFee", "price") || "30 جنيه";
    const deliveryFee = parseDeliveryFee(feeText);
    if (deliveryFee === null) {
      throw new HttpsError("invalid-argument", "قيمة أجرة التوصيل غير صالحة. أدخل مبلغاً رقمياً مثل 30 جنيه.");
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const orderCode = randomSixDigitCode();
      const orderId = `${Date.now()}_${orderCode}_${randomBytes(3).toString("hex")}`;
      const orderRef = this.db.collection("orders").doc(orderId);
      const merchantRef = this.db.collection("merchants").doc(merchantId);
      const subRef = this.db.collection("subscriptions").doc(merchantId);
      const capacityRef = merchantRef.collection("capacity").doc("current");
      const codeRef = this.db.collection("order_codes").doc(orderCode);
      const keyRef = this.db.collection("idempotency_keys").doc(idempotencyKey);

      try {
        const outcome = await this.db.runTransaction(async (transaction) => {
          const [
            merchantSnap, subSnap, capacitySnap, codeSnap, keySnap,
            ordersByMerchant, ordersByRestaurant, ordersByUser,
            subsByMerchant, subsByRestaurant, subsByUser,
          ] = await Promise.all([
            transaction.get(merchantRef),
            transaction.get(subRef),
            transaction.get(capacityRef),
            transaction.get(codeRef),
            transaction.get(keyRef),
            transaction.get(this.db.collection("orders").where("merchantId", "==", merchantId)),
            transaction.get(this.db.collection("orders").where("restaurantId", "==", merchantId)),
            transaction.get(this.db.collection("orders").where("userId", "==", merchantId)),
            transaction.get(this.db.collection("subscriptions").where("merchantId", "==", merchantId)),
            transaction.get(this.db.collection("subscriptions").where("restaurantId", "==", merchantId)),
            transaction.get(this.db.collection("subscriptions").where("userId", "==", merchantId)),
          ]);

          if (keySnap.exists) {
            const keyData = keySnap.data() ?? {};
            if (keyData.merchantId !== merchantId) {
              throw new HttpsError("permission-denied", "مفتاح الطلب مستخدم بواسطة حساب آخر.");
            }
            return {
              replay: true,
              orderId: String(keyData.orderId ?? ""),
              orderCode: String(keyData.orderCode ?? ""),
              activeCaptainsCount: Number(keyData.activeCaptainsCount ?? 0),
              captainLimit: Number(keyData.captainLimit ?? 0),
              planId: Number(keyData.planId ?? 0),
              planName: String(keyData.planName ?? ""),
              subscriptionVersion: Number(keyData.subscriptionVersion ?? 1),
            };
          }
          if (codeSnap.exists) throw new Error("ORDER_CODE_COLLISION");
          if (!merchantSnap.exists || !isMerchantAccount(merchantSnap.data())) {
            throw new HttpsError("not-found", "تعذر العثور على بيانات حساب التاجر.");
          }

          const merchant = merchantSnap.data() ?? {};
          const merchantStatus = stringValue(merchant, "status").toLowerCase();
          const isApproved = ["approved", "active"].includes(merchantStatus) ||
            (!merchantStatus && merchant.isApproved === true);
          if (!isApproved || merchant.isBlocked === true || merchant.isSuspended === true) {
            throw new HttpsError("failed-precondition", "حساب التاجر في انتظار موافقة الإدارة أو موقوف.");
          }

          const fallbackSubscriptions = [
            ...subsByMerchant.docs,
            ...subsByRestaurant.docs,
            ...subsByUser.docs,
          ].filter((doc) => doc.id !== merchantId).map((doc) => doc.data());
          const subscription = selectSubscription(
            subSnap.exists ? subSnap.data() : undefined,
            fallbackSubscriptions,
            merchant
          );

          const orderSets = collectOrders([ordersByMerchant, ordersByRestaurant, ordersByUser]);
          const capacityData = capacitySnap.data() ?? {};
          const storedIds = Array.isArray(capacityData.reservedOrderIds)
            ? capacityData.reservedOrderIds.map((id: unknown) => String(id)).filter(Boolean)
            : [];
          const effectiveIds = new Set<string>(orderSets.activeIds);
          for (const id of storedIds) {
            if (!orderSets.finishedIds.has(id) && orderSets.allIds.has(id)) effectiveIds.add(id);
          }
          const activeCount = effectiveIds.size;
          const verification = evaluateSubscription(merchant, subscription, activeCount, 1, Date.now());
          if (!verification.isValid) {
            throw new HttpsError(
              verification.status === "not_found" ? "not-found" : "failed-precondition",
              verification.errorMessage || "الاشتراك غير متاح لإنشاء الطلب.",
              {reasonCode: verification.status, requestId}
            );
          }
          if (activeCount + 1 > verification.captainLimit) {
            throw new HttpsError("resource-exhausted", `وصلت إلى الحد الأقصى لعدد الكباتن المتزامنين في باقتك (${verification.captainLimit}).`);
          }

          const merchantName = stringValue(merchant, "name") || "تاجر";
          const merchantPhone = stringValue(merchant, "phone") || stringValue(payload, "merchantPhone");
          const storeImage = stringValue(merchant, "logo", "photoUrl", "logoUrl", "imageUrl");
          const storeImagePath = stringValue(merchant, "storagePath", "profileStoragePath");
          if (!merchantName || !merchantPhone || (!storeImage && !storeImagePath)) {
            throw new HttpsError("failed-precondition", "بيانات اسم التاجر أو هاتفه أو صورته غير مكتملة. حدّث بيانات المتجر أولاً.");
          }
          const coords = readMerchantCoordinates(merchant, payload);
          if (!coords) {
            throw new HttpsError("failed-precondition", "لم يتم حفظ موقع المتجر. حدّث موقع التاجر قبل طلب الكابتن.");
          }

          const reservedIds = [...effectiveIds, orderId];
          const now = FieldValue.serverTimestamp();
          transaction.set(capacityRef, {
            merchantId,
            reservedOrderIds: reservedIds,
            activeReservationsCount: reservedIds.length,
            captainLimitSnapshot: verification.captainLimit,
            capacityVersion: FieldValue.increment(1),
            lastReservedOrderId: orderId,
            updatedAt: now,
          }, {merge: true});

          transaction.set(codeRef, {
            code: orderCode,
            orderCode,
            orderId,
            merchantId,
            createdAt: now,
          });

          const merchantLocation = new GeoPoint(coords.lat, coords.lng);
          const customerLat = numberValue(payload, "customerLatitude");
          const customerLng = numberValue(payload, "customerLongitude");
          const order: Record<string, unknown> = {
            orderId,
            orderCode,
            code: orderCode,
            address: destinationAddress,
            destinationAddress,
            deliveryAddress: destinationAddress,
            pickupAddress: stringValue(merchant, "address") || "موقع التاجر",
            storeAddress: stringValue(merchant, "address") || "موقع التاجر",
            price: feeText,
            serviceFee: feeText,
            totalAmount: feeText,
            deliveryFee,
            orderTotalAmount: deliveryFee,
            customerName: stringValue(payload, "customerName"),
            customerPhone: stringValue(payload, "customerPhone"),
            orderDetails: stringValue(payload, "orderDetails", "items"),
            items: stringValue(payload, "orderDetails", "items"),
            itemsSummary: stringValue(payload, "orderDetails", "items") || "طلب توصيل جديد",
            itemsCount: 1,
            deliveryNotes: stringValue(payload, "deliveryNotes", "notes"),
            notes: stringValue(payload, "deliveryNotes", "notes"),
            status: "pending",
            dispatchStatus: "searching",
            merchantId,
            userId: merchantId,
            restaurantId: merchantId,
            merchantName,
            storeName: merchantName,
            merchantPhone,
            storePhone: merchantPhone,
            merchantLogo: storeImage,
            storeImage,
            storeImagePath,
            merchantStoragePath: storeImagePath,
            storeLocationUrl: stringValue(merchant, "locationUrl", "locationLink", "mapLink"),
            locationUrl: stringValue(merchant, "locationUrl", "locationLink", "mapLink"),
            merchantLocation,
            pickupLocation: merchantLocation,
            merchantLatitude: coords.lat,
            merchantLongitude: coords.lng,
            captainId: null,
            driver_name: null,
            captainName: null,
            captainPhone: null,
            captainPhotoUrl: null,
            customerDetailsSubmitted: false,
            customerDetailsConfirmed: false,
            customerDetailsRejected: false,
            capacityReserved: true,
            capacityReleased: false,
            capacityReservedAt: now,
            createdByServerFunction: actionName,
            subscriptionVersionAtCreation: verification.subscriptionVersion,
            createdAt: now,
            created_at: now,
            updatedAt: now,
          };
          if (customerLat !== null && customerLng !== null &&
              customerLat >= -90 && customerLat <= 90 &&
              customerLng >= -180 && customerLng <= 180 &&
              !(customerLat === 0 && customerLng === 0)) {
            order.customerLocation = new GeoPoint(customerLat, customerLng);
            order.customerLatitude = customerLat;
            order.customerLongitude = customerLng;
          }
          transaction.set(orderRef, order);
          transaction.set(keyRef, {
            idempotencyKey,
            orderId,
            orderCode,
            merchantId,
            activeCaptainsCount: reservedIds.length,
            captainLimit: verification.captainLimit,
            planId: verification.planId,
            planName: verification.planName,
            subscriptionVersion: verification.subscriptionVersion,
            createdAt: now,
          });

          return {
            replay: false,
            orderId,
            orderCode,
            activeCaptainsCount: reservedIds.length,
            captainLimit: verification.captainLimit,
            planId: verification.planId,
            planName: verification.planName,
            subscriptionVersion: verification.subscriptionVersion,
          };
        });

        return {
          success: true,
          orderId: outcome.orderId,
          orderCode: outcome.orderCode,
          status: "pending",
          planId: outcome.planId,
          planName: outcome.planName,
          captainLimit: outcome.captainLimit,
          activeCaptainsCount: outcome.activeCaptainsCount,
          remainingCaptains: Math.max(0, outcome.captainLimit - outcome.activeCaptainsCount),
          subscriptionVersion: outcome.subscriptionVersion,
          isReplay: outcome.replay,
          requestId,
          message: outcome.replay ? "تم استرجاع بيانات الطلب المنشأ مسبقاً بنجاح." : "تم إنشاء طلب التوصيل بنجاح",
        };
      } catch (error) {
        if (error instanceof HttpsError) throw error;
        const code = String((error as {code?: unknown; message?: unknown})?.code ?? "");
        const message = String((error as {message?: unknown})?.message ?? "");
        if (message === "ORDER_CODE_COLLISION" || code === "10" || code.toLowerCase() === "aborted") continue;
        throw new HttpsError("internal", "تعذر إنشاء الطلب على السيرفر حالياً، يرجى المحاولة مرة أخرى.", {requestId});
      }
    }
    throw new HttpsError("resource-exhausted", "تعذر تخصيص كود طلب غير مكرر حالياً، يرجى المحاولة بعد لحظات.", {requestId});
  }

  async releaseTerminalOrderCapacity(orderId: string, merchantId: string): Promise<void> {
    if (!merchantId) return;
    const orderRef = this.db.collection("orders").doc(orderId);
    const capacityRef = this.db.collection("merchants").doc(merchantId).collection("capacity").doc("current");
    await this.db.runTransaction(async (transaction) => {
      const [orderSnap, capacitySnap] = await Promise.all([
        transaction.get(orderRef),
        transaction.get(capacityRef),
      ]);
      if (!orderSnap.exists) return;
      const order = orderSnap.data() ?? {};
      const status = stringValue(order, "status", "order_status", "orderStatus").toLowerCase();
      if (!isActiveOrder(order) || order.capacityReleased === true) return;
      const capacity = capacitySnap.data() ?? {};
      const reserved = Array.isArray(capacity.reservedOrderIds)
        ? capacity.reservedOrderIds.map((id: unknown) => String(id)).filter((id) => id && id !== orderId)
        : [];
      transaction.update(orderRef, {
        capacityReleased: true,
        capacityReleasedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (capacitySnap.exists) {
        transaction.set(capacityRef, {
          reservedOrderIds: reserved,
          activeReservationsCount: reserved.length,
          capacityVersion: FieldValue.increment(1),
          lastReleasedOrderId: orderId,
          updatedAt: FieldValue.serverTimestamp(),
          terminalStatusAtRelease: status,
        }, {merge: true});
      }
    });
  }
}

export function isTerminalOrderStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return TERMINAL_ORDER_STATUSES.has(normalized) ||
    normalized.includes("تم التسليم") ||
    normalized.includes("تم التوصيل") ||
    normalized.includes("تم الإلغاء") ||
    normalized.includes("تم الالغاء") ||
    normalized.includes("مكتمل") ||
    normalized.includes("مرفوض");
}
