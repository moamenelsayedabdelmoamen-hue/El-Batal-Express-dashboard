import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  Unsubscribe,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {
  db,
  functions,
  isFirebaseConfigured,
  handleFirestoreError,
  OperationType,
} from '../firebase/config';
import { COLLECTIONS } from './collections';
import {
  ManualSubscriptionPreviousReceipt,
  ManualSubscriptionRequest,
  ManualSubscriptionRequestStatus,
  ManualSubscriptionReviewEntry,
  ManualSubscriptionSettings,
  OfficialSubscriptionPlanConfig,
} from '../types';

export const MANUAL_SUBSCRIPTION_SETTINGS_DOC_ID = 'manual_subscription_config';

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
    const parsed = Date.parse(val);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toIsoString(val: any): string {
  const ms = toTimestampMs(val);
  return ms > 0 ? new Date(ms).toISOString() : '';
}

function normalizeRequestStatus(raw: unknown): ManualSubscriptionRequestStatus {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'approved' || s === 'accepted') return 'approved';
  if (s === 'rejected' || s === 'declined') return 'rejected';
  if (
    s === 'resubmission_required' ||
    s === 'resubmission_requested' ||
    s === 'resubmit' ||
    s === 'needs_resubmission'
  ) {
    return 'resubmission_required';
  }
  if (s === 'under_review' || s === 'in_review') return 'under_review';
  return 'pending_review';
}

function normalizePreviousReceipts(raw: unknown): ManualSubscriptionPreviousReceipt[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry: any) => ({
      receiptImagePath: String(entry.receiptImagePath || entry.receiptPath || ''),
      receiptImageUrl: String(entry.receiptImageUrl || entry.receiptUrl || ''),
      senderPhone: String(entry.senderPhone || ''),
      transactionReference: String(entry.transactionReference || ''),
      flaggedReason: entry.flaggedReason ? String(entry.flaggedReason) : undefined,
      flaggedAtIso:
        toIsoString(entry.flaggedAtIso || entry.flaggedAtMs || entry.flaggedAt) || undefined,
      replacedAtIso:
        toIsoString(entry.replacedAtIso || entry.replacedAtMs || entry.replacedAt) || undefined,
    }));
}

function normalizeReviewHistory(raw: unknown): ManualSubscriptionReviewEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry: any) => {
      const tsMs = toTimestampMs(entry.timestampMs || entry.timestampIso || entry.timestamp || entry.createdAt);
      return {
        action: String(entry.action || 'reviewed'),
        reviewerId: String(entry.reviewerId || entry.adminUid || ''),
        reviewerEmail: String(entry.reviewerEmail || entry.adminEmail || ''),
        reviewerName: String(entry.reviewerName || entry.adminName || 'مسؤول الإدارة'),
        note: String(entry.note || ''),
        reason: String(entry.reason || ''),
        timestampMs: tsMs || undefined,
        timestampIso: tsMs ? new Date(tsMs).toISOString() : String(entry.timestampIso || ''),
      };
    })
    .sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
}

