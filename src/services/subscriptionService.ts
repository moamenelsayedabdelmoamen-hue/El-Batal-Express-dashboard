import {
  collection,
  doc,
  getDocs,
} from 'firebase/firestore';
import { db, functions, isFirebaseConfigured, handleFirestoreError, OperationType } from '../firebase/config';
import { httpsCallable } from 'firebase/functions';
import { COLLECTIONS } from './collections';
import { Subscription, SubscriptionStatus } from '../types';

let localSubscriptionsCache: Subscription[] = [];

function createAdminSubIdempotencyKey(operation: string, merchantId: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return `${operation}_${merchantId}_${rand}`;
}

function parseFirestoreDateToYMD(val: any): string {
  if (!val) return '';
  try {
    if (typeof val?.toDate === 'function') {
      return val.toDate().toISOString().split('T')[0];
    }
    if (typeof val === 'object' && typeof val.seconds === 'number') {
      return new Date(val.seconds * 1000).toISOString().split('T')[0];
    }
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
      const d = new Date(trimmed);
      if (!isNaN(d.getTime())) {
        return d.toISOString().split('T')[0];
      }
    }
    if (typeof val === 'number') {
      return new Date(val).toISOString().split('T')[0];
    }
  } catch {
    // ignore
  }
  return '';
}

function computeInclusiveEndYMD(ymd: string, days: number): string {
  const safeDays = Math.max(1, Math.round(days || 30));
  try {
    const base = ymd ? new Date(`${ymd}T00:00:00.000Z`) : new Date();
    if (isNaN(base.getTime())) {
      return new Date(Date.now() + (safeDays - 1) * 86400000).toISOString().split('T')[0];
    }
    base.setUTCDate(base.getUTCDate() + (safeDays - 1));
    return base.toISOString().split('T')[0];
  } catch {
    return new Date(Date.now() + (safeDays - 1) * 86400000).toISOString().split('T')[0];
  }
}

function normalizePlanAndPrice(data: Record<string, any>): {
  captainsCount: number;
  price: number;
  plan: string;
} {
  const subObj = typeof data.subscription === 'object' && data.subscription ? data.subscription : {};
  let captainsCount =
    Number(
      data.maxCaptains ??
        data.captainLimit ??
        data.captainsCount ??
        subObj.maxCaptains ??
        subObj.captainLimit ??
        subObj.captainsCount ??
        data.allowedCaptains ??
        0
    ) || 0;

  const price =
    Number(
      data.price ??
        data.subscriptionPrice ??
        subObj.price ??
        subObj.amount ??
        data.amount ??
        0
    ) || 0;

  const rawPlanStr = String(
    data.planName ||
      data.packageName ||
      data.plan ||
      data.subscriptionPlan ||
      subObj.planName ||
      subObj.plan ||
      ''
  ).trim();

  if (!captainsCount && rawPlanStr) {
    const numMatch = rawPlanStr.match(/(\d+)/);
    if (numMatch) {
      const parsed = Number(numMatch[1]);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 100) {
        captainsCount = parsed;
      }
    }
  }

  const planLabel =
    rawPlanStr ||
    (captainsCount > 0 ? `باقة ${captainsCount} كابتن` : 'باقة غير محددة');

  return {
    captainsCount,
    price,
    plan: planLabel,
  };
}

function normalizeStatus(rawStatus: any, endDateYMD?: string, isActiveMerchant?: boolean): SubscriptionStatus {
  const s = String(rawStatus || '').trim().toLowerCase();
  if (s === 'active' || s === 'approved' || s === 'نشط' || s === 'ساري') {
    if (endDateYMD && endDateYMD < new Date().toISOString().split('T')[0]) {
      return 'Expired';
    }
    return 'Active';
  }
  if (s === 'cancelled' || s === 'canceled' || s === 'ملغي') return 'Cancelled';
  if (
    s === 'pending' ||
    s === 'pending_review' ||
    s === 'under_review' ||
    s === 'resubmission_required' ||
    s === 'معلق' ||
    s === 'قيد الانتظار'
  ) {
    return 'Pending';
  }
  if (s === 'expired' || s === 'منتهي') return 'Expired';
  if (s === 'suspended' || s === 'موقوف' || s === 'inactive' || s === 'rejected') return 'Suspended';

  if (endDateYMD && endDateYMD < new Date().toISOString().split('T')[0]) return 'Expired';
  if (isActiveMerchant === true) return 'Active';
  return 'Suspended';
}

