import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
} from 'firebase/firestore';
import { db, isFirebaseConfigured, handleFirestoreError, OperationType } from '../firebase/config';
import { COLLECTIONS } from './collections';
import { CaptainSchedule, CaptainShiftStatusInfo } from '../types';
import {
  computeCaptainShiftStatus,
  createDefaultWeeklySchedule,
  createDefaultDaySchedule,
  DAY_NAMES_AR,
  calculateShiftDurationHours,
} from '../utils/shiftUtils';

const LOCAL_STORAGE_KEY = 'elbatal_captain_schedules_cache';

const VALID_SCHEDULE_DAYS = [
  'saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
] as const;

/**
 * Firestore clock values are authoritative. Recalculate all durations and
 * totals from startTime/endTime so stale duration fields cannot produce a
 * fabricated noon start. Overnight shifts longer than 12 hours are allowed.
 */
function normalizeCaptainSchedule(raw: any, captainId: string): CaptainSchedule {
  const weeklySchedule: Record<string, any> = {};
  let totalWeeklyHours = 0;

  for (const dayKey of VALID_SCHEDULE_DAYS) {
    const day = raw?.weeklySchedule?.[dayKey] || {};
    const isDayOff = Boolean(day.isDayOff);
    const sourceShifts = Array.isArray(day.shifts) ? day.shifts : [];
    const shifts = isDayOff ? [] : sourceShifts.map((shift: any, index: number) => {
      const startTime = String(shift?.startTime || '').trim();
      const endTime = String(shift?.endTime || '').trim();
      const validTime = (value: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
      if (!validTime(startTime) || !validTime(endTime)) {
        throw new Error(`وقت بداية أو نهاية غير صالح في ${dayKey}، الوردية رقم ${index + 1}`);
      }
      const { durationHours, isOvernight } = calculateShiftDurationHours(startTime, endTime);
      return {
        ...shift,
        id: String(shift?.id || `shift_${dayKey}_${index + 1}`),
        name: String(shift?.name || `وردية ${index + 1}`),
        startTime,
        endTime,
        durationHours,
        isOvernight,
      };
    });
    const totalHours = shifts.reduce((sum: number, shift: any) => sum + shift.durationHours, 0);
    totalWeeklyHours += totalHours;
    weeklySchedule[dayKey] = {
      day: dayKey,
      dayNameAr: day.dayNameAr || DAY_NAMES_AR[dayKey as keyof typeof DAY_NAMES_AR] || dayKey,
      isDayOff,
      shifts,
      totalHours,
    };
  }

  return {
    ...(raw || {}),
    id: captainId,
    captainId,
    captainName: raw?.captainName || 'كابتن',
    captainPhone: raw?.captainPhone || '',
    isPaused: Boolean(raw?.isPaused),
    notes: raw?.notes || '',
    weeklySchedule,
    totalWeeklyHours,
  } as CaptainSchedule;
}


function loadCachedSchedules(): Map<string, CaptainSchedule> {
  try {
    if (typeof window !== 'undefined') {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (raw) {
        const arr: [string, CaptainSchedule][] = JSON.parse(raw);
        return new Map(arr);
      }
    }
  } catch {
    // fallback cleanly
  }
  return new Map();
}

function persistCachedSchedules(map: Map<string, CaptainSchedule>) {
  try {
    if (typeof window !== 'undefined') {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(Array.from(map.entries())));
    }
  } catch {
    // fallback cleanly
  }
}

// In-memory + persistent cache for fast responsive UI
let schedulesCache: Map<string, CaptainSchedule> = loadCachedSchedules();