export function mapDocToManualSubscriptionRequest(
  id: string,
  data: Record<string, any>
): ManualSubscriptionRequest {
  const createdMs = toTimestampMs(data.submittedAt || data.createdAt || data.timestamp) || Date.now();
  const maxCaptains =
    Number(data.maxCaptains ?? data.captainLimit ?? data.captainsCount ?? 2) || 2;
  const amount = Number(data.amount ?? data.price ?? data.requiredAmount ?? 0) || 0;
  const durationDays = Number(data.durationDays ?? 30) || 30;
  const planId = String(data.planId || `plan_${maxCaptains}_captains`);
  const planName = String(data.planName || data.plan || `باقة ${maxCaptains} كابتن`);
  const requestNumber =
    String(data.requestNumber || '').trim() ||
    `SUB-${id.slice(0, 8).toUpperCase()}`;

  return {
    id,
    requestNumber,
    merchantId: String(data.merchantId || data.restaurantId || data.uid || ''),
    merchantName: String(data.merchantName || data.restaurantName || 'تاجر غير محدد'),
    merchantPhone: String(data.merchantPhone || data.phone || ''),
    merchantEmail: String(data.merchantEmail || data.email || ''),
    planId,
    planName,
    maxCaptains,
    amount,
    durationDays,
    senderPhone: String(data.senderPhone || data.fromWalletNumber || data.transferPhone || ''),
    receiverWalletNumber: String(data.receiverWalletNumber || data.toWalletNumber || ''),
    transactionReference: String(
      data.transactionReference || data.referenceNumber || data.transferReference || ''
    ),
    receiptImagePath: String(data.receiptImagePath || data.receiptPath || ''),
    receiptImageUrl: String(data.receiptImageUrl || data.receiptUrl || ''),
    status: normalizeRequestStatus(data.status),
    paymentStatus: String(data.paymentStatus || 'pending_verification'),
    createdAt: new Date(createdMs).toISOString(),
    createdAtMs: createdMs,
    updatedAt: toIsoString(data.updatedAt) || undefined,
    approvedBy: data.approvedBy ? String(data.approvedBy) : undefined,
    approvedByName: data.approvedByName ? String(data.approvedByName) : undefined,
    approvedByEmail: data.approvedByEmail ? String(data.approvedByEmail) : undefined,
    approvedAt: toIsoString(data.approvedAt || data.approvedAtMs) || undefined,
    rejectedBy: data.rejectedBy ? String(data.rejectedBy) : undefined,
    rejectedByName: data.rejectedByName ? String(data.rejectedByName) : undefined,
    rejectedByEmail: data.rejectedByEmail ? String(data.rejectedByEmail) : undefined,
    rejectedAt: toIsoString(data.rejectedAt || data.rejectedAtMs) || undefined,
    rejectionReason: data.rejectionReason ? String(data.rejectionReason) : undefined,
    resubmissionReason:
      data.resubmissionReason || data.resubmissionNote
        ? String(data.resubmissionReason || data.resubmissionNote)
        : undefined,
    resubmissionNote:
      data.resubmissionNote || data.resubmissionReason
        ? String(data.resubmissionNote || data.resubmissionReason)
        : undefined,
    adminNote: data.adminNote ? String(data.adminNote) : undefined,
    merchantNote: data.merchantNote ? String(data.merchantNote) : undefined,
    paymentDocId: data.paymentDocId ? String(data.paymentDocId) : undefined,
    subscriptionStartDate: data.subscriptionStartDate ? String(data.subscriptionStartDate) : undefined,
    subscriptionEndDate: data.subscriptionEndDate ? String(data.subscriptionEndDate) : undefined,
    previousReceipts: normalizePreviousReceipts(data.previousReceipts),
    reviewHistory: normalizeReviewHistory(data.reviewHistory),
    raw: data,
  };
}

function extractCallableErrorMessage(error: any, fallback: string): string {
  const msg = error?.message || error?.details?.message;
  if (typeof msg === 'string' && msg.trim()) {
    // Strip generic Firebase prefix if present
    return msg.replace(/^FirebaseError:\s*/i, '').trim();
  }
  return fallback;
}

/**
 * Service for Manual Vodafone Cash Subscription Requests & Payment Settings.
 *
 * Security invariant:
 * - Frontend performs READ-ONLY operations against Firestore.
 * - ALL approval, rejection, resubmission, and payment settings mutations
 *   execute strictly via authenticated Firebase Cloud Functions (Admin SDK).
 */
