import {
  collection,
  doc,
  getDocs,
} from 'firebase/firestore';
import { db, functions, isFirebaseConfigured, handleFirestoreError, OperationType } from '../firebase/config';
import { httpsCallable } from 'firebase/functions';
import { COLLECTIONS, SUBSCRIPTION_PLANS } from './collections';
import { Subscription, SubscriptionStatus } from '../types';

let localSubscriptionsCache: Subscription[] = [];

export const OFFICIAL_PACKAGES = [
  { captainsCount: 2, price: 400, label: '2 كابتن - 400 جنيه' },
  { captainsCount: 4, price: 800, label: '4 كابتن - 800 جنيه' },
  { captainsCount: 6, price: 1200, label: '6 كابتن - 1200 جنيه' },
  { captainsCount: 8, price: 1600, label: '8 كابتن - 1600 جنيه' },
] as const;

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

function addDaysToYMD(ymd: string, days: number): string {
  try {
    const base = ymd ? new Date(ymd) : new Date();
    if (isNaN(base.getTime())) {
      return new Date(Date.now() + days * 86400000).toISOString().split('T')[0];
    }
    base.setDate(base.getDate() + days);
    return base.toISOString().split('T')[0];
  } catch {
    return new Date(Date.now() + days * 86400000).toISOString().split('T')[0];
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
      data.captainsCount ??
        subObj.captainsCount ??
        data.maxCaptains ??
        data.allowedCaptains ??
        0
    ) || 0;

  let price =
    Number(
      data.price ??
        data.subscriptionPrice ??
        subObj.price ??
        subObj.amount ??
        data.amount ??
        0
    ) || 0;

  const rawPlanStr = String(data.plan || data.subscriptionPlan || subObj.plan || '');

  if (!captainsCount) {
    if (rawPlanStr.includes('8') || price === 1600) captainsCount = 8;
    else if (rawPlanStr.includes('6') || price === 1200) captainsCount = 6;
    else if (rawPlanStr.includes('4') || price === 800) captainsCount = 4;
    else captainsCount = 2;
  }

  // Match with the 4 official packages: 2->400, 4->800, 6->1200, 8->1600
  const matchedPkg = OFFICIAL_PACKAGES.find((p) => p.captainsCount === captainsCount);
  if (!price && matchedPkg) {
    price = matchedPkg.price;
  } else if (matchedPkg && (price === 600 || price === 700 || price === 1000)) {
    // Upgrade legacy default prices to the current official package prices
    price = matchedPkg.price;
  }

  const planLabel = matchedPkg
    ? matchedPkg.label
    : rawPlanStr || `${captainsCount} كابتن - ${price} جنيه`;

  return {
    captainsCount,
    price: price || 400,
    plan: planLabel,
  };
}