export const ShiftService = {
  /**
   * Listen to all captain schedules in real-time
   */
  subscribeAllSchedules(
    onUpdate: (schedulesMap: Map<string, CaptainSchedule>) => void,
    onError?: (err: any) => void
  ): () => void {
    if (!isFirebaseConfigured) {
      onUpdate(new Map(schedulesCache));
      return () => {};
    }

    try {
      const colRef = collection(db, COLLECTIONS.CAPTAIN_SCHEDULES);
      const unsubscribe = onSnapshot(
        colRef,
        (snapshot) => {
          const freshMap = new Map<string, CaptainSchedule>();
          snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            freshMap.set(docSnap.id, normalizeCaptainSchedule(data, docSnap.id));
          });
          schedulesCache = freshMap;
          persistCachedSchedules(freshMap);
          onUpdate(freshMap);
        },
        (error) => {
          console.warn('Realtime listener notice for captain schedules:', error?.message || error);
          if (onError) onError(error);
          onUpdate(new Map(schedulesCache));
        }
      );
      return unsubscribe;
    } catch (err) {
      console.warn('Failed to setup schedules snapshot listener:', err);
      onUpdate(new Map(schedulesCache));
      return () => {};
    }
  },

  /**
   * Listen to a specific captain's schedule in real-time
   */
  subscribeCaptainSchedule(
    captainId: string,
    onUpdate: (schedule: CaptainSchedule | null, status: CaptainShiftStatusInfo) => void,
    onError?: (err: any) => void
  ): () => void {
    if (!captainId) return () => {};

    if (!isFirebaseConfigured) {
      const cached = schedulesCache.get(captainId) || null;
      onUpdate(cached, computeCaptainShiftStatus(cached));
      return () => {};
    }

    try {
      const docRef = doc(db, COLLECTIONS.CAPTAIN_SCHEDULES, captainId);
      const unsubscribe = onSnapshot(
        docRef,
        (docSnap) => {
          if (docSnap.exists()) {
            const sched = normalizeCaptainSchedule(docSnap.data(), docSnap.id);
            schedulesCache.set(captainId, sched);
            onUpdate(sched, computeCaptainShiftStatus(sched));
          } else {
            schedulesCache.delete(captainId);
            onUpdate(null, computeCaptainShiftStatus(null));
          }
        },
        (error) => {
          console.error(`Error listening to schedule for captain ${captainId}:`, error);
          if (onError) onError(error);
          const cached = schedulesCache.get(captainId) || null;
          onUpdate(cached, computeCaptainShiftStatus(cached));
        }
      );
      return unsubscribe;
    } catch (err) {
      console.error(`Failed to subscribe to captain schedule ${captainId}:`, err);
      return () => {};
    }
  },

  /**
   * Fetch all schedules once
   */
  async getAllSchedules(): Promise<Map<string, CaptainSchedule>> {
    if (!isFirebaseConfigured) {
      return new Map(schedulesCache);
    }

    try {
      const colRef = collection(db, COLLECTIONS.CAPTAIN_SCHEDULES);
      const snapshot = await getDocs(colRef);
      const map = new Map<string, CaptainSchedule>();

      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        map.set(docSnap.id, normalizeCaptainSchedule(data, docSnap.id));
      });

      schedulesCache = map;
      return map;
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, COLLECTIONS.CAPTAIN_SCHEDULES);
      return new Map(schedulesCache);
    }
  },

  /**
   * Fetch single captain schedule
   */
  async getCaptainSchedule(captainId: string): Promise<CaptainSchedule | null> {
    if (schedulesCache.has(captainId)) {
      return schedulesCache.get(captainId)!;
    }

    if (!isFirebaseConfigured) return null;

    try {
      const docRef = doc(db, COLLECTIONS.CAPTAIN_SCHEDULES, captainId);
      const docSnap = await getDoc(docRef);

      if (docSnap.exists()) {
        const sched = normalizeCaptainSchedule(docSnap.data(), docSnap.id);
        schedulesCache.set(captainId, sched);
        return sched;
      }
      return null;
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `${COLLECTIONS.CAPTAIN_SCHEDULES}/${captainId}`);
      return null;
    }
  },

  /**
   * Save or update captain schedule in Firestore
   */
  async saveSchedule(schedule: CaptainSchedule): Promise<void> {
    const captainId = schedule.captainId || schedule.id;
    if (!captainId) throw new Error('Missing captainId');

    // Normalize all clock values. More than 12 hours and overnight shifts are allowed.
    const cleanedSchedule = normalizeCaptainSchedule(schedule, captainId);
    const sanitizedWeeklySchedule = cleanedSchedule.weeklySchedule;
    const totalWeeklyHours = cleanedSchedule.totalWeeklyHours;

    if (isFirebaseConfigured && db) {
      try {
        const docRef = doc(db, COLLECTIONS.CAPTAIN_SCHEDULES, captainId);
        const payload: Record<string, any> = {
          id: captainId,
          captainId,
          captainName: cleanedSchedule.captainName,
          captainPhone: cleanedSchedule.captainPhone,
          isPaused: cleanedSchedule.isPaused,
          notes: cleanedSchedule.notes,
          weeklySchedule: sanitizedWeeklySchedule,
          totalWeeklyHours,
          updatedAt: serverTimestamp(),
        };
        // Do not report success or update the UI cache until Firestore confirms the write.
        await setDoc(docRef, payload, { merge: true });
      } catch (error: any) {
        console.warn('Firestore setDoc failed for captain_schedules:', error?.message || error);
        handleFirestoreError(error, OperationType.WRITE, `${COLLECTIONS.CAPTAIN_SCHEDULES}/${captainId}`);
        throw error;
      }
    }

    schedulesCache.set(captainId, cleanedSchedule);
    persistCachedSchedules(schedulesCache);
  },

  /**
   * Quick toggle to pause or resume a captain's work schedule
   */
  async togglePause(captainId: string, isPaused: boolean): Promise<void> {
    const existing = schedulesCache.get(captainId);
    if (existing) {
      schedulesCache.set(captainId, { ...existing, isPaused });
      persistCachedSchedules(schedulesCache);
    }

    if (isFirebaseConfigured) {
      try {
        const docRef = doc(db, COLLECTIONS.CAPTAIN_SCHEDULES, captainId);
        await updateDoc(docRef, {
          isPaused,
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `${COLLECTIONS.CAPTAIN_SCHEDULES}/${captainId}`);
        throw error;
      }
    }
  },

  /**
   * Initialize a default schedule for a captain if none exists
   */
  async initializeDefaultSchedule(
    captainId: string,
    captainName: string,
    captainPhone?: string
  ): Promise<CaptainSchedule> {
    const def = createDefaultWeeklySchedule(captainId, captainName, captainPhone);
    await this.saveSchedule(def);
    return def;
  },

  /**
   * Delete schedule
   */
  async deleteSchedule(captainId: string): Promise<void> {
    schedulesCache.delete(captainId);
    if (isFirebaseConfigured) {
      try {
        const docRef = doc(db, COLLECTIONS.CAPTAIN_SCHEDULES, captainId);
        await deleteDoc(docRef);
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, `${COLLECTIONS.CAPTAIN_SCHEDULES}/${captainId}`);
        throw error;
      }
    }
  },

  /**
   * Server-authoritative check:
   * Verifies if a captain is currently inside active shift hours and eligible to receive new orders.
   * Called during order assignment.
   */
  async verifyCaptainOrderEligibility(captainId: string): Promise<{
    isEligible: boolean;
    statusInfo: CaptainShiftStatusInfo;
    reason?: string;
  }> {
    let schedule = schedulesCache.get(captainId);
    if (!schedule && isFirebaseConfigured) {
      schedule = await this.getCaptainSchedule(captainId) || undefined;
    }

    const statusInfo = computeCaptainShiftStatus(schedule);

    if (isFirebaseConfigured) {
      try {
        const captSnap = await getDoc(doc(db, COLLECTIONS.CAPTAINS, captainId));
        if (captSnap.exists()) {
          const captData = captSnap.data();
          if (
            captData.canReceiveOrders === false ||
            captData.isReceivingOrders === false ||
            captData.isBlocked === true
          ) {
            return {
              isEligible: false,
              statusInfo,
              reason: 'تم إيقاف استقبال الطلبات لهذا الكابتن من قبل الإدارة.',
            };
          }
        }
      } catch {
        // Proceed with schedule check if captain doc read fails
      }
    }

    if (statusInfo.status === 'unscheduled') {
      return {
        isEligible: false,
        statusInfo,
        reason: 'الكابتن ليس لديه جدول شفتات مسجل، يرجى تعيين جدول ساعات العمل له أولاً.',
      };
    }

    if (statusInfo.isPaused) {
      return {
        isEligible: false,
        statusInfo,
        reason: 'تم إيقاف جدول عمل الكابتن مؤقتاً بواسطة الإدارة ولا يمكن إسناد طلبات له حالياً.',
      };
    }

    if (statusInfo.status === 'off_shift') {
      const timeInfo = statusInfo.nextShift
        ? ` (الشفت القادم: ${statusInfo.nextShift.dayNameAr} الساعة ${statusInfo.nextShift.startTimeFormatted})`
        : '';
      return {
        isEligible: false,
        statusInfo,
        reason: `الكابتن خارج ساعات العمل المحددة له${timeInfo}. سياسة المنظومة تمنع إسناد طلبات جديدة خارج وقت الشفت.`,
      };
    }

    if (statusInfo.status === 'starting_soon') {
      return {
        isEligible: false,
        statusInfo,
        reason: `شفت الكابتن سيبدأ قريباً بعد ${statusInfo.nextShift?.startsInMinutes || 0} دقيقة، ولا يمكن إسناد طلبات حتى موعد بدء الشفت الفعلي (${statusInfo.nextShift?.startTimeFormatted}).`,
      };
    }

    // Active in shift!
    return {
      isEligible: true,
      statusInfo,
    };
  },
};
