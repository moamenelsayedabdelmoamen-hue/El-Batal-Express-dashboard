import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions, isFirebaseConfigured } from '../firebase/config';
import { COLLECTIONS } from './collections';
import { CaptainAccountStatus, CaptainAuditLogEntry } from '../types';

export interface CaptainRegistrationRecord {
  id: string;
  uid: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  vehicleType: string;
  licensePlate: string;
  emailVerified: boolean;
  accountStatus: CaptainAccountStatus;
  isApproved: boolean;
  status: string;
  isOnline: boolean;
  profileImagePath: string;
  idFrontImagePath: string;
  idBackImagePath: string;
  licenseImagePath: string;
  rejectionReason: string;
  suspensionReason: string;
  blockReason: string;
  approvedAt: string;
  approvedByName: string;
  rejectedAt: string;
  rejectedByName: string;
  suspendedAt: string;
  suspendedByName: string;
  reactivatedAt: string;
  reactivatedByName: string;
  blockedAt: string;
  blockedByName: string;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  raw: Record<string, any>;
}

export interface CaptainModerationCallableResponse {
  success: boolean;
  captainId: string;
  captainName: string;
  previousAccountStatus: CaptainAccountStatus;
  accountStatus: CaptainAccountStatus;
  isApproved: boolean;
  status: string;
  auditLogId: string;
  moderatedBy: string;
  moderatedByName: string;
  moderatedByEmail: string;
  reason?: string;
  note?: string;
  message: string;
}

function isLocalDeviceUri(val: unknown): boolean {
  if (typeof val !== 'string') return false;
  const lower = val.trim().toLowerCase();
  return (
    lower.startsWith('content://') ||
    lower.startsWith('file://') ||
    lower.startsWith('android.resource://')
  );
}

function pickFirstValidPath(candidates: unknown[]): string {
  for (const item of candidates) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed && !isLocalDeviceUri(trimmed)) {
        return trimmed;
      }
    }
  }
  return '';
}