function normalizeStatus(rawStatus: any, endDateYMD?: string, isActiveMerchant?: boolean): SubscriptionStatus {
  const s = String(rawStatus || '').trim();
  if (s === 'Active' || s === 'active' || s === 'نشط' || s === 'ساري') {
    if (endDateYMD && endDateYMD < new Date().toISOString().split('T')[0]) {
      return 'Expired';
    }
    return 'Active';
  }
  if (s === 'Pending' || s === 'pending' || s === 'معلق' || s === 'قيد الانتظار') return 'Pending';
  if (s === 'Expired' || s === 'expired' || s === 'منتهي') return 'Expired';
  if (s === 'Suspended' || s === 'suspended' || s === 'موقوف' || s === 'inactive') return 'Suspended';

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
    ) || addDaysToYMD(startDate, 30);

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

  return {
    id,
    restaurantId,
    restaurantName,
    merchantLogo,
    merchantPhone,
    merchantEmail,
    plan,
    captainsCount,
    price,
    startDate,
    endDate,
    status,
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
  plans: SUBSCRIPTION_PLANS,

  async getAll(): Promise<{ data: Subscription[]; isLive: boolean }> {
    if (!isFirebaseConfigured) {
      return { data: localSubscriptionsCache, isLive: false };
    }

    try {
      // Fetch subscriptions, restaurants, and merchants in parallel
      const [subsSnap, restResult, merchResult] = await Promise.all([
        getDocs(collection(db, COLLECTIONS.SUBSCRIPTIONS)),
        getDocs(collection(db, COLLECTIONS.RESTAURANTS)),
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

      restResult.forEach((docSnap) => {
        registerMerchantDoc(docSnap.id, docSnap.data());
      });
      if (merchResult) {
        merchResult.forEach((docSnap) => {
          registerMerchantDoc(docSnap.id, docSnap.data());
        });
      }

      const list: Subscription[] = [];
      const coveredMerchantIds = new Set<string>();

      // 1. Map existing subscription documents
      subsSnap.forEach((docSnap) => {
        const subData = docSnap.data();
        if (typeof subData.migratedToMerchantId === 'string' && subData.migratedToMerchantId) {
          coveredMerchantIds.add(subData.migratedToMerchantId);
          return;
        }
        const restId = subData.restaurantId || subData.merchantId || subData.restaurant?.id || '';
        const restNameKey = String(subData.restaurantName || subData.merchantName || '')
          .trim()
          .toLowerCase();

        let matchedMerchant: { id: string; data: Record<string, any> } | undefined;
        if (restId && merchantsById.has(restId)) {
          matchedMerchant = { id: restId, data: merchantsById.get(restId)! };
        } else if (merchantsById.has(docSnap.id)) {
          matchedMerchant = { id: docSnap.id, data: merchantsById.get(docSnap.id)! };
        } else if (restNameKey && merchantsByName.has(restNameKey)) {
          matchedMerchant = merchantsByName.get(restNameKey);
        }

        if (matchedMerchant) {
          coveredMerchantIds.add(matchedMerchant.id);
        } else if (restId) {
          coveredMerchantIds.add(restId);
        }

        list.push(mapDocToSubscription(docSnap.id, subData, matchedMerchant));
      });

      // Merchant accounts without a canonical subscriptions/{uid} record are not subscriptions.
      // They remain selectable in the Add Subscription form through RestaurantService.
      // Sort newest startDate first
      list.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));

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
        maxCaptains: updates.captainsCount,
        price: updates.price,
        startDate: updates.startDate,
        endDate: updates.endDate,
        status: updates.status,
      });
      localSubscriptionsCache = localSubscriptionsCache.map((sub) =>
        sub.id === id || sub.restaurantId === merchantId
          ? { ...sub, ...updates, id: merchantId, restaurantId: merchantId }
          : sub
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `${COLLECTIONS.SUBSCRIPTIONS}/${merchantId}`);
      throw error;
    }
  },

  async create(data: Omit<Subscription, 'id'>): Promise<Subscription> {
    const merchantId = String(data.restaurantId || "").trim();
    if (!merchantId) throw new Error("يجب اختيار حساب تاجر مسجل قبل إنشاء الاشتراك.");
    try {
      await callAdminSubscription({
        operation: "upsert",
        merchantId,
        maxCaptains: data.captainsCount,
        price: data.price,
        startDate: data.startDate,
        endDate: data.endDate,
        status: data.status,
      });
      const newSub: Subscription = { ...data, id: merchantId, restaurantId: merchantId };
      localSubscriptionsCache = [
        newSub,
        ...localSubscriptionsCache.filter((sub) => sub.id !== merchantId && sub.restaurantId !== merchantId),
      ];
      return newSub;
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `${COLLECTIONS.SUBSCRIPTIONS}/${merchantId}`);
      throw error;
    }
  },

  async renew(id: string, days: number = 30): Promise<string> {
    const existing = localSubscriptionsCache.find((sub) => sub.id === id);
    const merchantId = existing?.restaurantId || id;
    if (days !== 30) throw new Error("التجديد من لوحة التحكم متاح لمدة 30 يوماً في الوقت الحالي.");
    try {
      const result = await callAdminSubscription({
        operation: "renew",
        merchantId,
        legacySubscriptionId: id !== merchantId ? id : undefined,
      });
      const endDate = String((result as any)?.endDate || "");
      localSubscriptionsCache = localSubscriptionsCache.map((sub) =>
        sub.id === id || sub.restaurantId === merchantId
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
        sub.id === id || sub.restaurantId === merchantId ? { ...sub, status: "Suspended" } : sub
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `${COLLECTIONS.SUBSCRIPTIONS}/${merchantId}`);
      throw error;
    }
  },
};
