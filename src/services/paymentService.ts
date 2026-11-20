import {
  collection,
  getDocs,
  addDoc,
  onSnapshot,
  serverTimestamp,
  Unsubscribe,
} from 'firebase/firestore';
import { db, isFirebaseConfigured, handleFirestoreError, OperationType } from '../firebase/config';
import { COLLECTIONS } from './collections';
import { Payment, PaymentMethod, PaymentStatus } from '../types';

let localPaymentsCache: Payment[] = [];

function toTimestampMs(val: any): number {
  if (!val) return 0;
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val < 1e12 ? val * 1000 : val;
  }
  if (typeof val?.toMillis === 'function') {
    try {
      return val.toMillis();
    } catch {
      return 0;
    }
  }
  if (typeof val?.toDate === 'function') {
    try {
      return val.toDate().getTime();
    } catch {
      return 0;
    }
  }
  if (typeof val === 'object' && typeof val.seconds === 'number') {
    return val.seconds * 1000;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return 0;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function formatLocalYmd(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function normalizePaymentStatus(data: Record<string, any>): PaymentStatus {
  const s = String(data.status || data.paymentStatus || '').trim().toLowerCase();
  if (s === 'success' || s === 'paid' || s === 'approved' || s === 'completed' || s === 'succeeded') {
    return 'success';
  }
  if (s === 'failed' || s === 'rejected' || s === 'cancelled' || s === 'declined' || s === 'error') {
    return 'failed';
  }
  if (s === 'pending' || s === 'pending_verification' || s === 'processing') {
    return 'pending';
  }
  return 'success';
}

function normalizePaymentMethod(data: Record<string, any>): PaymentMethod {
  const rawMethod = String(data.paymentMethod || '').trim();
  const methodCode = String(data.method || '').trim().toLowerCase();
  const lower = rawMethod.toLowerCase();

  if (
    methodCode === 'vodafone_cash' ||
    lower === 'vodafone cash' ||
    lower === 'vodafone_cash' ||
    lower.includes('فودافون')
  ) {
    return 'فودافون كاش (Vodafone Cash)';
  }
  if (rawMethod) return rawMethod;
  if (methodCode === 'card') return 'Visa';
  if (methodCode === 'cash') return 'كاش نقدي (Cash)';
  return 'محفظة إلكترونية (Mobile Wallet)';
}

function resolvePaymentMonthKey(payment: Payment): string {
  if (typeof payment.billingMonth === 'string' && /^\d{4}-\d{2}$/.test(payment.billingMonth.trim())) {
    return payment.billingMonth.trim();
  }
  if (typeof payment.createdAtMs === 'number' && payment.createdAtMs > 0) {
    return formatLocalYmd(payment.createdAtMs).slice(0, 7);
  }
  if (typeof payment.date === 'string' && /^\d{4}-\d{2}/.test(payment.date.trim())) {
    return payment.date.trim().slice(0, 7);
  }
  if (typeof payment.createdAt === 'string' && /^\d{4}-\d{2}/.test(payment.createdAt.trim())) {
    const parsedMs = Date.parse(payment.createdAt);
    if (Number.isFinite(parsedMs)) {
      return formatLocalYmd(parsedMs).slice(0, 7);
    }
    return payment.createdAt.trim().slice(0, 7);
  }
  return '';
}

export function mapDocToPayment(id: string, data: Record<string, any>): Payment {
  const txnId =
    data.transactionReference ||
    data.transactionId ||
    data.transactionNumber ||
    data.reference ||
    data.txnId ||
    `#TXN-${id.slice(0, 6).toUpperCase()}`;

  const createdMs =
    toTimestampMs(data.paidAtMs) ||
    toTimestampMs(data.approvedAtMs) ||
    toTimestampMs(data.createdAtMs) ||
    toTimestampMs(data.paidAt) ||
    toTimestampMs(data.approvedAt) ||
    toTimestampMs(data.createdAt) ||
    toTimestampMs(data.date) ||
    Date.now();

  const isoCreatedAt = new Date(createdMs).toISOString();
  const dateYmd =
    typeof data.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(data.date.trim())
      ? data.date.trim().slice(0, 10)
      : formatLocalYmd(createdMs);

  const billingMonth =
    typeof data.billingMonth === 'string' && /^\d{4}-\d{2}$/.test(data.billingMonth.trim())
      ? data.billingMonth.trim()
      : dateYmd.slice(0, 7);

  return {
    id,
    requestId: data.requestId ? String(data.requestId) : undefined,
    type: data.type ? String(data.type) : undefined,
    source: data.source ? String(data.source) : undefined,
    transactionId: String(txnId),
    transactionNumber: String(data.transactionNumber || txnId),
    transactionReference: data.transactionReference ? String(data.transactionReference) : undefined,
    restaurantId: String(data.merchantId || data.restaurantId || ''),
    restaurantName: String(data.restaurantName || data.merchantName || 'تاجر غير محدد'),
    merchantPhone: data.merchantPhone ? String(data.merchantPhone) : undefined,
    planId: data.planId ? String(data.planId) : undefined,
    planName: data.planName ? String(data.planName) : undefined,
    maxCaptains: data.maxCaptains !== undefined ? Number(data.maxCaptains) || undefined : undefined,
    amount: typeof data.amount === 'number' ? data.amount : Number(data.amount) || 0,
    paymentMethod: normalizePaymentMethod(data),
    senderPhone: data.senderPhone ? String(data.senderPhone) : undefined,
    receiverWalletNumber: data.receiverWalletNumber ? String(data.receiverWalletNumber) : undefined,
    receiptImagePath: data.receiptImagePath ? String(data.receiptImagePath) : undefined,
    receiptImageUrl: data.receiptImageUrl ? String(data.receiptImageUrl) : undefined,
    status: normalizePaymentStatus(data),
    paymentStatus: data.paymentStatus ? String(data.paymentStatus) : undefined,
    date: dateYmd,
    billingMonth,
    createdAt: isoCreatedAt,
    createdAtMs: createdMs,
    notes: String(data.notes || ''),
    raw: data,
  };
}

export interface PaymentRevenueMetrics {
  totalRevenue: number;
  monthlyRevenue: number;
  successfulCount: number;
  monthlySuccessfulCount: number;
  currentMonthKey: string;
}

/**
 * Single authoritative calculation for Total Revenue and Current-Month Revenue
 * shared across Dashboard ("الإيرادات الشهرية") and Payments page.
 */
export function computePaymentRevenueMetrics(
  payments: Payment[],
  referenceDate: Date = new Date()
): PaymentRevenueMetrics {
  const currentMonthKey = `${referenceDate.getFullYear()}-${String(
    referenceDate.getMonth() + 1
  ).padStart(2, '0')}`;

  let totalRevenue = 0;
  let monthlyRevenue = 0;
  let successfulCount = 0;
  let monthlySuccessfulCount = 0;

  for (const payment of payments) {
    if (payment.status !== 'success') continue;
    const amount = Number(payment.amount) || 0;
    if (amount <= 0) continue;

    successfulCount += 1;
    totalRevenue += amount;

    const monthKey = resolvePaymentMonthKey(payment);
    if (monthKey === currentMonthKey) {
      monthlySuccessfulCount += 1;
      monthlyRevenue += amount;
    }
  }

  return {
    totalRevenue,
    monthlyRevenue,
    successfulCount,
    monthlySuccessfulCount,
    currentMonthKey,
  };
}

export const PaymentService = {
  async getAll(): Promise<{ data: Payment[]; isLive: boolean }> {
    if (!isFirebaseConfigured || !db) {
      return { data: localPaymentsCache, isLive: false };
    }

    try {
      const snapshot = await getDocs(collection(db, COLLECTIONS.PAYMENTS));

      if (snapshot.empty) {
        localPaymentsCache = [];
        return { data: [], isLive: true };
      }

      const list: Payment[] = [];
      snapshot.forEach((docSnap) => {
        list.push(mapDocToPayment(docSnap.id, docSnap.data()));
      });

      list.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
      localPaymentsCache = list;
      return { data: list, isLive: true };
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, COLLECTIONS.PAYMENTS);
      return { data: localPaymentsCache, isLive: false };
    }
  },

  /**
   * Real-time listener for `payments` so newly approved merchant subscriptions appear immediately
   * in the Payments page and update Monthly Revenue live on the Dashboard.
   */
  subscribe(
    onData: (payments: Payment[]) => void,
    onError?: (err: Error) => void
  ): Unsubscribe {
    if (!isFirebaseConfigured || !db) {
      onData(localPaymentsCache);
      return () => {};
    }

    return onSnapshot(
      collection(db, COLLECTIONS.PAYMENTS),
      (snapshot) => {
        const list: Payment[] = [];
        snapshot.forEach((docSnap) => {
          list.push(mapDocToPayment(docSnap.id, docSnap.data()));
        });
        list.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
        localPaymentsCache = list;
        onData(list);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, COLLECTIONS.PAYMENTS);
        if (onError) onError(error);
      }
    );
  },

  async create(data: Omit<Payment, 'id' | 'transactionId'> & { transactionId?: string }): Promise<Payment> {
    const txnId = data.transactionId || `#TXN-${Math.floor(100000 + Math.random() * 900000)}`;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const dateYmd = data.date || formatLocalYmd(nowMs);
    const billingMonth = dateYmd.slice(0, 7);
    const payload = {
      transactionId: txnId,
      transactionNumber: txnId,
      merchantId: (data as any).merchantId || data.restaurantId || '',
      restaurantId: (data as any).merchantId || data.restaurantId || '',
      merchantName: data.restaurantName,
      restaurantName: data.restaurantName,
      amount: Number(data.amount) || 0,
      paymentMethod: data.paymentMethod,
      status: data.status || 'success',
      paymentStatus: data.status === 'success' ? 'paid' : data.status || 'paid',
      date: dateYmd,
      billingMonth,
      notes: data.notes || '',
      createdAtMs: nowMs,
      createdAt: nowIso,
    };

    if (isFirebaseConfigured && db) {
      try {
        const docRef = await addDoc(collection(db, COLLECTIONS.PAYMENTS), {
          ...payload,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        const created: Payment = {
          ...payload,
          restaurantId: payload.merchantId,
          restaurantName: payload.merchantName,
          id: docRef.id,
        };
        localPaymentsCache = [created, ...localPaymentsCache];
        return created;
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, COLLECTIONS.PAYMENTS);
      }
    }

    const newPayment: Payment = {
      ...payload,
      restaurantId: payload.merchantId,
      restaurantName: payload.merchantName,
      id: `pay_${Date.now()}`,
    };

    localPaymentsCache = [newPayment, ...localPaymentsCache];
    return newPayment;
  },
};