function mapDocToSubscription(
  id: string,
  data: Record<string, any>,
  merchantDoc?: { id: string; data: Record<string, any> }
): Subscription {
  const mData = merchantDoc?.data || {};
  const subObj = typeof data.subscription === 'object' && data.subscription ? data.subscription : {};
  const mSubObj = typeof mData.subscription === 'object' && mData.subscription ? mData.subscription : {};

  const restaurantId =
    data.restaurantId ||
    data.merchantId ||
    data.restaurant?.id ||
    merchantDoc?.id ||
    id;

  const restaurantName =
    data.restaurantName ||
    data.merchantName ||
    data.restaurant?.name ||
    mData.name ||
    mData.nameAr ||
    mData.merchantName ||
    mData.restaurantName ||
    'تاجر غير محدد';

  const merchantLogo =
    data.merchantLogo ||
    data.logo ||
    mData.logo ||
    mData.logoUrl ||
    mData.image ||
    mData.photoURL ||
    '';

  const merchantPhone = data.merchantPhone || data.phone || mData.phone || mData.phoneNumber || '';
  const merchantEmail = data.merchantEmail || data.email || mData.ownerEmail || mData.email || '';

  const combinedData = { ...mSubObj, ...mData, ...subObj, ...data };
  const { captainsCount, price, plan } = normalizePlanAndPrice(combinedData);

  const startDate =
    parseFirestoreDateToYMD(
      data.startDate ||
        data.subscriptionStartDate ||
        subObj.startDate ||
        mData.subscriptionStartDate ||
        mData.startDate ||
        mSubObj.startDate ||
        data.createdAt ||
        mData.createdAt
    ) || new Date().toISOString().split('T')[0];

  const resolvedDurationDays = Math.max(1, Number(data.durationDays || subObj.durationDays || 30) || 30);
  const endDate =
    parseFirestoreDateToYMD(
      data.endDate ||
        data.subscriptionEndDate ||
        data.expiryDate ||
        data.expiresAt ||
        subObj.endDate ||
        subObj.expiresAt ||
        mData.subscriptionEndDate ||
        mData.endDate ||
        mData.expiryDate ||
        mData.expiresAt ||
        mSubObj.endDate ||
        mSubObj.expiresAt
    ) || computeInclusiveEndYMD(startDate, resolvedDurationDays);

  const rawStatus =
    data.status ||
    data.subscriptionStatus ||
    subObj.status ||
    mData.subscriptionStatus ||
    mSubObj.status;

  const hasActiveSubscription =
    data.isSubscribed === true ||
    data.isActive === true ||
    subObj.isActive === true ||
    mData.isSubscribed === true ||
    mSubObj.isSubscribed === true;

  const status = normalizeStatus(rawStatus, endDate, hasActiveSubscription);
  const rawPayMethod = String(data.paymentMethodLabel || data.paymentMethod || '').trim();
  const paymentMethod =
    rawPayMethod === 'vodafone_cash' || rawPayMethod === 'vodafone_cash_manual'
      ? 'فودافون كاش'
      : rawPayMethod === 'admin_manual'
        ? 'تفعيل إداري يدوي'
        : rawPayMethod === 'cash'
          ? 'كاش نقدي'
          : rawPayMethod === 'instapay'
            ? 'إنستا باي'
            : rawPayMethod === 'bank_transfer'
              ? 'تحويل بنكي'
              : rawPayMethod || 'يدوي';

  return {
    id,
    subscriptionNumber:
      String(data.subscriptionNumber || '').trim() ||
      `SUB-${String(restaurantId || id).slice(0, 6).toUpperCase()}-V${Number(data.subscriptionVersion || 1)}`,
    restaurantId,
    restaurantName,
    merchantLogo,
    merchantPhone,
    merchantEmail,
    planId: data.planId ?? undefined,
    planKey: String(data.planKey || data.packageId || (typeof data.planId === 'string' ? data.planId : '') || ''),
    plan: String(data.planName || data.packageName || plan),
    captainsCount,
    price,
    durationDays: Number(data.durationDays || 30) || 30,
    startDate,
    endDate,
    status,
    paymentMethod,
    paymentStatus: String(data.paymentStatus || ''),
    lastPaymentId: data.lastPaymentId ? String(data.lastPaymentId) : undefined,
    lastRequestId: data.lastRequestId ? String(data.lastRequestId) : undefined,
    subscriptionVersion: Number(data.subscriptionVersion || 1) || 1,
    isHistorical: data.isHistorical === true,
    archivedReason: data.archivedReason ? String(data.archivedReason) : undefined,
    archivedAt: parseFirestoreDateToYMD(data.archivedAt || data.archivedAtMs) || undefined,
    raw: data,
  };
}