export const ManualSubscriptionService = {
  /**
   * Subscribes in real time to `manual_subscription_requests` collection.
   */
  subscribeRequests(
    onData: (requests: ManualSubscriptionRequest[]) => void,
    onError?: (err: Error) => void
  ): Unsubscribe {
    if (!isFirebaseConfigured || !db) {
      onData([]);
      return () => {};
    }

    const colRef = collection(db, COLLECTIONS.MANUAL_SUBSCRIPTION_REQUESTS);
    return onSnapshot(
      colRef,
      (snapshot) => {
        const items: ManualSubscriptionRequest[] = [];
        snapshot.forEach((docSnap) => {
          items.push(mapDocToManualSubscriptionRequest(docSnap.id, docSnap.data()));
        });
        items.sort((a, b) => b.createdAtMs - a.createdAtMs);
        onData(items);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, COLLECTIONS.MANUAL_SUBSCRIPTION_REQUESTS);
        if (onError) onError(error);
      }
    );
  },

  /**
   * One-time read of all manual subscription requests.
   */
  async getAllRequests(): Promise<ManualSubscriptionRequest[]> {
    if (!isFirebaseConfigured || !db) return [];
    try {
      const snap = await getDocs(collection(db, COLLECTIONS.MANUAL_SUBSCRIPTION_REQUESTS));
      const items: ManualSubscriptionRequest[] = [];
      snap.forEach((docSnap) => {
        items.push(mapDocToManualSubscriptionRequest(docSnap.id, docSnap.data()));
      });
      items.sort((a, b) => b.createdAtMs - a.createdAtMs);
      return items;
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, COLLECTIONS.MANUAL_SUBSCRIPTION_REQUESTS);
      throw error;
    }
  },

  /**
   * Calls Cloud Function `approveManualSubscriptionRequest` (Server-Authoritative ONLY).
   */
  async approveRequest(requestId: string, adminNote?: string): Promise<{
    success: boolean;
    message: string;
    paymentDocId?: string;
    startDate?: string;
    endDate?: string;
  }> {
    if (!isFirebaseConfigured || !functions) {
      throw new Error('خدمة Firebase Cloud Functions غير مهيأة حالياً.');
    }
    try {
      const callable = httpsCallable<
        { requestId: string; adminNote?: string },
        {
          success: boolean;
          message: string;
          paymentDocId?: string;
          startDate?: string;
          endDate?: string;
        }
      >(functions, 'approveManualSubscriptionRequest');
      const res = await callable({ requestId, adminNote: adminNote?.trim() || '' });
      return res.data;
    } catch (error: any) {
      throw new Error(
        extractCallableErrorMessage(
          error,
          'تعذر تنفيذ الموافقة على الطلب من الخادم. تأكد من صلاحياتك وحالة الطلب.'
        )
      );
    }
  },

  /**
   * Calls Cloud Function `rejectManualSubscriptionRequest` (Server-Authoritative ONLY).
   */
  async rejectRequest(requestId: string, rejectionReason: string): Promise<{
    success: boolean;
    message: string;
  }> {
    if (!isFirebaseConfigured || !functions) {
      throw new Error('خدمة Firebase Cloud Functions غير مهيأة حالياً.');
    }
    const cleanReason = rejectionReason.trim();
    if (cleanReason.length < 3) {
      throw new Error('يرجى كتابة سبب واضح للرفض (3 أحرف على الأقل).');
    }
    try {
      const callable = httpsCallable<
        { requestId: string; rejectionReason: string },
        { success: boolean; message: string }
      >(functions, 'rejectManualSubscriptionRequest');
      const res = await callable({ requestId, rejectionReason: cleanReason });
      return res.data;
    } catch (error: any) {
      throw new Error(
        extractCallableErrorMessage(error, 'تعذر رفض الطلب من الخادم. يرجى المحاولة مرة أخرى.')
      );
    }
  },

  /**
   * Calls Cloud Function `requestSubscriptionReceiptResubmission` (Server-Authoritative ONLY).
   */
  async requestResubmission(requestId: string, reason: string): Promise<{
    success: boolean;
    message: string;
  }> {
    if (!isFirebaseConfigured || !functions) {
      throw new Error('خدمة Firebase Cloud Functions غير مهيأة حالياً.');
    }
    const cleanReason = reason.trim();
    if (cleanReason.length < 3) {
      throw new Error('يرجى كتابة سبب/ملاحظة توضح للتاجر المطلوب إعادة رفعه.');
    }
    try {
      const callable = httpsCallable<
        { requestId: string; reason: string; note: string },
        { success: boolean; message: string }
      >(functions, 'requestSubscriptionReceiptResubmission');
      const res = await callable({ requestId, reason: cleanReason, note: cleanReason });
      return res.data;
    } catch (error: any) {
      throw new Error(
        extractCallableErrorMessage(
          error,
          'تعذر إرسال طلب إعادة رفع الإيصال من الخادم.'
        )
      );
    }
  },

  /**
   * Reads Vodafone Cash & official pricing configuration from Firestore `settings/manual_subscription_config`.
   * Never hardcodes wallet numbers or package prices.
   */
  async getSettings(): Promise<ManualSubscriptionSettings> {
    const emptyDefault: ManualSubscriptionSettings = {
      vodafoneCashNumber: '',
      walletHolderName: '',
      isAcceptingSubscriptions: false,
      pauseMessage: '',
      durationDays: 30,
      plans: [],
      isConfiguredInFirestore: false,
    };

    if (!isFirebaseConfigured || !db) return emptyDefault;

    try {
      const ref = doc(db, COLLECTIONS.SETTINGS, MANUAL_SUBSCRIPTION_SETTINGS_DOC_ID);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        return emptyDefault;
      }
      const d = snap.data() || {};
      const defaultDuration = Number(d.durationDays || 30) || 30;
      const rawPlans = Array.isArray(d.plans) ? d.plans : [];
      const plans: OfficialSubscriptionPlanConfig[] = rawPlans.map((p: any, idx: number) => {
        const maxCaptains = Number(p.maxCaptains ?? p.captainsCount ?? (idx + 1) * 2) || 1;
        const price = Number(p.price ?? 0) || 0;
        const planDuration = Number(p.durationDays ?? defaultDuration) || defaultDuration;
        return {
          planId: String(p.planId || `plan_${maxCaptains}_captains`),
          planName: String(p.planName || p.label || `باقة ${maxCaptains} كابتن`),
          maxCaptains,
          price,
          durationDays: planDuration,
          isActive: p.isActive !== false,
        };
      });

      return {
        vodafoneCashNumber: String(d.vodafoneCashNumber || ''),
        walletHolderName: String(d.walletHolderName || ''),
        isAcceptingSubscriptions: d.isAcceptingSubscriptions !== false,
        pauseMessage: String(d.pauseMessage || ''),
        durationDays: defaultDuration,
        plans,
        updatedAt: toIsoString(d.updatedAt) || undefined,
        updatedBy: d.updatedBy ? String(d.updatedBy) : undefined,
        updatedByEmail: d.updatedByEmail ? String(d.updatedByEmail) : undefined,
        updatedByName: d.updatedByName ? String(d.updatedByName) : undefined,
        isConfiguredInFirestore: true,
      };
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.GET,
        `${COLLECTIONS.SETTINGS}/${MANUAL_SUBSCRIPTION_SETTINGS_DOC_ID}`
      );
      return emptyDefault;
    }
  },

  /**
   * Calls Cloud Function `updateManualSubscriptionSettings` (Master Admin ONLY).
   */
  async updateSettings(payload: {
    vodafoneCashNumber: string;
    walletHolderName: string;
    isAcceptingSubscriptions: boolean;
    pauseMessage: string;
    durationDays: number;
    plans: OfficialSubscriptionPlanConfig[];
  }): Promise<{ success: boolean; message: string; settings: ManualSubscriptionSettings }> {
    if (!isFirebaseConfigured || !functions) {
      throw new Error('خدمة Firebase Cloud Functions غير مهيأة حالياً.');
    }
    try {
      const callable = httpsCallable<
        typeof payload,
        { success: boolean; message: string; settings: ManualSubscriptionSettings }
      >(functions, 'updateManualSubscriptionSettings');
      const res = await callable(payload);
      return res.data;
    } catch (error: any) {
      throw new Error(
        extractCallableErrorMessage(
          error,
          'تعذر حفظ إعدادات فودافون كاش. يتطلب صلاحية المسؤول الرئيسي.'
        )
      );
    }
  },
};