export function parseFirestoreTimestampMs(val: any): number {
  if (!val) return 0;
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
    return val < 1e12 ? Math.round(val * 1000) : Math.round(val);
  }
  if (val instanceof Date) {
    const ms = val.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof val?.toMillis === 'function') {
    try {
      const ms = val.toMillis();
      return Number.isFinite(ms) ? ms : 0;
    } catch {
      return 0;
    }
  }
  if (typeof val?.toDate === 'function') {
    try {
      const ms = val.toDate().getTime();
      return Number.isFinite(ms) ? ms : 0;
    } catch {
      return 0;
    }
  }
  if (typeof val === 'object' && typeof val.seconds === 'number') {
    return Math.round(val.seconds * 1000);
  }
  if (typeof val === 'object' && typeof val._seconds === 'number') {
    return Math.round(val._seconds * 1000);
  }
  if (typeof val === 'string' && val.trim().length > 0) {
    const num = Number(val.trim());
    if (Number.isFinite(num) && num > 0) {
      return num < 1e12 ? Math.round(num * 1000) : Math.round(num);
    }
    const parsed = Date.parse(val.trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function formatIsoFromTimestamp(val: any): string {
  const ms = parseFirestoreTimestampMs(val);
  if (ms > 0) {
    return new Date(ms).toISOString();
  }
  return typeof val === 'string' ? val : '';
}

/**
 * Resolves the canonical moderation status of a captain document while preserving
 * backward compatibility for legacy approved captains lacking `accountStatus`/`isApproved`.
 */
export function resolveCaptainAccountStatus(
  data: Record<string, any> | undefined
): CaptainAccountStatus {
  if (!data) return 'pending';

  const rawAccountStatus = String(data.accountStatus || '').trim().toLowerCase();
  if (rawAccountStatus === 'blocked' || rawAccountStatus === 'banned') return 'blocked';
  if (rawAccountStatus === 'suspended' || rawAccountStatus === 'disabled') return 'suspended';
  if (rawAccountStatus === 'rejected') return 'rejected';
  if (rawAccountStatus === 'pending' || rawAccountStatus === 'pending_review') return 'pending';
  if (rawAccountStatus === 'approved' || rawAccountStatus === 'active') {
    if (data.isBlocked === true) return 'blocked';
    if (data.isSuspended === true) return 'suspended';
    return 'approved';
  }

  if (data.isBlocked === true) return 'blocked';
  if (data.isSuspended === true) return 'suspended';

  const rawStatus = String(data.status || '').trim().toLowerCase();
  if (rawStatus === 'blocked' || rawStatus === 'banned') return 'blocked';
  if (rawStatus === 'suspended' || rawStatus === 'disabled' || rawStatus === 'inactive') return 'suspended';
  if (rawStatus === 'rejected') return 'rejected';
  if (rawStatus === 'pending' || rawStatus === 'pending_review') return 'pending';
  if (data.isApproved === false) return 'pending';

  if (
    data.isApproved === true ||
    ['active', 'online', 'offline', 'busy', 'available', 'approved'].includes(rawStatus)
  ) {
    return 'approved';
  }

  return 'pending';
}

function isCaptainDocument(data: Record<string, any>): boolean {
  const accountType = String(data.accountType || '').trim().toLowerCase();
  if (accountType) {
    return accountType === 'captain';
  }
  const role = String(data.role || '').trim().toLowerCase();
  if (role && !['captain', 'driver'].includes(role)) {
    return false;
  }
  return true;
}

export function mapDocToCaptainRegistration(
  id: string,
  data: Record<string, any>
): CaptainRegistrationRecord {
  const accountStatus = resolveCaptainAccountStatus(data);
  const createdAtMs =
    parseFirestoreTimestampMs(data.createdAt) ||
    parseFirestoreTimestampMs(data.registeredAt) ||
    parseFirestoreTimestampMs(data.updatedAt) ||
    0;
  const createdAt = createdAtMs > 0 ? new Date(createdAtMs).toISOString() : '';

  const profileImagePath = pickFirstValidPath([
    data.profileImagePath,
    data.personalImage,
    data.profile_image_path,
    data.profileImage,
    data.profileImageUrl,
    data.photoURL,
    data.photoUrl,
    data.avatarUri,
    data.avatarUrl,
  ]);

  const idFrontImagePath = pickFirstValidPath([
    data.idFrontImagePath,
    data.idCardFront,
    data.id_front_image_path,
    data.nationalIdFrontPath,
    data.nationalIdFrontUrl,
    data.idCardImageUrl,
    data.nationalIdUrl,
  ]);

  const idBackImagePath = pickFirstValidPath([
    data.idBackImagePath,
    data.idCardBack,
    data.id_back_image_path,
    data.nationalIdBackPath,
    data.nationalIdBackUrl,
  ]);

  const licenseImagePath = pickFirstValidPath([
    data.licenseImagePath,
    data.licenseImage,
    data.license_image_path,
    data.licenseImageUrl,
    data.licenseUrl,
    data.driverLicenseUrl,
  ]);

  return {
    id,
    uid: String(data.uid || id),
    name: String(data.fullName || data.name || data.displayName || data.driver_name || 'كابتن بدون اسم').trim(),
    phone: String(data.phone || data.phoneNumber || data.mobile || '').trim(),
    email: String(data.email || data.captainEmail || '').trim(),
    address: String(data.address || '').trim(),
    vehicleType: String(data.vehicleType || data.vehicle || 'غير محدد').trim(),
    licensePlate: String(data.licensePlate || '').trim(),
    emailVerified: data.emailVerified === true || data.isEmailVerified === true,
    accountStatus,
    isApproved: accountStatus === 'approved',
    status: String(data.status || accountStatus).trim().toLowerCase(),
    isOnline: data.isOnline === true,
    profileImagePath,
    idFrontImagePath,
    idBackImagePath,
    licenseImagePath,
    rejectionReason: String(data.rejectionReason || '').trim(),
    suspensionReason: String(data.suspensionReason || '').trim(),
    blockReason: String(data.blockReason || '').trim(),
    approvedAt: formatIsoFromTimestamp(data.approvedAt),
    approvedByName: String(data.approvedByName || data.approvedBy || '').trim(),
    rejectedAt: formatIsoFromTimestamp(data.rejectedAt),
    rejectedByName: String(data.rejectedByName || data.rejectedBy || '').trim(),
    suspendedAt: formatIsoFromTimestamp(data.suspendedAt),
    suspendedByName: String(data.suspendedByName || data.suspendedBy || '').trim(),
    reactivatedAt: formatIsoFromTimestamp(data.reactivatedAt),
    reactivatedByName: String(data.reactivatedByName || data.reactivatedBy || '').trim(),
    blockedAt: formatIsoFromTimestamp(data.blockedAt),
    blockedByName: String(data.blockedByName || data.blockedBy || '').trim(),
    createdAt,
    createdAtMs,
    updatedAt: formatIsoFromTimestamp(data.updatedAt) || createdAt,
    raw: data,
  };
}

function mapDocToAuditEntry(id: string, data: Record<string, any>): CaptainAuditLogEntry {
  const createdAtMs =
    parseFirestoreTimestampMs(data.createdAtMs) ||
    parseFirestoreTimestampMs(data.createdAt) ||
    0;
  return {
    id,
    captainId: String(data.captainId || ''),
    captainName: String(data.captainName || ''),
    captainPhone: String(data.captainPhone || ''),
    action: String(data.action || ''),
    previousAccountStatus: data.previousAccountStatus ? String(data.previousAccountStatus) : undefined,
    newAccountStatus: String(data.newAccountStatus || ''),
    reason: String(data.reason || ''),
    note: String(data.note || ''),
    performedByUid: String(data.performedByUid || ''),
    performedByEmail: String(data.performedByEmail || ''),
    performedByName: String(data.performedByName || ''),
    createdAt: createdAtMs > 0 ? new Date(createdAtMs).toISOString() : '',
    createdAtMs,
  };
}

function extractCallableErrorMessage(err: any, fallback: string): string {
  const msg = typeof err?.message === 'string' ? err.message.trim() : '';
  if (!msg) return fallback;
  return msg.replace(/^Firebase:\s*/i, '').replace(/\s*\([^)]+\)\.?$/, '').trim() || fallback;
}

export const CaptainApprovalService = {
  /**
   * Real-time subscription to `captains/{uid}` sorted newest first.
   */
  subscribeCaptainsRegistrations(
    onData: (items: CaptainRegistrationRecord[]) => void,
    onError?: (err: Error) => void
  ): () => void {
    if (!isFirebaseConfigured) {
      onData([]);
      return () => {};
    }

    const colRef = collection(db, COLLECTIONS.CAPTAINS);
    return onSnapshot(
      colRef,
      (snapshot) => {
        const list: CaptainRegistrationRecord[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() || {};
          if (!isCaptainDocument(data)) return;
          list.push(mapDocToCaptainRegistration(docSnap.id, data));
        });
        list.sort((a, b) => b.createdAtMs - a.createdAtMs);
        onData(list);
      },
      (err) => {
        if (onError) onError(err);
      }
    );
  },

  /**
   * Real-time subscription to immutable `captain_audit_logs` for a specific captain.
   * Gracefully falls back to unordered query if composite index is still building.
   */
  subscribeCaptainAuditLogs(
    captainId: string,
    onData: (entries: CaptainAuditLogEntry[]) => void,
    onError?: (err: Error) => void
  ): () => void {
    if (!isFirebaseConfigured || !captainId) {
      onData([]);
      return () => {};
    }

    const baseCol = collection(db, COLLECTIONS.CAPTAIN_AUDIT_LOGS);
    const orderedQuery = query(
      baseCol,
      where('captainId', '==', captainId),
      orderBy('createdAtMs', 'desc'),
      limit(50)
    );

    let fallbackUnsub: (() => void) | null = null;
    const mainUnsub = onSnapshot(
      orderedQuery,
      (snapshot) => {
        const items = snapshot.docs.map((d) => mapDocToAuditEntry(d.id, d.data() || {}));
        items.sort((a, b) => b.createdAtMs - a.createdAtMs);
        onData(items);
      },
      (err) => {
        // Fallback when composite index is deploying
        if (String(err?.code || '').includes('failed-precondition')) {
          const simpleQuery = query(baseCol, where('captainId', '==', captainId), limit(50));
          fallbackUnsub = onSnapshot(
            simpleQuery,
            (snap) => {
              const items = snap.docs.map((d) => mapDocToAuditEntry(d.id, d.data() || {}));
              items.sort((a, b) => b.createdAtMs - a.createdAtMs);
              onData(items);
            },
            (fallbackErr) => {
              if (onError) onError(fallbackErr);
            }
          );
          return;
        }
        if (onError) onError(err);
      }
    );

    return () => {
      mainUnsub();
      if (fallbackUnsub) fallbackUnsub();
    };
  },

  async approveCaptain(
    captainId: string,
    note?: string
  ): Promise<CaptainModerationCallableResponse> {
    if (!isFirebaseConfigured) {
      throw new Error('Firebase غير مُعد في هذا المتصفح.');
    }
    try {
      const fn = httpsCallable<
        { captainId: string; note?: string },
        CaptainModerationCallableResponse
      >(functions, 'adminApproveCaptain');
      const res = await fn({ captainId, note: note?.trim() || '' });
      return res.data;
    } catch (err) {
      throw new Error(extractCallableErrorMessage(err, 'تعذر الموافقة على حساب الكابتن.'));
    }
  },

  async rejectCaptain(
    captainId: string,
    reason: string
  ): Promise<CaptainModerationCallableResponse> {
    if (!isFirebaseConfigured) {
      throw new Error('Firebase غير مُعد في هذا المتصفح.');
    }
    try {
      const fn = httpsCallable<
        { captainId: string; reason: string },
        CaptainModerationCallableResponse
      >(functions, 'adminRejectCaptain');
      const res = await fn({ captainId, reason: reason.trim() });
      return res.data;
    } catch (err) {
      throw new Error(extractCallableErrorMessage(err, 'تعذر رفض حساب الكابتن.'));
    }
  },

  async suspendCaptain(
    captainId: string,
    reason: string
  ): Promise<CaptainModerationCallableResponse> {
    if (!isFirebaseConfigured) {
      throw new Error('Firebase غير مُعد في هذا المتصفح.');
    }
    try {
      const fn = httpsCallable<
        { captainId: string; reason: string },
        CaptainModerationCallableResponse
      >(functions, 'adminSuspendCaptain');
      const res = await fn({ captainId, reason: reason.trim() });
      return res.data;
    } catch (err) {
      throw new Error(extractCallableErrorMessage(err, 'تعذر إيقاف حساب الكابتن.'));
    }
  },

  async reactivateCaptain(
    captainId: string,
    note?: string
  ): Promise<CaptainModerationCallableResponse> {
    if (!isFirebaseConfigured) {
      throw new Error('Firebase غير مُعد في هذا المتصفح.');
    }
    try {
      const fn = httpsCallable<
        { captainId: string; note?: string },
        CaptainModerationCallableResponse
      >(functions, 'adminReactivateCaptain');
      const res = await fn({ captainId, note: note?.trim() || '' });
      return res.data;
    } catch (err) {
      throw new Error(extractCallableErrorMessage(err, 'تعذر إعادة تفعيل حساب الكابتن.'));
    }
  },

  async blockCaptain(
    captainId: string,
    reason: string
  ): Promise<CaptainModerationCallableResponse> {
    if (!isFirebaseConfigured) {
      throw new Error('Firebase غير مُعد في هذا المتصفح.');
    }
    try {
      const fn = httpsCallable<
        { captainId: string; reason: string },
        CaptainModerationCallableResponse
      >(functions, 'adminBlockCaptain');
      const res = await fn({ captainId, reason: reason.trim() });
      return res.data;
    } catch (err) {
      throw new Error(extractCallableErrorMessage(err, 'تعذر حظر حساب الكابتن.'));
    }
  },
};