async function callAdminSubscription(payload: Record<string, unknown>): Promise<unknown> {
  if (!isFirebaseConfigured || !functions) {
    throw new Error("خدمة الاشتراكات الإدارية غير متاحة حالياً.");
  }
  const callable = httpsCallable<Record<string, unknown>, unknown>(
    functions,
    "adminManageMerchantSubscription"
  );
  const response = await callable(payload);
  return response.data;
}

export const SubscriptionService = {
  async getAll(): Promise<{ data: Subscription[]; isLive: boolean }> {
    if (!isFirebaseConfigured) {
      return { data: localSubscriptionsCache, isLive: false };
    }

    try {
      // Fetch current subscriptions, historical archived periods, restaurants, and merchants in parallel
      const [subsSnap, historySnap, restResult, merchResult] = await Promise.all([
        getDocs(collection(db, COLLECTIONS.SUBSCRIPTIONS)),
        getDocs(collection(db, COLLECTIONS.SUBSCRIPTION_HISTORY)).catch(() => null),
        getDocs(collection(db, COLLECTIONS.RESTAURANTS)).catch(() => null),
        getDocs(collection(db, COLLECTIONS.MERCHANTS)).catch(() => null),
      ]);

      const merchantsById = new Map<string, Record<string, any>>();
      const merchantsByName = new Map<string, { id: string; data: Record<string, any> }>();

      const registerMerchantDoc = (id: string, d: Record<string, any>) => {
        const existing = merchantsById.get(id);
        const merged = existing ? { ...d, ...existing } : d;
        merchantsById.set(id, merged);
        const nameKey = String(
          merged.name || merged.nameAr || merged.merchantName || merged.storeName || merged.restaurantName || ''
        )
          .trim()
          .toLowerCase();
        if (nameKey) {
          merchantsByName.set(nameKey, { id, data: merged });
        }
      };

      if (restResult) {
        restResult.forEach((docSnap) => {
          registerMerchantDoc(docSnap.id, docSnap.data());
        });
      }
      if (merchResult) {
        merchResult.forEach((docSnap) => {
          registerMerchantDoc(docSnap.id, docSnap.data());
        });
      }

      const list: Subscription[] = [];
      const resolveMerchantForDoc = (docId: string, subData: Record<string, any>) => {
        const restId = subData.restaurantId || subData.merchantId || subData.restaurant?.id || '';
        const restNameKey = String(subData.restaurantName || subData.merchantName || '')
          .trim()
          .toLowerCase();
        if (restId && merchantsById.has(restId)) {
          return { id: restId, data: merchantsById.get(restId)! };
        }
        if (merchantsById.has(docId)) {
          return { id: docId, data: merchantsById.get(docId)! };
        }
        if (restNameKey && merchantsByName.has(restNameKey)) {
          return merchantsByName.get(restNameKey);
        }
        return undefined;
      };

      // 1. Map current subscription documents
      subsSnap.forEach((docSnap) => {
        const subData = docSnap.data();
        if (typeof subData.migratedToMerchantId === 'string' && subData.migratedToMerchantId) {
          return;
        }
        const matchedMerchant = resolveMerchantForDoc(docSnap.id, subData);
        list.push(mapDocToSubscription(docSnap.id, { ...subData, isHistorical: false }, matchedMerchant));
      });

      // 2. Map archived historical subscription periods so renewal never hides past records
      if (historySnap) {
        historySnap.forEach((docSnap) => {
          const histData = docSnap.data();
          const matchedMerchant = resolveMerchantForDoc(docSnap.id, histData);
          list.push(mapDocToSubscription(docSnap.id, { ...histData, isHistorical: true }, matchedMerchant));
        });
      }

      // Sort current active subscriptions first, then newest startDate descending
      list.sort((a, b) => {
        if (Boolean(a.isHistorical) !== Boolean(b.isHistorical)) {
          return a.isHistorical ? 1 : -1;
        }
        return (b.startDate || '').localeCompare(a.startDate || '');
      });

      localSubscriptionsCache = list;
      return { data: list, isLive: true };
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, COLLECTIONS.SUBSCRIPTIONS);
      return { data: localSubscriptionsCache, isLive: false };
    }
  },

  async updateStatus(id: string, status: SubscriptionStatus, restaurantId?: string): Promise<void> {
    const targetSub = localSubscriptionsCache.find((sub) => sub.id === id);
    const merchantId = restaurantId || targetSub?.restaurantId || id;
    try {
      await callAdminSubscription({
        operation: "status",
        merchantId,
        legacySubscriptionId: id !== merchantId ? id : undefined,
        status,
      });
      localSubscriptionsCache = localSubscriptionsCache.map((sub) =>
        sub.id === id || sub.restaurantId === merchantId ? { ...sub, status } : sub
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `${COLLECTIONS.SUBSCRIPTIONS}/${merchantId}`);
      throw error;
    }
  },

  async updateSubscription(
    id: string,
    updates: {
      restaurantId?: string;
      restaurantName?: string;
      planId?: string;
      captainsCount: number;
      price: number;
      plan: string;
      startDate: string;
      endDate: string;
      status: SubscriptionStatus;
    }
  ): Promise<void> {
    const existing = localSubscriptionsCache.find((sub) => sub.id === id);
    const merchantId = updates.restaurantId || existing?.restaurantId || id;
    try {
      await callAdminSubscription({
        operation: "upsert",
        merchantId,
        legacySubscriptionId: id !== merchantId ? id : undefined,
        planId: updates.planId,
        maxCaptains: updates.captainsCount,
        price: updates.price,
        startDate: updates.startDate,
        endDate: updates.endDate,
        status: updates.status,
        idempotencyKey: createAdminSubIdempotencyKey("upsert", merchantId),
      });
      localSubscriptionsCache = localSubscriptionsCache.map((sub) =>
        sub.id === id || (sub.restaurantId === merchantId && !sub.isHistorical)
          ? { ...sub, ...updates, id: merchantId, restaurantId: merchantId }
          : sub
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `${COLLECTIONS.SUBSCRIPTIONS}/${merchantId}`);
      throw error;
    }
  },

  async create(data: Omit<Subscription, 'id'> & { planId?: string }): Promise<Subscription> {
    const merchantId = String(data.restaurantId || "").trim();
    if (!merchantId) throw new Error("يجب اختيار حساب تاجر مسجل قبل إنشاء الاشتراك.");
    try {
      await callAdminSubscription({
        operation: "upsert",
        merchantId,
        planId: data.planId || data.planKey,
        maxCaptains: data.captainsCount,
        price: data.price,
        startDate: data.startDate,
        endDate: data.endDate,
        status: data.status,
        idempotencyKey: createAdminSubIdempotencyKey("create", merchantId),
      });
      const newSub: Subscription = { ...data, id: merchantId, restaurantId: merchantId, isHistorical: false };
      localSubscriptionsCache = [
        newSub,
        ...localSubscriptionsCache.filter((sub) => sub.id !== merchantId),
      ];
      return newSub;
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `${COLLECTIONS.SUBSCRIPTIONS}/${merchantId}`);
      throw error;
    }
  },

  async renew(id: string): Promise<string> {
    const existing = localSubscriptionsCache.find((sub) => sub.id === id);
    const merchantId = existing?.restaurantId || id;
    try {
      const result = await callAdminSubscription({
        operation: "renew",
        merchantId,
        planId: existing?.planKey,
        legacySubscriptionId: id !== merchantId ? id : undefined,
        idempotencyKey: createAdminSubIdempotencyKey("renew", merchantId),
      });
      const endDate = String((result as any)?.endDate || "");
      localSubscriptionsCache = localSubscriptionsCache.map((sub) =>
        sub.id === id || (sub.restaurantId === merchantId && !sub.isHistorical)
          ? { ...sub, id: merchantId, restaurantId: merchantId, status: "Active", endDate }
          : sub
      );
      return endDate;
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `${COLLECTIONS.SUBSCRIPTIONS}/${merchantId}`);
      throw error;
    }
  },

  async delete(id: string): Promise<void> {
    const existing = localSubscriptionsCache.find((sub) => sub.id === id);
    const merchantId = existing?.restaurantId || id;
    try {
      await callAdminSubscription({
        operation: "delete",
        merchantId,
        legacySubscriptionId: id !== merchantId ? id : undefined,
      });
      localSubscriptionsCache = localSubscriptionsCache.map((sub) =>
        sub.id === id || (sub.restaurantId === merchantId && !sub.isHistorical)
          ? { ...sub, status: "Cancelled" }
          : sub
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `${COLLECTIONS.SUBSCRIPTIONS}/${merchantId}`);
      throw error;
    }
  },
};
