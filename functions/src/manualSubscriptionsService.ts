import {createHash} from "node:crypto";
import {
  CallableAuthContext,
  DatabaseLike,
  DomainHttpsError,
  ManualSubscriptionEffectsPort,
} from "./types.js";
import {parseTimestampMs, readNumber, readString} from "./validators.js";

const MASTER_ADMIN_EMAILS = new Set([
  "moamen.elsayed.abdelmoamen@gmail.com",
]);

const SUPER_ADMIN_EMAILS = new Set([
  "moamen.elsayed.abdelmoamen@gmail.com",
  "admin@elbatalexpress.com",
]);

const REVIEWABLE_STATUSES = new Set([
  "pending_review",
  "pending",
  "under_review",
  "resubmission_required",
  "resubmission_requested",
]);

const ACTIVE_PENDING_STATUSES = new Set([
  "pending_review",
  "pending",
  "under_review",
]);

const RESUBMISSION_STATUSES = new Set([
  "resubmission_required",
  "resubmission_requested",
]);

export interface OfficialPlanConfig {
  planId: string;
  planName: string;
  maxCaptains: number;
  price: number;
  durationDays: number;
  isActive: boolean;
}

export interface ManualSubscriptionSettingsDoc {
  vodafoneCashNumber: string;
  walletHolderName: string;
  isAcceptingSubscriptions: boolean;
  pauseMessage: string;
  durationDays: number;
  plans: OfficialPlanConfig[];
}

export interface SubmitManualSubscriptionResult {
  success: boolean;
  requestId: string;
  requestNumber: string;
  merchantId: string;
  planId: string;
  planName: string;
  maxCaptains: number;
  amount: number;
  durationDays: number;
  receiverWalletNumber: string;
  status: "pending_review";
  paymentStatus: "pending_verification";
  isResubmission: boolean;
  message: string;
}

export interface ApproveManualSubscriptionResult {
  success: boolean;
  requestId: string;
  merchantId: string;
  paymentDocId: string;
  status: "approved";
  paymentStatus: "paid";
  planId: string;
  planName: string;
  maxCaptains: number;
  amount: number;
  startDate: string;
  endDate: string;
  expiresAtMs: number;
  subscriptionVersion: number;
  approvedBy: string;
  message: string;
}

export interface RejectManualSubscriptionResult {
  success: boolean;
  requestId: string;
  merchantId: string;
  status: "rejected";
  rejectionReason: string;
  rejectedBy: string;
  message: string;
}

export interface ResubmissionRequestResult {
  success: boolean;
  requestId: string;
  merchantId: string;
  status: "resubmission_required";
  note: string;
  reviewedBy: string;
  message: string;
}

export interface UpdateSettingsResult {
  success: boolean;
  settings: ManualSubscriptionSettingsDoc;
  updatedBy: string;
  message: string;
}

function isValidDocId(id: string): boolean {
  return id.length >= 1 && id.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(id);
}

/**
 * Creates a deterministic, collision-resistant document ID for a Vodafone Cash transaction reference.
 * @param {string} reference Raw transaction reference.
 * @return {string} SHA-256 lock document ID.
 */
function createTransactionReferenceLockId(reference: string): string {
  return createHash("sha256")
    .update(reference.trim().toUpperCase(), "utf8")
    .digest("hex");
}

function formatYmdUtc(ms: number): string {
  return new Date(ms).toISOString().split("T")[0];
}

function normalizeStatus(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function isSubscriptionCurrentlyActive(
  merchantData: Record<string, unknown>,
  subscriptionData: Record<string, unknown>,
  nowMs: number
): boolean {
  const statuses = [
    normalizeStatus(subscriptionData.status),
    normalizeStatus(subscriptionData.subscriptionStatus),
    normalizeStatus(merchantData.subscriptionStatus),
  ];
  // merchantData.status / isActive are account-level fields in legacy documents,
  // so only explicit subscription fields can block a new subscription request.
  const activeFlag = subscriptionData.isActive === true ||
    subscriptionData.isSubscribed === true ||
    merchantData.isSubscribed === true;
  const activeStatus = statuses.some((status) =>
    ["active", "approved", "trial", "enabled", "valid", "subscribed"].includes(status)
  );
  if (!activeFlag && !activeStatus) return false;

  const expiryMs = Math.max(
    parseTimestampMs(subscriptionData.expiresAt),
    parseTimestampMs(subscriptionData.endDate),
    parseTimestampMs(subscriptionData.subscriptionEndDate),
    parseTimestampMs(merchantData.subscriptionExpiresAt),
    parseTimestampMs(merchantData.subscriptionEndDate),
    parseTimestampMs(merchantData.endDate)
  );
  if (expiryMs === 0) return true;
  const expiryDate = new Date(expiryMs);
  const isDateOnlyTimestamp =
    expiryDate.getUTCHours() === 0 &&
    expiryDate.getUTCMinutes() === 0 &&
    expiryDate.getUTCSeconds() === 0 &&
    expiryDate.getUTCMilliseconds() === 0;
  const effectiveExpiryMs = isDateOnlyTimestamp
    ? expiryMs + 24 * 60 * 60 * 1000 - 1
    : expiryMs;
  return nowMs <= effectiveExpiryMs;
}

function legacyPlanIdForCaptainLimit(maxCaptains: number): number {
  return ({2: 1, 4: 2, 6: 3, 8: 4} as Record<number, number>)[maxCaptains] ?? 0;
}

function normalizePhoneDigits(raw: string): string {
  return raw.replace(/[^\d+]/g, "").trim();
}

/**
 * Validates that the receipt image path (when stored in Firebase Storage) belongs to the merchant
 * and does not attempt cross-merchant path traversal.
 * @param {string} merchantId Owning merchant UID.
 * @param {string} receiptPath Storage path or verified URL.
 * @param {string} receiptUrl Optional download URL.
 * @return {boolean} True when valid and safely scoped to merchant.
 */
export function isSafeMerchantReceipt(
  merchantId: string,
  receiptPath: string,
  receiptUrl: string
): boolean {
  const cleanPath = receiptPath.trim();
  const cleanUrl = receiptUrl.trim();
  if (!cleanPath && !cleanUrl) return false;

  if (cleanPath) {
    if (cleanPath.includes("..") || cleanPath.startsWith("/")) {
      return false;
    }
    const allowedPrefixes = [
      `subscription_receipts/${merchantId}/`,
      `manual_subscription_receipts/${merchantId}/`,
      `merchants/${merchantId}/subscription_receipts/`,
    ];
    if (
      !cleanPath.startsWith("https://") &&
      !cleanPath.startsWith("gs://") &&
      !allowedPrefixes.some((p) => cleanPath.startsWith(p))
    ) {
      return false;
    }
    if (cleanPath.startsWith("gs://")) {
      const hasMerchantSegment = allowedPrefixes.some((p) =>
        cleanPath.includes(`/${p}`)
      );
      if (!hasMerchantSegment) return false;
    }
  }

  if (cleanUrl && !cleanUrl.startsWith("https://")) {
    // If stored as raw path inside receiptImageUrl, enforce prefix check too
    if (cleanUrl.includes("..") || cleanUrl.startsWith("/")) {
      return false;
    }
    const allowedPrefixes = [
      `subscription_receipts/${merchantId}/`,
      `manual_subscription_receipts/${merchantId}/`,
      `merchants/${merchantId}/subscription_receipts/`,
    ];
    if (!allowedPrefixes.some((p) => cleanUrl.startsWith(p))) {
      return false;
    }
  }

  return true;
}

/**
 * Authoritative server-side service for reviewing, approving, rejecting, and managing
 * manual Vodafone Cash subscription requests and payment settings.
 */
export class ManualSubscriptionsServerService {
  private readonly db: DatabaseLike;
  private readonly effects: ManualSubscriptionEffectsPort;

  /**
   * Constructs the ManualSubscriptionsServerService.
   * @param {DatabaseLike} db Firestore-compatible database adapter.
   * @param {ManualSubscriptionEffectsPort} effects Clock, sentinels, and FCM effects port.
   */
  constructor(db: DatabaseLike, effects: ManualSubscriptionEffectsPort) {
    this.db = db;
    this.effects = effects;
  }

  /**
   * Verifies that the caller is an authenticated admin via token claims, verified super admin email,
   * or an existing document in `admins/{uid}`.
   * @param {CallableAuthContext | undefined} authContext Callable auth context.
   * @return {Promise<{uid: string, email: string, name: string, isMasterAdmin: boolean}>} Admin info.
   */
  private async requireAdmin(
    authContext: CallableAuthContext | undefined
  ): Promise<{uid: string; email: string; name: string; isMasterAdmin: boolean}> {
    const uid = typeof authContext?.uid === "string" ? authContext.uid.trim() : "";
    if (!uid) {
      throw new DomainHttpsError(
        "unauthenticated",
        "يجب تسجيل الدخول بحساب مسؤول معتمد لتنفيذ هذا الإجراء."
      );
    }

    const token = authContext?.token ?? {};
    const tokenEmail =
      typeof token.email === "string" ? token.email.trim().toLowerCase() : "";
    const tokenEmailVerified = token.email_verified === true;
    const tokenRole =
      typeof token.role === "string" ? token.role.trim().toLowerCase() : "";
    const tokenIsAdmin = token.admin === true || tokenRole === "admin";
    const tokenIsMaster = token.isMasterAdmin === true;

    let adminDocData: Record<string, unknown> | undefined;
    const adminSnap = await this.db.collection("admins").doc(uid).get();
    if (adminSnap.exists) {
      adminDocData = adminSnap.data() ?? {};
    }

    const docRole = readString(adminDocData, "role").toLowerCase();
    const docStatus = readString(adminDocData, "status").toLowerCase();
    const isAdminByDoc =
      Boolean(adminDocData) &&
      (!docRole || docRole === "admin" || docRole === "super_admin") &&
      docStatus !== "suspended" &&
      docStatus !== "disabled";

    const isSuperByEmail =
      Boolean(tokenEmail) &&
      SUPER_ADMIN_EMAILS.has(tokenEmail) &&
      (tokenEmailVerified || Boolean(adminDocData));

    if (!tokenIsAdmin && !isAdminByDoc && !isSuperByEmail) {
      throw new DomainHttpsError(
        "permission-denied",
        "غير مصرح لك بتنفيذ هذا الإجراء: يتطلب صلاحية مسؤول إدارة."
      );
    }

    const isMasterByEmail =
      Boolean(tokenEmail) &&
      MASTER_ADMIN_EMAILS.has(tokenEmail) &&
      (tokenEmailVerified || Boolean(adminDocData));
    const isMasterByDoc =
      adminDocData?.isMasterAdmin === true || adminDocData?.isSuperAdmin === true;

    const name =
      readString(adminDocData, "displayName", "name") ||
      (typeof token.name === "string" && token.name.trim() ? token.name.trim() : "") ||
      tokenEmail ||
      "مسؤول النظام";

    return {
      uid,
      email: tokenEmail || readString(adminDocData, "email"),
      name,
      isMasterAdmin: Boolean(tokenIsMaster || isMasterByEmail || isMasterByDoc),
    };
  }

  /**
   * Verifies that the caller is specifically the Master Admin (المسؤول الرئيسي).
   * @param {CallableAuthContext | undefined} authContext Callable auth context.
   * @return {Promise<{uid: string, email: string, name: string}>} Master admin info.
   */
  private async requireMasterAdmin(
    authContext: CallableAuthContext | undefined
  ): Promise<{uid: string; email: string; name: string}> {
    const admin = await this.requireAdmin(authContext);
    if (!admin.isMasterAdmin) {
      throw new DomainHttpsError(
        "permission-denied",
        "غير مصرح: تعديل إعدادات الدفع اليدوي وأسعار الباقات متاح للمسؤول الرئيسي فقط."
      );
    }
    return admin;
  }

  /**
   * 0. Merchant submits a new manual Vodafone Cash subscription request (or resubmits an existing
   * request whose status is `resubmission_required`).
   * - Derives merchant identity strictly from Firebase Auth UID (never trusts client merchantId).
   * - Verifies merchant account ownership in `merchants/{uid}`.
   * - Reads authoritative package, price, durationDays, and wallet from `settings/manual_subscription_config`.
   * - Rejects any client-tampered price or disabled package.
   * - Verifies receipt path ownership AND verifies receipt object exists in Firebase Storage.
   * - Prevents duplicate pending requests and duplicate transaction references.
   * - Always writes status = `pending_review` & paymentStatus = `pending_verification`
   *   (NEVER activates subscription or writes a payment record).
   * @param {CallableAuthContext | undefined} authContext Merchant Firebase Auth context.
   * @param {Record<string, unknown>} data Request payload.
   * @return {Promise<SubmitManualSubscriptionResult>} Created/resubmitted request summary.
   */
  async submitManualSubscriptionRequest(
    authContext: CallableAuthContext | undefined,
    data: Record<string, unknown>
  ): Promise<SubmitManualSubscriptionResult> {
    const uid = typeof authContext?.uid === "string" ? authContext.uid.trim() : "";
    if (!uid || !isValidDocId(uid)) {
      throw new DomainHttpsError(
        "unauthenticated",
        "يجب تسجيل الدخول بحساب التاجر أولاً لتقديم طلب الاشتراك."
      );
    }

    const claimedMerchantId = readString(data, "merchantId", "restaurantId");
    if (claimedMerchantId && claimedMerchantId !== uid) {
      throw new DomainHttpsError(
        "permission-denied",
        "غير مصرح بتقديم طلب اشتراك نيابة عن تاجر آخر."
      );
    }

    const requestedPlanId = readString(data, "planId", "packageId");
    const requestedNumericPlanId = readNumber(data, "planId", "packageId");
    const claimedCaptainLimits = [
      readNumber(data, "maxCaptains"),
      readNumber(data, "captainLimit"),
      readNumber(data, "captainsCount"),
    ].filter((value): value is number => value !== null);
    const requestedMaxCaptains = claimedCaptainLimits[0] ?? 0;
    const claimedAmounts = [
      readNumber(data, "amount"),
      readNumber(data, "expectedAmount"),
      readNumber(data, "price"),
      readNumber(data, "requiredAmount"),
    ].filter((value): value is number => value !== null);
    const senderPhone = normalizePhoneDigits(
      readString(data, "senderPhone", "fromWalletNumber", "transferPhone")
    );
    const transactionReference = readString(
      data,
      "transactionReference",
      "referenceNumber",
      "transferReference"
    ).slice(0, 120);
    const receiptImagePath = readString(
      data,
      "receiptImagePath",
      "receiptStoragePath",
      "receiptPath"
    );
    const receiptImageUrl = readString(data, "receiptImageUrl", "receiptUrl");
    const merchantNote = readString(data, "merchantNote", "notes").slice(0, 400);
    const providedIdempotencyKey = readString(data, "idempotencyKey").trim();
    if (providedIdempotencyKey.length > 160) {
      throw new DomainHttpsError("invalid-argument", "مفتاح منع التكرار أطول من الحد المسموح.");
    }
    const providedRequestId =
      readString(data, "requestId") ||
      (providedIdempotencyKey
        ? `idem_${createHash("sha256").update(providedIdempotencyKey).digest("hex").slice(0, 48)}`
        : "");
    const idempotencyKey = providedIdempotencyKey || providedRequestId;

    if (providedRequestId && !isValidDocId(providedRequestId)) {
      throw new DomainHttpsError("invalid-argument", "معرّف الطلب غير صالح.");
    }
    if (!senderPhone || senderPhone.length < 8 || senderPhone.length > 20) {
      throw new DomainHttpsError(
        "invalid-argument",
        "يرجى إدخال رقم المحفظة المحوّل منها بشكل صحيح."
      );
    }
    if (!receiptImagePath) {
      throw new DomainHttpsError(
        "invalid-argument",
        "يجب رفع صورة إيصال التحويل إلى Firebase Storage قبل إرسال الطلب."
      );
    }
    if (!isSafeMerchantReceipt(uid, receiptImagePath, receiptImageUrl)) {
      throw new DomainHttpsError(
        "permission-denied",
        "مسار صورة الإيصال غير مرتبط بحساب التاجر الصحيح."
      );
    }

    // Verify receipt file genuinely exists in Firebase Storage
    const receiptExists = await this.effects.verifyStorageReceiptExists(
      receiptImagePath
    );
    if (!receiptExists) {
      throw new DomainHttpsError(
        "failed-precondition",
        "لم يتم العثور على صورة الإيصال في Firebase Storage. يرجى إعادة رفع الإيصال."
      );
    }

    const nowMs = this.effects.now();
    const s = this.effects.sentinels;

    // Pre-check merchant's existing requests & duplicate transaction references
    const existingMerchantReqsSnap = await this.db
      .collection("manual_subscription_requests")
      .where("merchantId", "==", uid)
      .get();

    let resubmissionTargetDocId = "";
    for (const docSnap of existingMerchantReqsSnap.docs) {
      const d = docSnap.data() ?? {};
      const st = normalizeStatus(d.status);
      if (providedRequestId && docSnap.id === providedRequestId) {
        if (RESUBMISSION_STATUSES.has(st)) {
          resubmissionTargetDocId = docSnap.id;
          continue;
        }
        // A repeated network submission with the same requestId + idempotency key is handled
        // inside the transaction as a safe no-op. Different keys remain rejected.
        if (
          ACTIVE_PENDING_STATUSES.has(st) &&
          idempotencyKey &&
          readString(d, "idempotencyKey") === idempotencyKey
        ) {
          resubmissionTargetDocId = docSnap.id;
          continue;
        }
        throw new DomainHttpsError(
          "already-exists",
          "هذا الطلب موجود بالفعل ولا يقبل إعادة الإرسال في حالته الحالية."
        );
      }
      if (ACTIVE_PENDING_STATUSES.has(st) || RESUBMISSION_STATUSES.has(st)) {
        throw new DomainHttpsError(
          "already-exists",
          "لديك طلب اشتراك قيد المراجعة أو يحتاج إلى إعادة إرسال بالفعل. يرجى متابعة الطلب الحالي."
        );
      }
    }

    if (transactionReference) {
      const dupRefSnap = await this.db
        .collection("manual_subscription_requests")
        .where("transactionReference", "==", transactionReference)
        .get();
      for (const dSnap of dupRefSnap.docs) {
        if (resubmissionTargetDocId && dSnap.id === resubmissionTargetDocId) {
          continue;
        }
        throw new DomainHttpsError(
          "already-exists",
          "رقم العملية المرجعي مستخدم في طلب اشتراك آخر بالفعل ولا يمكن إعادة استخدامه."
        );
      }
    }

    const requestId =
      resubmissionTargetDocId || providedRequestId || `subreq_${uid.slice(0, 8)}_${nowMs}`;
    const requestRef = this.db
      .collection("manual_subscription_requests")
      .doc(requestId);
    const merchantRef = this.db.collection("merchants").doc(uid);
    const subscriptionRef = this.db.collection("subscriptions").doc(uid);
    const settingsRef = this.db
      .collection("settings")
      .doc("manual_subscription_config");
    const opLogRef = this.db
      .collection("operation_logs")
      .doc(`submit_manual_sub_${requestId}_${nowMs}`);
    // Admin-SDK-only reservation documents. Client Firestore rules keep this collection closed.
    const referenceLockRef = transactionReference
      ? this.db.collection("manual_subscription_reference_locks")
        .doc(createTransactionReferenceLockId(transactionReference))
      : null;

    return this.db.runTransaction(async (tx) => {
      const [merchantSnap, subscriptionSnap, settingsSnap, existingReqSnap, referenceLockSnap] = await Promise.all([
        tx.get(merchantRef),
        tx.get(subscriptionRef),
        tx.get(settingsRef),
        tx.get(requestRef),
        referenceLockRef ? tx.get(referenceLockRef) : Promise.resolve(null),
      ]);

      if (!merchantSnap.exists) {
        throw new DomainHttpsError(
          "not-found",
          "حساب التاجر غير مسجل في النظام."
        );
      }
      const merchantData = merchantSnap.data() ?? {};
      const subscriptionData = subscriptionSnap.exists ? subscriptionSnap.data() ?? {} : {};
      if (isSubscriptionCurrentlyActive(merchantData, subscriptionData, nowMs)) {
        throw new DomainHttpsError(
          "failed-precondition",
          "لديك باقة اشتراك نشطة حالياً. لا يمكن إرسال طلب تجديد جديد قبل انتهاء صلاحيتها."
        );
      }
      const accountType = readString(merchantData, "accountType").toLowerCase();
      const role = readString(merchantData, "role").toLowerCase();
      if (
        (accountType && accountType !== "merchant") ||
        (!accountType && role && role !== "merchant")
      ) {
        throw new DomainHttpsError(
          "permission-denied",
          "هذا الإجراء مخصص لحسابات التجار فقط."
        );
      }
      const merchantDocUid = readString(merchantData, "uid");
      if (merchantDocUid && merchantDocUid !== uid) {
        throw new DomainHttpsError(
          "permission-denied",
          "عدم تطابق ملكية حساب التاجر."
        );
      }

      // Serialize active requests for the same merchant through merchants/{uid}.
      // A conflicting transaction retries and then observes the first request's lock.
      const activeRequestId = readString(merchantData, "activeManualSubscriptionRequestId");
      if (activeRequestId && activeRequestId !== requestId) {
        const activeRequestSnap = await tx.get(
          this.db.collection("manual_subscription_requests").doc(activeRequestId)
        );
        const activeStatus = normalizeStatus(activeRequestSnap.data()?.status);
        if (
          activeRequestSnap.exists &&
          (ACTIVE_PENDING_STATUSES.has(activeStatus) || RESUBMISSION_STATUSES.has(activeStatus))
        ) {
          throw new DomainHttpsError(
            "already-exists",
            "لديك طلب اشتراك آخر قيد المراجعة بالفعل. يرجى انتظار قرار الإدارة."
          );
        }
      }

      // Deterministic transfer-reference reservation prevents the same reference being used
      // by two merchants in concurrent submissions. This lock is never released for replay.
      if (referenceLockSnap?.exists) {
        const referenceLock = referenceLockSnap.data() ?? {};
        const lockRequestId = readString(referenceLock, "requestId");
        const lockMerchantId = readString(referenceLock, "merchantId");
        if (lockRequestId !== requestId || lockMerchantId !== uid) {
          throw new DomainHttpsError(
            "already-exists",
            "رقم العملية المرجعي مرتبط بطلب اشتراك آخر ولا يمكن استخدامه مرة أخرى."
          );
        }
      }

      if (!settingsSnap.exists) {
        throw new DomainHttpsError(
          "failed-precondition",
          "إعدادات اشتراكات فودافون كاش غير مهيأة حالياً من الإدارة."
        );
      }
      const settingsData = settingsSnap.data() ?? {};
      if (settingsData.isAcceptingSubscriptions === false) {
        const pauseMsg = readString(settingsData, "pauseMessage");
        throw new DomainHttpsError(
          "failed-precondition",
          pauseMsg || "استقبال طلبات الاشتراك متوقف مؤقتاً من الإدارة."
        );
      }

      const receiverWalletNumber = readString(settingsData, "vodafoneCashNumber");
      if (!receiverWalletNumber) {
        throw new DomainHttpsError(
          "failed-precondition",
          "رقم محفظة فودافون كاش غير مضبوط في إعدادات النظام."
        );
      }

      const configuredPlans = Array.isArray(settingsData.plans)
        ? (settingsData.plans as Record<string, unknown>[])
        : [];
      const legacyNumericPlanToCaptains: Record<number, number> = {
        1: 2,
        2: 4,
        3: 6,
        4: 8,
      };
      const numericPlanKey =
        requestedNumericPlanId !== null
          ? Math.round(requestedNumericPlanId)
          : /^\d+$/.test(requestedPlanId)
            ? Number(requestedPlanId)
            : null;
      const legacyMappedCaptains =
        numericPlanKey !== null ? legacyNumericPlanToCaptains[numericPlanKey] ?? 0 : 0;

      const matchedPlan = configuredPlans.find((p) => {
        const pId = readString(p, "planId");
        const pCap = readNumber(p, "maxCaptains", "captainsCount") ?? 0;
        if (requestedPlanId && pId && pId === requestedPlanId) return true;
        if (legacyMappedCaptains > 0 && pCap === legacyMappedCaptains) return true;
        if (!requestedPlanId && numericPlanKey === null && requestedMaxCaptains > 0) {
          return pCap === requestedMaxCaptains;
        }
        return false;
      });

      if (!matchedPlan) {
        throw new DomainHttpsError(
          "invalid-argument",
          "الباقة المختارة غير موجودة ضمن الباقات الرسمية في إعدادات السيرفر."
        );
      }
      if (matchedPlan.isActive === false) {
        throw new DomainHttpsError(
          "failed-precondition",
          "هذه الباقة غير متاحة حالياً للاشتراك."
        );
      }

      const officialPlanId = readString(matchedPlan, "planId");
      const officialPlanName =
        readString(matchedPlan, "planName", "label", "name") || officialPlanId;
      const officialMaxCaptains = Math.round(
        readNumber(matchedPlan, "maxCaptains", "captainsCount") ?? 0
      );
      const officialPrice = readNumber(matchedPlan, "price") ?? 0;
      // Business rule: every subscription package lasts exactly one month (30 days).
      const officialDurationDays = 30;

      if (officialMaxCaptains < 1 || officialPrice <= 0) {
        throw new DomainHttpsError(
          "failed-precondition",
          "إعدادات الباقة الرسمية على السيرفر غير مكتملة."
        );
      }

      // Validate every client-supplied amount alias independently; one correct alias must not
      // hide a second tampered price field.
      if (claimedAmounts.some((claimedAmount) => Math.abs(claimedAmount - officialPrice) > 0.01)) {
        throw new DomainHttpsError(
          "invalid-argument",
          "قيمة الاشتراك المرسلة لا تطابق السعر الرسمي للباقة على السيرفر."
        );
      }

      // Validate every supplied captain-limit alias independently.
      if (claimedCaptainLimits.some((claimedLimit) => Math.round(claimedLimit) !== officialMaxCaptains)) {
        throw new DomainHttpsError(
          "invalid-argument",
          "عدد الكباتن المرسل لا يطابق الحد الرسمي للباقة على السيرفر."
        );
      }

      const merchantName =
        readString(merchantData, "name", "merchantName", "restaurantName") ||
        "تاجر مسجل";
      const merchantPhone = readString(merchantData, "phone", "phoneNumber");
      const merchantEmail =
        readString(merchantData, "email", "ownerEmail") ||
        (typeof authContext?.token?.email === "string"
          ? authContext.token.email.trim()
          : "");
      const nextSubscriptionVersion = Math.max(
        readNumber(subscriptionData, "subscriptionVersion") ?? 0,
        readNumber(merchantData, "subscriptionVersion") ?? 0
      ) + 1;
      const localPlanId = legacyPlanIdForCaptainLimit(officialMaxCaptains);
      const pendingSubscriptionState = {
        merchantId: uid,
        restaurantId: uid,
        status: "pending_review",
        subscriptionStatus: "pending_review",
        isActive: false,
        isSubscribed: false,
        planId: localPlanId,
        planName: officialPlanName,
        maxCaptains: officialMaxCaptains,
        captainLimit: officialMaxCaptains,
        captainsCount: officialMaxCaptains,
        price: officialPrice,
        amount: officialPrice,
        durationDays: officialDurationDays,
        paymentStatus: "pending_verification",
        paymentMethod: "vodafone_cash_manual",
        pendingRequestId: requestId,
        senderPhone,
        transactionReference,
        receiptStoragePath: receiptImagePath,
        resubmissionReason: null,
        rejectionReason: null,
        subscriptionVersion: nextSubscriptionVersion,
        subscriptionUpdatedAt: s.serverTimestamp(),
        updatedAt: s.serverTimestamp(),
        updatedBy: uid,
      };

      // Idempotent retry: a repeated request with the same requestId/key returns the existing
      // pending result instead of producing a second write or a misleading error.
      if (existingReqSnap.exists) {
        const existingRequest = existingReqSnap.data() ?? {};
        const existingMerchantId = readString(existingRequest, "merchantId", "restaurantId", "uid");
        const existingStatus = normalizeStatus(existingRequest.status);
        if (
          existingMerchantId === uid &&
          idempotencyKey &&
          readString(existingRequest, "idempotencyKey") === idempotencyKey &&
          ACTIVE_PENDING_STATUSES.has(existingStatus)
        ) {
          return {
            success: true,
            requestId,
            requestNumber: readString(existingRequest, "requestNumber") || `SUB-${requestId.slice(0, 8).toUpperCase()}`,
            merchantId: uid,
            planId: readString(existingRequest, "planId") || officialPlanId,
            planName: readString(existingRequest, "planName") || officialPlanName,
            maxCaptains: readNumber(existingRequest, "maxCaptains") ?? officialMaxCaptains,
            amount: readNumber(existingRequest, "amount") ?? officialPrice,
            durationDays: readNumber(existingRequest, "durationDays") ?? officialDurationDays,
            receiverWalletNumber: readString(existingRequest, "receiverWalletNumber") || receiverWalletNumber,
            status: "pending_review" as const,
            paymentStatus: "pending_verification" as const,
            isResubmission: false,
            message: "تم تسجيل الطلب مسبقاً؛ لا حاجة لإرساله مرة أخرى.",
          };
        }
      }

      // Handle resubmission of an existing resubmission_required request
      if (existingReqSnap.exists) {
        const prev = existingReqSnap.data() ?? {};
        const prevMerchantId = readString(prev, "merchantId", "restaurantId", "uid");
        const prevStatus = normalizeStatus(prev.status);
        if (prevMerchantId !== uid || !RESUBMISSION_STATUSES.has(prevStatus)) {
          throw new DomainHttpsError(
            "already-exists",
            "الطلب موجود بالفعل ولا يمكن استبداله."
          );
        }

        const prevReceiptPath = readString(prev, "receiptImagePath", "receiptPath");
        const prevReceiptUrl = readString(prev, "receiptImageUrl", "receiptUrl");
        const existingArchivedReceipts = Array.isArray(prev.previousReceipts)
          ? (prev.previousReceipts as Record<string, unknown>[])
          : [];
        const alreadyArchived = existingArchivedReceipts.some((entry) => {
          const archivedPath = readString(entry, "receiptImagePath", "receiptPath");
          const archivedUrl = readString(entry, "receiptImageUrl", "receiptUrl");
          return (
            (Boolean(prevReceiptPath) && archivedPath === prevReceiptPath) ||
            (Boolean(prevReceiptUrl) && archivedUrl === prevReceiptUrl)
          );
        });

        const reviewEntry = {
          action: "resubmitted",
          reviewerId: uid,
          reviewerEmail: merchantEmail,
          reviewerName: merchantName,
          note: merchantNote || "قام التاجر بإعادة رفع صورة إيصال جديدة للمراجعة",
          timestampMs: nowMs,
          timestampIso: new Date(nowMs).toISOString(),
        };

        const reqNum =
          readString(prev, "requestNumber") ||
          `SUB-${requestId.slice(0, 8).toUpperCase()}`;

        const resubmissionUpdate: Record<string, unknown> = {
          senderPhone,
          transactionReference,
          receiptImagePath,
          receiptImageUrl,
          merchantNote,
          idempotencyKey,
          status: "pending_review",
          paymentStatus: "pending_verification",
          resubmittedAt: s.serverTimestamp(),
          resubmittedAtMs: nowMs,
          reviewHistory: s.arrayUnion(reviewEntry),
          updatedAt: s.serverTimestamp(),
        };

        if ((prevReceiptPath || prevReceiptUrl) && !alreadyArchived) {
          resubmissionUpdate.previousReceipts = s.arrayUnion({
            receiptImagePath: prevReceiptPath,
            receiptImageUrl: prevReceiptUrl,
            senderPhone: readString(prev, "senderPhone"),
            transactionReference: readString(prev, "transactionReference"),
            replacedAtMs: nowMs,
            replacedAtIso: new Date(nowMs).toISOString(),
          });
        }

        tx.update(requestRef, resubmissionUpdate);
        tx.set(subscriptionRef, pendingSubscriptionState, {merge: true});
        tx.set(
          merchantRef,
          {
            ...pendingSubscriptionState,
            activeManualSubscriptionRequestId: requestId,
            manualSubscriptionRequestUpdatedAt: s.serverTimestamp(),
          },
          {merge: true}
        );
        if (referenceLockRef) {
          tx.set(referenceLockRef, {
            requestId,
            merchantId: uid,
            transactionReference,
            createdAt: s.serverTimestamp(),
            updatedAt: s.serverTimestamp(),
          }, {merge: true});
        }

        tx.set(opLogRef, {
          action: "resubmit_manual_subscription_request",
          entityType: "manual_subscription_request",
          requestId,
          merchantId: uid,
          planId: readString(prev, "planId") || officialPlanId,
          amount: readNumber(prev, "amount") ?? officialPrice,
          receiptImagePath,
          createdAt: s.serverTimestamp(),
        });

        return {
          success: true,
          requestId,
          requestNumber: reqNum,
          merchantId: uid,
          planId: readString(prev, "planId") || officialPlanId,
          planName: readString(prev, "planName") || officialPlanName,
          maxCaptains: readNumber(prev, "maxCaptains") ?? officialMaxCaptains,
          amount: readNumber(prev, "amount") ?? officialPrice,
          durationDays: readNumber(prev, "durationDays") ?? officialDurationDays,
          receiverWalletNumber:
            readString(prev, "receiverWalletNumber") || receiverWalletNumber,
          status: "pending_review" as const,
          paymentStatus: "pending_verification" as const,
          isResubmission: true,
          message: "تم إعادة إرسال الإيصال بنجاح وجارٍ مراجعته من الإدارة.",
        };
      }

      const requestNumber = `SUB-${String(nowMs).slice(-6)}`;
      const submitHistoryEntry = {
        action: "submitted",
        reviewerId: uid,
        reviewerEmail: merchantEmail,
        reviewerName: merchantName,
        note: merchantNote || "تم إرسال طلب اشتراك فودافون كاش مع إيصال التحويل",
        timestampMs: nowMs,
        timestampIso: new Date(nowMs).toISOString(),
      };

      tx.set(requestRef, {
        requestNumber,
        merchantId: uid,
        restaurantId: uid,
        merchantName,
        merchantPhone,
        merchantEmail,
        planId: officialPlanId,
        planName: officialPlanName,
        maxCaptains: officialMaxCaptains,
        amount: officialPrice,
        durationDays: officialDurationDays,
        senderPhone,
        receiverWalletNumber,
        transactionReference,
        receiptImagePath,
        receiptImageUrl,
        merchantNote,
        idempotencyKey,
        status: "pending_review",
        paymentStatus: "pending_verification",
        previousReceipts: [],
        reviewHistory: [submitHistoryEntry],
        submittedAt: s.serverTimestamp(),
        createdAt: s.serverTimestamp(),
        updatedAt: s.serverTimestamp(),
      });
      tx.set(subscriptionRef, pendingSubscriptionState, {merge: true});
      tx.set(
        merchantRef,
        {
          ...pendingSubscriptionState,
          activeManualSubscriptionRequestId: requestId,
          manualSubscriptionRequestUpdatedAt: s.serverTimestamp(),
        },
        {merge: true}
      );
      if (referenceLockRef) {
        tx.set(referenceLockRef, {
          requestId,
          merchantId: uid,
          transactionReference,
          createdAt: s.serverTimestamp(),
          updatedAt: s.serverTimestamp(),
        }, {merge: true});
      }

      tx.set(opLogRef, {
        action: "submit_manual_subscription_request",
        entityType: "manual_subscription_request",
        requestId,
        requestNumber,
        merchantId: uid,
        merchantName,
        planId: officialPlanId,
        planName: officialPlanName,
        maxCaptains: officialMaxCaptains,
        amount: officialPrice,
        durationDays: officialDurationDays,
        receiptImagePath,
        createdAt: s.serverTimestamp(),
      });

      return {
        success: true,
        requestId,
        requestNumber,
        merchantId: uid,
        planId: officialPlanId,
        planName: officialPlanName,
        maxCaptains: officialMaxCaptains,
        amount: officialPrice,
        durationDays: officialDurationDays,
        receiverWalletNumber,
        status: "pending_review" as const,
        paymentStatus: "pending_verification" as const,
        isResubmission: false,
        message: "تم إرسال طلب الاشتراك بنجاح وهو الآن قيد مراجعة الإدارة.",
      };
    });
  }

  /**
   * 1. Approves a manual Vodafone Cash subscription request atomically inside a Firestore Transaction.
   * - Updates manual_subscription_requests/{requestId} -> approved + paymentStatus: paid
   * - Updates subscriptions/{merchantId} -> active, dates, planId, planName, maxCaptains, isSubscribed: true
   * - Updates merchants/{merchantId} -> synced canonical fields compatible with Merchant App
   * - Creates exactly ONE deterministic payment document: payments/manual_sub_{requestId}
   * - Records immutable audit log in operation_logs
   * - Sends merchant Firestore notification + FCM push
   * @param {CallableAuthContext | undefined} authContext Caller auth context.
   * @param {Record<string, unknown>} data Callable payload containing requestId and optional adminNote.
   * @return {Promise<ApproveManualSubscriptionResult>} Approval summary.
   */
  async approveManualSubscriptionRequest(
    authContext: CallableAuthContext | undefined,
    data: Record<string, unknown>
  ): Promise<ApproveManualSubscriptionResult> {
    const admin = await this.requireAdmin(authContext);
    const requestId = readString(data, "requestId");
    const adminNote =
      typeof data?.adminNote === "string" ? data.adminNote.trim().slice(0, 500) : "";

    if (!requestId || !isValidDocId(requestId)) {
      throw new DomainHttpsError("invalid-argument", "معرّف طلب الاشتراك غير صالح.");
    }

    const nowMs = this.effects.now();
    const s = this.effects.sentinels;

    const requestRef = this.db
      .collection("manual_subscription_requests")
      .doc(requestId);
    const settingsRef = this.db
      .collection("settings")
      .doc("manual_subscription_config");
    const paymentDocId = `manual_sub_${requestId}`;
    const paymentRef = this.db.collection("payments").doc(paymentDocId);
    const opLogRef = this.db
      .collection("operation_logs")
      .doc(`approve_manual_sub_${requestId}`);

    let merchantFcmToken = "";
    let notifyMerchantName = "";

    const result = await this.db.runTransaction(async (tx) => {
      const [reqSnap, settingsSnap, existingPaymentSnap] = await Promise.all([
        tx.get(requestRef),
        tx.get(settingsRef),
        tx.get(paymentRef),
      ]);

      if (!reqSnap.exists) {
        throw new DomainHttpsError(
          "not-found",
          "طلب الاشتراك غير موجود أو تم حذفه."
        );
      }

      const reqData = reqSnap.data() ?? {};
      const currentStatus = normalizeStatus(reqData.status) || "pending";

      if (currentStatus === "approved") {
        throw new DomainHttpsError(
          "already-exists",
          "تمت الموافقة على هذا الطلب وتفعيل الاشتراك مسبقاً."
        );
      }
      if (currentStatus === "rejected") {
        throw new DomainHttpsError(
          "failed-precondition",
          "لا يمكن الموافقة على طلب تم رفضه مسبقاً."
        );
      }
      if (!REVIEWABLE_STATUSES.has(currentStatus)) {
        throw new DomainHttpsError(
          "failed-precondition",
          `حالة الطلب الحالية (${currentStatus}) لا تسمح بالموافقة.`
        );
      }
      if (existingPaymentSnap.exists) {
        throw new DomainHttpsError(
          "already-exists",
          "تم إنشاء سجل مالي لهذا الطلب مسبقاً ولا يمكن تكرار العملية المالية."
        );
      }

      const merchantId = readString(reqData, "merchantId", "restaurantId", "uid");
      if (!merchantId || !isValidDocId(merchantId)) {
        throw new DomainHttpsError(
          "failed-precondition",
          "بيانات طلب الاشتراك تفتقر إلى معرّف تاجر صالح."
        );
      }

      const merchantRef = this.db.collection("merchants").doc(merchantId);
      const subscriptionRef = this.db.collection("subscriptions").doc(merchantId);

      const [merchantSnap, subSnap] = await Promise.all([
        tx.get(merchantRef),
        tx.get(subscriptionRef),
      ]);

      if (!merchantSnap.exists) {
        throw new DomainHttpsError(
          "not-found",
          "حساب التاجر المرتبط بهذا الطلب غير موجود في النظام."
        );
      }

      const merchantData = merchantSnap.data() ?? {};
      const accountType = readString(merchantData, "accountType").toLowerCase();
      const role = readString(merchantData, "role").toLowerCase();
      if (
        (accountType && accountType !== "merchant") ||
        (!accountType && role && role !== "merchant")
      ) {
        throw new DomainHttpsError(
          "permission-denied",
          "الحساب المرتبط بالطلب ليس حساب تاجر معتمداً."
        );
      }

      const merchantDocUid = readString(merchantData, "uid");
      if (merchantDocUid && merchantDocUid !== merchantId) {
        throw new DomainHttpsError(
          "permission-denied",
          "عدم تطابق ملكية طلب الاشتراك مع هوية التاجر."
        );
      }

      const receiptPath = readString(reqData, "receiptImagePath", "receiptPath");
      const receiptUrl = readString(reqData, "receiptImageUrl", "receiptUrl");
      if (!isSafeMerchantReceipt(merchantId, receiptPath, receiptUrl)) {
        throw new DomainHttpsError(
          "failed-precondition",
          "صورة إيصال التحويل مفقودة أو مسارها غير مطابق لملكية التاجر."
        );
      }

      if (receiptPath && !receiptPath.startsWith("https://")) {
        const existsInStorage = await this.effects.verifyStorageReceiptExists(
          receiptPath
        );
        if (!existsInStorage) {
          throw new DomainHttpsError(
            "failed-precondition",
            "ملف إيصال التحويل غير موجود في Firebase Storage ولا يمكن اعتماد الطلب."
          );
        }
      }

      const settingsData = settingsSnap.exists ? settingsSnap.data() ?? {} : {};

      // Resolve official plan from server settings to guarantee authoritative price, captains & duration
      const configuredPlans = Array.isArray(settingsData.plans)
        ? (settingsData.plans as Record<string, unknown>[])
        : [];
      const reqPlanId = readString(reqData, "planId");
      const reqMaxCaptains =
        readNumber(reqData, "maxCaptains", "captainLimit", "captainsCount") ?? 0;

      const matchedPlan = configuredPlans.find((p) => {
        const pId = readString(p, "planId");
        const pCap = readNumber(p, "maxCaptains", "captainsCount") ?? 0;
        return (
          (reqPlanId && pId && pId === reqPlanId) ||
          (reqMaxCaptains > 0 && pCap === reqMaxCaptains)
        );
      });

      if (configuredPlans.length > 0 && !matchedPlan) {
        throw new DomainHttpsError(
          "failed-precondition",
          "الباقة المطلوبة في الطلب لا تطابق أي باقة رسمية معتمدة في إعدادات النظام."
        );
      }

      // Never extend a paid subscription beyond the fixed one-month package term.
      const durationDays = 30;

      const maxCaptains =
        readNumber(matchedPlan, "maxCaptains", "captainsCount") ??
        (reqMaxCaptains > 0 ? Math.round(reqMaxCaptains) : 2);
      const planId =
        readString(matchedPlan, "planId") ||
        reqPlanId ||
        `plan_${maxCaptains}_captains`;
      const planName =
        readString(matchedPlan, "planName", "label", "name") ||
        readString(reqData, "planName", "plan") ||
        `باقة ${maxCaptains} كابتن`;
      const officialPlanPrice = readNumber(matchedPlan, "price");
      const reqAmount = readNumber(reqData, "amount", "price", "requiredAmount");

      if (
        officialPlanPrice !== null &&
        reqAmount !== null &&
        Math.abs(reqAmount - officialPlanPrice) > 0.01
      ) {
        throw new DomainHttpsError(
          "failed-precondition",
          `المبلغ المسجل في الطلب (${reqAmount}) لا يطابق السعر الرسمي للباقة (${officialPlanPrice}).`
        );
      }

      const amount = officialPlanPrice ?? reqAmount ?? 0;

      if (amount <= 0) {
        throw new DomainHttpsError(
          "failed-precondition",
          "قيمة المبلغ المطلوب غير صالحة لإتمام تفعيل الاشتراك."
        );
      }

      const startDateMs = nowMs;
      const endDateMs = nowMs + durationDays * 24 * 60 * 60 * 1000;
      const startDateYmd = formatYmdUtc(startDateMs);
      const endDateYmd = formatYmdUtc(endDateMs);

      const subData = subSnap.exists ? subSnap.data() ?? {} : {};
      const prevVersion = Math.max(
        readNumber(subData, "subscriptionVersion") ?? 0,
        readNumber(merchantData, "subscriptionVersion") ?? 0
      );
      const nextVersion = prevVersion + 1;

      const merchantName =
        readString(merchantData, "name", "merchantName", "restaurantName") ||
        readString(reqData, "merchantName", "restaurantName") ||
        "تاجر مسجل";
      const merchantPhone =
        readString(merchantData, "phone", "phoneNumber") ||
        readString(reqData, "merchantPhone");
      const merchantEmail =
        readString(merchantData, "email", "ownerEmail") ||
        readString(reqData, "merchantEmail");
      const senderPhone = readString(
        reqData,
        "senderPhone",
        "fromWalletNumber",
        "transferPhone"
      );
      const receiverWalletNumber =
        readString(reqData, "receiverWalletNumber", "toWalletNumber") ||
        readString(settingsData, "vodafoneCashNumber");
      const transactionReference = readString(
        reqData,
        "transactionReference",
        "referenceNumber",
        "transferReference"
      );

      merchantFcmToken = readString(merchantData, "fcmToken");
      notifyMerchantName = merchantName;

      const reviewEntry = {
        action: "approved",
        reviewerId: admin.uid,
        reviewerEmail: admin.email,
        reviewerName: admin.name,
        note: adminNote || "تمت مراجعة إيصال فودافون كاش والموافقة على تفعيل الاشتراك",
        timestampMs: nowMs,
        timestampIso: new Date(nowMs).toISOString(),
      };

      // 1. Update manual_subscription_requests/{requestId}
      tx.update(requestRef, {
        status: "approved",
        paymentStatus: "paid",
        planId,
        planName,
        maxCaptains,
        amount,
        durationDays,
        receiverWalletNumber,
        approvedBy: admin.uid,
        approvedByEmail: admin.email,
        approvedByName: admin.name,
        approvedAt: s.serverTimestamp(),
        approvedAtMs: nowMs,
        paymentDocId,
        subscriptionStartDate: startDateYmd,
        subscriptionEndDate: endDateYmd,
        subscriptionExpiresAt: endDateMs,
        adminNote,
        reviewHistory: s.arrayUnion(reviewEntry),
        updatedAt: s.serverTimestamp(),
      });

      // 2. Update subscriptions/{merchantId}
      tx.set(
        subscriptionRef,
        {
          merchantId,
          restaurantId: merchantId,
          merchantName,
          restaurantName: merchantName,
          merchantPhone,
          merchantEmail,
          status: "active",
          subscriptionStatus: "active",
          isActive: true,
          isSubscribed: true,
          planId,
          planName,
          plan: planName,
          maxCaptains,
          captainLimit: maxCaptains,
          captainsCount: maxCaptains,
          price: amount,
          amount,
          paymentStatus: "paid",
          paymentMethod: "vodafone_cash",
          lastPaymentId: paymentDocId,
          lastRequestId: requestId,
          pendingRequestId: null,
          startDate: startDateYmd,
          endDate: endDateYmd,
          startDateMs,
          endDateMs,
          expiresAt: endDateMs,
          activatedAt: s.serverTimestamp(),
          durationDays,
          suspensionReason: null,
          cancellationReason: null,
          approvedBy: admin.uid,
          approvedByEmail: admin.email,
          approvedAt: s.serverTimestamp(),
          updatedBy: admin.uid,
          updatedByAdminUid: admin.uid,
          subscriptionVersion: nextVersion,
          subscriptionUpdatedAt: s.serverTimestamp(),
          updatedAt: s.serverTimestamp(),
        },
        {merge: true}
      );

      // 3. Sync merchants/{merchantId} (fully compatible with Merchant App SubscriptionSyncResolver)
      tx.set(
        merchantRef,
        {
          subscriptionStatus: "active",
          isSubscribed: true,
          isActive: true,
          planId,
          planName,
          subscriptionPlan: planName,
          maxCaptains,
          captainLimit: maxCaptains,
          captainsCount: maxCaptains,
          price: amount,
          paymentStatus: "paid",
          subscriptionStartDate: startDateYmd,
          subscriptionEndDate: endDateYmd,
          subscriptionExpiresAt: endDateMs,
          startDate: startDateYmd,
          endDate: endDateYmd,
          expiresAt: endDateMs,
          activatedAt: s.serverTimestamp(),
          suspensionReason: null,
          cancellationReason: null,
          lastApprovedRequestId: requestId,
          pendingRequestId: null,
          lastPaymentId: paymentDocId,
          ...(readString(merchantData, "activeManualSubscriptionRequestId") === requestId
            ? {
              activeManualSubscriptionRequestId: null,
              manualSubscriptionRequestUpdatedAt: s.serverTimestamp(),
            }
            : {}),
          updatedBy: admin.uid,
          updatedByAdminUid: admin.uid,
          subscriptionVersion: nextVersion,
          subscriptionUpdatedAt: s.serverTimestamp(),
          updatedAt: s.serverTimestamp(),
        },
        {merge: true}
      );

      // 4. Create single deterministic financial payment transaction
      tx.set(paymentRef, {
        id: paymentDocId,
        requestId,
        type: "merchant_subscription",
        source: "manual_vodafone_cash",
        transactionId: transactionReference || paymentDocId,
        transactionNumber: transactionReference || paymentDocId,
        transactionReference,
        merchantId,
        restaurantId: merchantId,
        merchantName,
        restaurantName: merchantName,
        merchantPhone,
        planId,
        planName,
        maxCaptains,
        amount,
        currency: "EGP",
        paymentMethod: "فودافون كاش (Vodafone Cash)",
        method: "vodafone_cash",
        senderPhone,
        receiverWalletNumber,
        receiptImagePath: receiptPath,
        receiptImageUrl: receiptUrl,
        status: "success",
        paymentStatus: "paid",
        approvedBy: admin.uid,
        approvedByEmail: admin.email,
        approvedAt: s.serverTimestamp(),
        approvedAtMs: nowMs,
        paidAt: s.serverTimestamp(),
        paidAtMs: nowMs,
        date: startDateYmd,
        billingMonth: startDateYmd.slice(0, 7),
        notes: `تفعيل اشتراك (${planName}) عبر فودافون كاش — طلب #${requestId}`,
        createdAt: s.serverTimestamp(),
        createdAtMs: nowMs,
        updatedAt: s.serverTimestamp(),
      });

      // 5. Write audit trail to operation_logs
      tx.set(opLogRef, {
        action: "approve_manual_subscription_request",
        entityType: "manual_subscription_request",
        requestId,
        merchantId,
        merchantName,
        paymentDocId,
        planId,
        planName,
        maxCaptains,
        amount,
        durationDays,
        startDate: startDateYmd,
        endDate: endDateYmd,
        subscriptionVersion: nextVersion,
        adminUid: admin.uid,
        adminEmail: admin.email,
        adminName: admin.name,
        note: adminNote,
        createdAt: s.serverTimestamp(),
      });

      return {
        success: true,
        requestId,
        merchantId,
        paymentDocId,
        status: "approved" as const,
        paymentStatus: "paid" as const,
        planId,
        planName,
        maxCaptains,
        amount,
        startDate: startDateYmd,
        endDate: endDateYmd,
        expiresAtMs: endDateMs,
        subscriptionVersion: nextVersion,
        approvedBy: admin.uid,
        message: `تمت الموافقة وتفعيل باقة "${planName}" للتاجر "${merchantName}" بنجاح.`,
      };
    });

    // Post-commit deterministic merchant notification & FCM push
    const notifTitle = "تم تفعيل اشتراكك بنجاح";
    const notifBody = `تمت مراجعة تحويل فودافون كاش وتفعيل باقة "${result.planName}" (${result.maxCaptains} كابتن) حتى ${result.endDate}.`;

    await this.db
      .collection("merchants")
      .doc(result.merchantId)
      .collection("notifications")
      .doc(`sub_approved_${requestId}`)
      .set(
        {
          type: "subscription_approved",
          title: notifTitle,
          body: notifBody,
          requestId,
          merchantId: result.merchantId,
          merchantName: notifyMerchantName,
          planId: result.planId,
          planName: result.planName,
          maxCaptains: result.maxCaptains,
          endDate: result.endDate,
          isRead: false,
          createdAt: s.serverTimestamp(),
        },
        {merge: true}
      );

    await this.effects.sendMerchantSubscriptionNotification({
      merchantId: result.merchantId,
      fcmToken: merchantFcmToken,
      requestId,
      eventType: "subscription_approved",
      title: notifTitle,
      body: notifBody,
      planId: result.planId,
      planName: result.planName,
      maxCaptains: result.maxCaptains,
      dedupeKey: `sub_approved_${requestId}_v${result.subscriptionVersion}`,
    });

    return result;
  }

  /**
   * 2. Rejects a manual Vodafone Cash subscription request without activating the subscription.
   * @param {CallableAuthContext | undefined} authContext Caller auth context.
   * @param {Record<string, unknown>} data Payload containing requestId and rejectionReason.
   * @return {Promise<RejectManualSubscriptionResult>} Rejection result.
   */
  async rejectManualSubscriptionRequest(
    authContext: CallableAuthContext | undefined,
    data: Record<string, unknown>
  ): Promise<RejectManualSubscriptionResult> {
    const admin = await this.requireAdmin(authContext);
    const requestId = readString(data, "requestId");
    const rejectionReason = readString(data, "rejectionReason", "reason");

    if (!requestId || !isValidDocId(requestId)) {
      throw new DomainHttpsError("invalid-argument", "معرّف طلب الاشتراك غير صالح.");
    }
    if (!rejectionReason || rejectionReason.length < 3) {
      throw new DomainHttpsError(
        "invalid-argument",
        "يجب كتابة سبب واضح لرفض طلب الاشتراك (3 أحرف على الأقل)."
      );
    }
    const cleanReason = rejectionReason.slice(0, 500);

    const nowMs = this.effects.now();
    const s = this.effects.sentinels;
    const requestRef = this.db
      .collection("manual_subscription_requests")
      .doc(requestId);
    const opLogRef = this.db
      .collection("operation_logs")
      .doc(`reject_manual_sub_${requestId}`);

    let merchantFcmToken = "";
    let planName = "";

    const result = await this.db.runTransaction(async (tx) => {
      const reqSnap = await tx.get(requestRef);
      if (!reqSnap.exists) {
        throw new DomainHttpsError(
          "not-found",
          "طلب الاشتراك غير موجود أو تم حذفه."
        );
      }

      const reqData = reqSnap.data() ?? {};
      const currentStatus = normalizeStatus(reqData.status) || "pending";

      if (currentStatus === "approved") {
        throw new DomainHttpsError(
          "failed-precondition",
          "لا يمكن رفض طلب تمت الموافقة عليه وتفعيل اشتراكه بالفعل."
        );
      }
      if (currentStatus === "rejected") {
        throw new DomainHttpsError(
          "already-exists",
          "تم رفض هذا الطلب مسبقاً."
        );
      }

      const merchantId = readString(reqData, "merchantId", "restaurantId", "uid");
      if (!merchantId || !isValidDocId(merchantId)) {
        throw new DomainHttpsError(
          "failed-precondition",
          "طلب الاشتراك لا يحتوي على معرّف تاجر صالح."
        );
      }

      const merchantRef = this.db.collection("merchants").doc(merchantId);
      const subscriptionRef = this.db.collection("subscriptions").doc(merchantId);
      const [merchantSnap, subscriptionSnap] = await Promise.all([
        tx.get(merchantRef),
        tx.get(subscriptionRef),
      ]);
      const merchantData = merchantSnap.exists ? merchantSnap.data() ?? {} : {};
      const subscriptionData = subscriptionSnap.exists ? subscriptionSnap.data() ?? {} : {};
      merchantFcmToken = readString(merchantData, "fcmToken");
      planName = readString(reqData, "planName", "plan") || "باقة الاشتراك";

      const reviewEntry = {
        action: "rejected",
        reviewerId: admin.uid,
        reviewerEmail: admin.email,
        reviewerName: admin.name,
        reason: cleanReason,
        note: cleanReason,
        timestampMs: nowMs,
        timestampIso: new Date(nowMs).toISOString(),
      };

      tx.update(requestRef, {
        status: "rejected",
        paymentStatus: "rejected",
        rejectionReason: cleanReason,
        rejectedBy: admin.uid,
        rejectedByEmail: admin.email,
        rejectedByName: admin.name,
        rejectedAt: s.serverTimestamp(),
        rejectedAtMs: nowMs,
        reviewHistory: s.arrayUnion(reviewEntry),
        updatedAt: s.serverTimestamp(),
      });
      const rejectedState = {
        status: "rejected",
        subscriptionStatus: "rejected",
        isActive: false,
        isSubscribed: false,
        paymentStatus: "rejected",
        paymentMethod: "vodafone_cash_manual",
        pendingRequestId: null,
        rejectionReason: cleanReason,
        planId: legacyPlanIdForCaptainLimit(readNumber(reqData, "maxCaptains") ?? 0),
        planName,
        maxCaptains: readNumber(reqData, "maxCaptains") ?? 0,
        captainLimit: readNumber(reqData, "maxCaptains") ?? 0,
        price: readNumber(reqData, "amount") ?? 0,
        subscriptionVersion: Math.max(
          readNumber(subscriptionData, "subscriptionVersion") ?? 0,
          readNumber(merchantData, "subscriptionVersion") ?? 0
        ) + 1,
        subscriptionUpdatedAt: s.serverTimestamp(),
        updatedAt: s.serverTimestamp(),
        updatedBy: admin.uid,
      };
      tx.set(subscriptionRef, rejectedState, {merge: true});
      tx.set(
        merchantRef,
        {
          ...rejectedState,
          ...(readString(merchantData, "activeManualSubscriptionRequestId") === requestId
            ? {activeManualSubscriptionRequestId: null}
            : {}),
          manualSubscriptionRequestUpdatedAt: s.serverTimestamp(),
        },
        {merge: true}
      );

      tx.set(opLogRef, {
        action: "reject_manual_subscription_request",
        entityType: "manual_subscription_request",
        requestId,
        merchantId,
        planName,
        rejectionReason: cleanReason,
        adminUid: admin.uid,
        adminEmail: admin.email,
        adminName: admin.name,
        createdAt: s.serverTimestamp(),
      });

      return {
        success: true,
        requestId,
        merchantId,
        status: "rejected" as const,
        rejectionReason: cleanReason,
        rejectedBy: admin.uid,
        message: "تم رفض طلب الاشتراك وإرسال إشعار بالسبب إلى التاجر.",
      };
    });

    const notifTitle = "تم رفض طلب الاشتراك";
    const notifBody = `تعذر اعتماد طلب اشتراك (${planName}). السبب: ${cleanReason}`;

    await this.db
      .collection("merchants")
      .doc(result.merchantId)
      .collection("notifications")
      .doc(`sub_rejected_${requestId}`)
      .set(
        {
          type: "subscription_rejected",
          title: notifTitle,
          body: notifBody,
          requestId,
          merchantId: result.merchantId,
          reason: cleanReason,
          isRead: false,
          createdAt: s.serverTimestamp(),
        },
        {merge: true}
      );

    await this.effects.sendMerchantSubscriptionNotification({
      merchantId: result.merchantId,
      fcmToken: merchantFcmToken,
      requestId,
      eventType: "subscription_rejected",
      title: notifTitle,
      body: notifBody,
      planName,
      reason: cleanReason,
      dedupeKey: `sub_rejected_${requestId}`,
    });

    return result;
  }

  /**
   * 3. Requests the merchant to re-upload their Vodafone Cash receipt without activating subscription.
   * Sets status to `resubmission_required`, records reason, archives previous receipt attempt,
   * writes audit trail, and notifies the merchant.
   * @param {CallableAuthContext | undefined} authContext Caller auth context.
   * @param {Record<string, unknown>} data Payload containing requestId and note/reason.
   * @return {Promise<ResubmissionRequestResult>} Resubmission request result.
   */
  async requestSubscriptionReceiptResubmission(
    authContext: CallableAuthContext | undefined,
    data: Record<string, unknown>
  ): Promise<ResubmissionRequestResult> {
    const admin = await this.requireAdmin(authContext);
    const requestId = readString(data, "requestId");
    const note = readString(data, "reason", "note", "resubmissionNote");

    if (!requestId || !isValidDocId(requestId)) {
      throw new DomainHttpsError("invalid-argument", "معرّف طلب الاشتراك غير صالح.");
    }
    if (!note || note.length < 3) {
      throw new DomainHttpsError(
        "invalid-argument",
        "يرجى كتابة سبب واضح للتاجر يوضح المطلوب إعادة رفعه."
      );
    }
    const cleanNote = note.slice(0, 500);
    const nowMs = this.effects.now();
    const s = this.effects.sentinels;

    const requestRef = this.db
      .collection("manual_subscription_requests")
      .doc(requestId);
    const opLogRef = this.db
      .collection("operation_logs")
      .doc(`resubmit_manual_sub_${requestId}_${nowMs}`);

    let merchantFcmToken = "";
    let planName = "";

    const result = await this.db.runTransaction(async (tx) => {
      const reqSnap = await tx.get(requestRef);
      if (!reqSnap.exists) {
        throw new DomainHttpsError(
          "not-found",
          "طلب الاشتراك غير موجود أو تم حذفه."
        );
      }

      const reqData = reqSnap.data() ?? {};
      const currentStatus = normalizeStatus(reqData.status) || "pending_review";
      if (currentStatus === "approved") {
        throw new DomainHttpsError(
          "failed-precondition",
          "لا يمكن طلب إعادة إرسال لطلب تمت الموافقة عليه بالفعل."
        );
      }
      if (currentStatus === "rejected") {
        throw new DomainHttpsError(
          "failed-precondition",
          "لا يمكن طلب إعادة إرسال لطلب مرفوض نهائياً."
        );
      }

      const merchantId = readString(reqData, "merchantId", "restaurantId", "uid");
      if (!merchantId || !isValidDocId(merchantId)) {
        throw new DomainHttpsError(
          "failed-precondition",
          "طلب الاشتراك لا يحتوي على معرّف تاجر صالح."
        );
      }

      const merchantRef = this.db.collection("merchants").doc(merchantId);
      const subscriptionRef = this.db.collection("subscriptions").doc(merchantId);
      const [merchantSnap, subscriptionSnap] = await Promise.all([
        tx.get(merchantRef),
        tx.get(subscriptionRef),
      ]);
      const merchantData = merchantSnap.exists ? merchantSnap.data() ?? {} : {};
      const subscriptionData = subscriptionSnap.exists ? subscriptionSnap.data() ?? {} : {};
      const activeRequestId = readString(merchantData, "activeManualSubscriptionRequestId");
      if (activeRequestId && activeRequestId !== requestId) {
        const activeRequestSnap = await tx.get(
          this.db.collection("manual_subscription_requests").doc(activeRequestId)
        );
        const activeStatus = normalizeStatus(activeRequestSnap.data()?.status);
        if (
          activeRequestSnap.exists &&
          (ACTIVE_PENDING_STATUSES.has(activeStatus) || RESUBMISSION_STATUSES.has(activeStatus))
        ) {
          throw new DomainHttpsError(
            "already-exists",
            "لدى التاجر طلب اشتراك آخر قيد المراجعة ولا يمكن فتح مراجعة ثانية."
          );
        }
      }
      merchantFcmToken = readString(merchantData, "fcmToken");
      planName = readString(reqData, "planName", "plan") || "باقة الاشتراك";

      const reviewEntry = {
        action: "resubmission_required",
        reviewerId: admin.uid,
        reviewerEmail: admin.email,
        reviewerName: admin.name,
        reason: cleanNote,
        note: cleanNote,
        timestampMs: nowMs,
        timestampIso: new Date(nowMs).toISOString(),
      };

      const existingReceiptPath = readString(reqData, "receiptImagePath", "receiptPath");
      const existingReceiptUrl = readString(reqData, "receiptImageUrl", "receiptUrl");
      const updatePatch: Record<string, unknown> = {
        status: "resubmission_required",
        paymentStatus: "resubmission_required",
        resubmissionReason: cleanNote,
        resubmissionNote: cleanNote,
        lastReviewedBy: admin.uid,
        lastReviewedByEmail: admin.email,
        lastReviewedByName: admin.name,
        lastReviewedAt: s.serverTimestamp(),
        lastReviewedAtMs: nowMs,
        reviewHistory: s.arrayUnion(reviewEntry),
        updatedAt: s.serverTimestamp(),
      };

      if (existingReceiptPath || existingReceiptUrl) {
        updatePatch.previousReceipts = s.arrayUnion({
          receiptImagePath: existingReceiptPath,
          receiptImageUrl: existingReceiptUrl,
          senderPhone: readString(reqData, "senderPhone"),
          transactionReference: readString(reqData, "transactionReference"),
          flaggedReason: cleanNote,
          flaggedAtMs: nowMs,
          flaggedAtIso: new Date(nowMs).toISOString(),
        });
      }

      const resubmissionState = {
        merchantId,
        restaurantId: merchantId,
        status: "resubmission_required",
        subscriptionStatus: "resubmission_required",
        isActive: false,
        isSubscribed: false,
        planId: legacyPlanIdForCaptainLimit(readNumber(reqData, "maxCaptains") ?? 0),
        planName,
        maxCaptains: readNumber(reqData, "maxCaptains") ?? 0,
        captainLimit: readNumber(reqData, "maxCaptains") ?? 0,
        captainsCount: readNumber(reqData, "maxCaptains") ?? 0,
        price: readNumber(reqData, "amount") ?? 0,
        amount: readNumber(reqData, "amount") ?? 0,
        durationDays: readNumber(reqData, "durationDays") ?? 30,
        paymentStatus: "resubmission_required",
        paymentMethod: "vodafone_cash_manual",
        pendingRequestId: requestId,
        senderPhone: readString(reqData, "senderPhone"),
        transactionReference: readString(reqData, "transactionReference"),
        receiptStoragePath: existingReceiptPath,
        resubmissionReason: cleanNote,
        subscriptionVersion: Math.max(
          readNumber(subscriptionData, "subscriptionVersion") ?? 0,
          readNumber(merchantData, "subscriptionVersion") ?? 0
        ) + 1,
        subscriptionUpdatedAt: s.serverTimestamp(),
        updatedAt: s.serverTimestamp(),
        updatedBy: admin.uid,
      };
      tx.update(requestRef, updatePatch);
      tx.set(subscriptionRef, resubmissionState, {merge: true});
      tx.set(merchantRef, {
        ...resubmissionState,
        activeManualSubscriptionRequestId: requestId,
        manualSubscriptionRequestUpdatedAt: s.serverTimestamp(),
      }, {merge: true});

      tx.set(opLogRef, {
        action: "request_subscription_receipt_resubmission",
        entityType: "manual_subscription_request",
        requestId,
        merchantId,
        reason: cleanNote,
        note: cleanNote,
        adminUid: admin.uid,
        adminEmail: admin.email,
        adminName: admin.name,
        createdAt: s.serverTimestamp(),
      });

      return {
        success: true,
        requestId,
        merchantId,
        status: "resubmission_required" as const,
        note: cleanNote,
        reviewedBy: admin.uid,
        message: "تم إرسال طلب إعادة رفع الإيصال إلى التاجر دون تفعيل الاشتراك.",
      };
    });

    const notifTitle = "مطلوب إعادة رفع إيصال التحويل";
    const notifBody = `يرجى إعادة رفع إيصال الاشتراك (${planName}). السبب: ${cleanNote}`;

    await this.db
      .collection("merchants")
      .doc(result.merchantId)
      .collection("notifications")
      .doc(`sub_resubmit_${requestId}_${nowMs}`)
      .set({
        type: "subscription_resubmission_requested",
        title: notifTitle,
        body: notifBody,
        requestId,
        merchantId: result.merchantId,
        note: cleanNote,
        reason: cleanNote,
        isRead: false,
        createdAt: s.serverTimestamp(),
      });

    await this.effects.sendMerchantSubscriptionNotification({
      merchantId: result.merchantId,
      fcmToken: merchantFcmToken,
      requestId,
      eventType: "subscription_resubmission_requested",
      title: notifTitle,
      body: notifBody,
      planName,
      reason: cleanNote,
      dedupeKey: `sub_resubmit_${requestId}_${nowMs}`,
    });

    return result;
  }

  /**
   * Backwards-compatible alias delegating to requestSubscriptionReceiptResubmission.
   * @param {CallableAuthContext | undefined} authContext Caller auth context.
   * @param {Record<string, unknown>} data Payload containing requestId and note/reason.
   * @return {Promise<ResubmissionRequestResult>} Resubmission request result.
   */
  async requestManualSubscriptionResubmission(
    authContext: CallableAuthContext | undefined,
    data: Record<string, unknown>
  ): Promise<ResubmissionRequestResult> {
    return this.requestSubscriptionReceiptResubmission(authContext, data);
  }

  /**
   * Admin-only canonical subscription management for the general dashboard.
   * Writes subscriptions/{uid} and merchants/{uid} atomically using official server package settings.
   */
  async manageMerchantSubscription(
    authContext: CallableAuthContext | undefined,
    data: Record<string, unknown>
  ): Promise<{success: boolean; merchantId: string; status: string; maxCaptains: number; startDate: string; endDate: string; subscriptionVersion: number; message: string}> {
    const admin = await this.requireAdmin(authContext);
    const operation = readString(data, "operation").toLowerCase() || "upsert";
    const merchantId = readString(data, "merchantId", "restaurantId");
    const legacySubscriptionId = readString(data, "legacySubscriptionId");
    if (!isValidDocId(merchantId)) throw new DomainHttpsError("invalid-argument", "معرّف حساب التاجر غير صالح.");
    if (legacySubscriptionId && !isValidDocId(legacySubscriptionId)) {
      throw new DomainHttpsError("invalid-argument", "معرّف سجل الاشتراك القديم غير صالح.");
    }
    if (!["upsert", "status", "renew", "delete"].includes(operation)) {
      throw new DomainHttpsError("invalid-argument", "نوع عملية الاشتراك غير مدعوم.");
    }

    const nowMs = this.effects.now();
    const sentinels = this.effects.sentinels;
    const merchantRef = this.db.collection("merchants").doc(merchantId);
    const subscriptionRef = this.db.collection("subscriptions").doc(merchantId);
    const settingsRef = this.db.collection("settings").doc("manual_subscription_config");
    const restaurantRef = this.db.collection("restaurants").doc(merchantId);
    const legacyRef = legacySubscriptionId && legacySubscriptionId !== merchantId
      ? this.db.collection("subscriptions").doc(legacySubscriptionId) : null;
    const merchantAuditKey = createHash("sha256").update(merchantId).digest("hex").slice(0, 20);
    const auditRef = this.db.collection("operation_logs").doc("admin_subscription_" + merchantAuditKey + "_" + nowMs);

    return this.db.runTransaction(async (tx) => {
      const [merchantSnap, subscriptionSnap, settingsSnap, restaurantSnap, legacySnap] = await Promise.all([
        tx.get(merchantRef), tx.get(subscriptionRef), tx.get(settingsRef), tx.get(restaurantRef),
        legacyRef ? tx.get(legacyRef) : Promise.resolve(null),
      ]);
      if (!merchantSnap.exists) {
        throw new DomainHttpsError("not-found", "حساب التاجر غير موجود في مجموعة merchants؛ لا يمكن ربط الاشتراك بحساب دخول.");
      }
      const merchant = merchantSnap.data() ?? {};
      if (readString(merchant, "accountType").toLowerCase() !== "merchant") {
        throw new DomainHttpsError("failed-precondition", "المستند المحدد ليس حساب تاجر.");
      }
      const merchantAccountStatus = readString(merchant, "status").toLowerCase();
      if (!["active", "approved"].includes(merchantAccountStatus) && merchant.isApproved !== true) {
        throw new DomainHttpsError("failed-precondition", "حساب التاجر لم يحصل على موافقة الإدارة بعد.");
      }
      if (merchant.isBlocked === true || merchant.isSuspended === true ||
          ["blocked", "banned", "suspended", "disabled", "inactive"].includes(readString(merchant, "status").toLowerCase())) {
        throw new DomainHttpsError("failed-precondition", "حساب التاجر موقوف ولا يمكن إدارة اشتراكه.");
      }
      const merchantUid = readString(merchant, "uid");
      if (merchantUid && merchantUid !== merchantId) {
        throw new DomainHttpsError("permission-denied", "UID حساب التاجر غير مطابق لمعرّف المستند.");
      }

      const currentSub = subscriptionSnap.exists ? subscriptionSnap.data() ?? {} : {};
      if (legacySnap?.exists) {
        const legacyMerchantId = readString(legacySnap.data(), "merchantId", "restaurantId");
        if (legacyMerchantId && legacyMerchantId !== merchantId) {
          throw new DomainHttpsError("permission-denied", "سجل الاشتراك القديم لا يخص هذا التاجر.");
        }
      }
      let maxCaptains = readNumber(currentSub, "maxCaptains", "captainLimit", "captainsCount") ??
        readNumber(merchant, "maxCaptains", "captainLimit", "captainsCount") ?? 0;
      let planName = readString(currentSub, "planName", "plan", "subscriptionPlan") ||
        readString(merchant, "planName", "plan", "subscriptionPlan");
      let planKey = readString(currentSub, "planKey");
      let price = readNumber(currentSub, "price", "amount") ?? readNumber(merchant, "price") ?? 0;
      let startDate = readString(currentSub, "startDate", "subscriptionStartDate") || readString(merchant, "subscriptionStartDate");
      let endDate = readString(currentSub, "endDate", "subscriptionEndDate") || readString(merchant, "subscriptionEndDate");
      let durationDays = readNumber(currentSub, "durationDays") ?? 30;
      let requestedStatus = readString(data, "status").toLowerCase();

      const parseStart = (value: string): number | null => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
        const ms = Date.parse(value + "T00:00:00.000Z");
        return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
      };
      const parseEnd = (value: string): number | null => {
        const start = parseStart(value);
        return start === null ? null : start + 86_400_000 - 1;
      };

      if (operation === "upsert" || operation === "renew") {
        if (!settingsSnap.exists) throw new DomainHttpsError("failed-precondition", "إعدادات الباقات الرسمية غير موجودة.");
        const settings = settingsSnap.data() ?? {};
        const plans = Array.isArray(settings.plans) ? settings.plans as Record<string, unknown>[] : [];
        const activePlan = (cap: number) => plans.find((p) =>
          Math.round(readNumber(p, "maxCaptains", "captainsCount") ?? 0) === cap && p.isActive !== false
        );

        if (operation === "upsert") {
          maxCaptains = Math.round(readNumber(data, "maxCaptains", "captainsCount") ?? 0);
          const selectedPlan = activePlan(maxCaptains);
          if (!selectedPlan || ![2, 4, 6, 8].includes(maxCaptains)) {
            throw new DomainHttpsError("failed-precondition", "الباقة المختارة غير موجودة أو غير مفعلة في إعدادات الإدارة.");
          }
          planKey = readString(selectedPlan, "planId");
          planName = readString(selectedPlan, "planName", "label", "name") || (maxCaptains + " كابتن");
          const officialPrice = readNumber(selectedPlan, "price") ?? 0;
          const suppliedPrice = readNumber(data, "price");
          if (officialPrice <= 0 || (suppliedPrice !== null && Math.abs(suppliedPrice - officialPrice) > 0.01)) {
            throw new DomainHttpsError("failed-precondition", "السعر المرسل لا يطابق السعر الرسمي للباقة.");
          }
          price = officialPrice;
          durationDays = 30;
          startDate = readString(data, "startDate");
          endDate = readString(data, "endDate");
          requestedStatus = requestedStatus || "active";
        } else {
          if (!subscriptionSnap.exists || maxCaptains <= 0) {
            throw new DomainHttpsError("failed-precondition", "لا يوجد اشتراك حالي صالح للتجديد.");
          }
          const selectedPlan = activePlan(maxCaptains);
          if (!selectedPlan) throw new DomainHttpsError("failed-precondition", "الباقة الحالية غير موجودة أو غير مفعلة.");
          planKey = readString(selectedPlan, "planId");
          planName = readString(selectedPlan, "planName", "label", "name") || planName;
          price = readNumber(selectedPlan, "price") ?? price;
          durationDays = 30;
          const oldEndMs = parseEnd(endDate);
          const baseMs = oldEndMs !== null && oldEndMs > nowMs ? oldEndMs + 1 : nowMs;
          // Renewal starts immediately after the current paid-through date (or today if expired).
          startDate = formatYmdUtc(baseMs);
          endDate = formatYmdUtc(baseMs + durationDays * 86_400_000 - 1);
          requestedStatus = "active";
        }
        if (durationDays < 1 || durationDays > 365) throw new DomainHttpsError("failed-precondition", "مدة الباقة الرسمية غير صالحة.");
      } else if (!subscriptionSnap.exists) {
        throw new DomainHttpsError("not-found", "لا يوجد سجل اشتراك لتغيير حالته.");
      }

      const statuses: Record<string, string> = {
        active: "active", approved: "active", "ساري": "active", "نشط": "active",
        pending: "pending", "معلق": "pending",
        suspended: "suspended", inactive: "suspended", "موقوف": "suspended",
        expired: "expired", "منتهي": "expired",
        cancelled: "cancelled", canceled: "cancelled",
      };
      const nextStatus = operation === "delete" ? "cancelled" : statuses[requestedStatus];
      if (!nextStatus) throw new DomainHttpsError("invalid-argument", "حالة الاشتراك المطلوبة غير صالحة.");
      if (operation === "status" && nextStatus === "active") {
        const existingEnd = parseEnd(endDate);
        if (existingEnd !== null && existingEnd <= nowMs) {
          throw new DomainHttpsError("failed-precondition", "انتهى الاشتراك؛ استخدم التجديد بدلاً من إعادة التفعيل.");
        }
      }
      const startMs = parseStart(startDate);
      const endMs = parseEnd(endDate);
      if (operation === "upsert" && startMs !== null && endMs !== null &&
          endDate !== formatYmdUtc(startMs + durationDays * 86_400_000)) {
        throw new DomainHttpsError("invalid-argument", "تاريخ انتهاء الاشتراك لا يطابق مدة الباقة الرسمية.");
      }
      const isActive = nextStatus === "active";
      if (isActive && (startMs === null || endMs === null || endMs <= nowMs)) {
        throw new DomainHttpsError("invalid-argument", "تاريخ بداية أو نهاية الاشتراك غير صالح أو منتهي.");
      }
      if (maxCaptains <= 0 || ![2, 4, 6, 8].includes(maxCaptains) || price <= 0) {
        throw new DomainHttpsError("failed-precondition", "بيانات الباقة الحالية غير مكتملة.");
      }

      const planId = ({2: 1, 4: 2, 6: 3, 8: 4} as Record<number, number>)[maxCaptains];
      const version = Math.max(readNumber(currentSub, "subscriptionVersion") ?? 0,
        readNumber(merchant, "subscriptionVersion") ?? 0) + 1;
      const merchantName = readString(merchant, "name", "merchantName", "restaurantName") || "تاجر مسجل";
      const common = {
        merchantId, restaurantId: merchantId, merchantName, restaurantName: merchantName,
        status: nextStatus, subscriptionStatus: nextStatus, isActive, isSubscribed: isActive,
        planId, planKey: planKey || ("plan_" + maxCaptains + "_captains"), planName, plan: planName,
        maxCaptains, captainLimit: maxCaptains, captainsCount: maxCaptains,
        price, amount: price, durationDays, paymentMethod: "admin_manual",
        paymentStatus: nextStatus === "pending" ? "pending" : "admin_manual",
        startDate, subscriptionStartDate: startDate, endDate, subscriptionEndDate: endDate,
        startDateMs: startMs, endDateMs: endMs, expiresAt: endMs, subscriptionExpiresAt: endMs,
        activatedAt: isActive ? (startMs ?? nowMs) : null, pendingRequestId: null,
        suspensionReason: nextStatus === "suspended" ? "تم الإيقاف بواسطة الإدارة" : null,
        cancellationReason: nextStatus === "cancelled" ? "تم الإلغاء بواسطة الإدارة" : null,
        subscriptionVersion: version, subscriptionUpdatedAt: sentinels.serverTimestamp(),
        updatedAt: sentinels.serverTimestamp(), updatedBy: admin.uid, updatedByAdminUid: admin.uid,
        lastAdminSubscriptionAction: operation,
      };

      tx.set(subscriptionRef, common, {merge: true});
      tx.set(merchantRef, {
        subscriptionStatus: nextStatus, isSubscribed: isActive, planId,
        planKey: planKey || ("plan_" + maxCaptains + "_captains"), planName,
        subscriptionPlan: planName, maxCaptains, captainLimit: maxCaptains,
        captainsCount: maxCaptains, price, paymentMethod: "admin_manual",
        paymentStatus: nextStatus === "pending" ? "pending" : "admin_manual",
        subscriptionStartDate: startDate, subscriptionEndDate: endDate,
        subscriptionExpiresAt: endMs, pendingRequestId: null,
        suspensionReason: nextStatus === "suspended" ? "تم الإيقاف بواسطة الإدارة" : null,
        cancellationReason: nextStatus === "cancelled" ? "تم الإلغاء بواسطة الإدارة" : null,
        subscriptionVersion: version, subscriptionUpdatedAt: sentinels.serverTimestamp(),
        updatedAt: sentinels.serverTimestamp(), updatedBy: admin.uid, updatedByAdminUid: admin.uid,
      }, {merge: true});
      if (restaurantSnap.exists) {
        tx.set(restaurantRef, {
          subscriptionStatus: nextStatus, isSubscribed: isActive, subscriptionPlan: planName,
          planName, maxCaptains, captainLimit: maxCaptains, captainsCount: maxCaptains,
          subscriptionPrice: price, price, subscriptionStartDate: startDate,
          subscriptionEndDate: endDate, subscriptionExpiresAt: endMs,
          subscriptionVersion: version, subscriptionUpdatedAt: sentinels.serverTimestamp(),
          updatedAt: sentinels.serverTimestamp(),
        }, {merge: true});
      }
      if (legacyRef && legacySnap?.exists) {
        tx.set(legacyRef, {
          status: "migrated",
          subscriptionStatus: "migrated",
          isActive: false,
          isSubscribed: false,
          migratedToMerchantId: merchantId,
          migratedAt: sentinels.serverTimestamp(),
          updatedAt: sentinels.serverTimestamp(),
        }, {merge: true});
      }
      tx.set(auditRef, {
        action: "admin_" + operation + "_merchant_subscription", entityType: "merchant_subscription",
        merchantId, status: nextStatus, planId, planKey: planKey || ("plan_" + maxCaptains + "_captains"),
        maxCaptains, amount: price, startDate, endDate, paymentMethod: "admin_manual",
        adminUid: admin.uid, adminEmail: admin.email, adminName: admin.name,
        createdAt: sentinels.serverTimestamp(),
      });
      return {
        success: true, merchantId, status: nextStatus, maxCaptains, startDate, endDate,
        subscriptionVersion: version,
        message: operation === "renew" ? "تم تجديد الاشتراك ومزامنة بيانات التاجر بنجاح."
          : isActive ? "تم تفعيل الاشتراك ومزامنة بيانات التاجر وتطبيق التاجر بنجاح."
          : "تم تحديث حالة الاشتراك ومزامنة بيانات التاجر بنجاح.",
      };
    });
  }

  /**
   * 4. Updates Vodafone Cash & manual subscription settings in Firestore (Master Admin ONLY).
   * Never hardcodes wallet numbers; validates wallet format, pricing, and duration.
   * @param {CallableAuthContext | undefined} authContext Caller auth context.
   * @param {Record<string, unknown>} data Settings payload.
   * @return {Promise<UpdateSettingsResult>} Saved settings.
   */
  async updateManualSubscriptionSettings(
    authContext: CallableAuthContext | undefined,
    data: Record<string, unknown>
  ): Promise<UpdateSettingsResult> {
    const masterAdmin = await this.requireMasterAdmin(authContext);
    const s = this.effects.sentinels;
    const nowMs = this.effects.now();

    const rawWallet = normalizePhoneDigits(
      readString(data, "vodafoneCashNumber", "walletNumber")
    );
    const walletHolderName =
      typeof data?.walletHolderName === "string"
        ? data.walletHolderName.trim().slice(0, 120)
        : "";
    const isAcceptingSubscriptions = data?.isAcceptingSubscriptions !== false;
    const pauseMessage =
      typeof data?.pauseMessage === "string"
        ? data.pauseMessage.trim().slice(0, 300)
        : "";
    // Subscription duration is a fixed business rule, not an editable setting.
    const durationDays = 30;

    if (isAcceptingSubscriptions) {
      if (!/^01[0125]\d{8}$/.test(rawWallet)) {
        throw new DomainHttpsError(
          "invalid-argument",
          "رقم محفظة فودافون كاش غير صالح (يجب أن يكون 11 رقماً مصرياً مثل 010xxxxxxxx)."
        );
      }
    } else if (rawWallet && !/^01[0125]\d{8}$/.test(rawWallet)) {
      throw new DomainHttpsError(
        "invalid-argument",
        "صيغة رقم المحفظة غير صالحة."
      );
    }

    if (durationDays < 1 || durationDays > 365) {
      throw new DomainHttpsError(
        "invalid-argument",
        "مدة الاشتراك بالأيام يجب أن تكون بين 1 و 365 يوماً."
      );
    }

    const rawPlans = Array.isArray(data?.plans) ? data.plans : [];
    if (rawPlans.length === 0) {
      throw new DomainHttpsError(
        "invalid-argument",
        "يجب تحديد باقة اشتراك واحدة على الأقل."
      );
    }

    const seenPlanIds = new Set<string>();
    const plans: OfficialPlanConfig[] = [];
    for (const item of rawPlans) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const maxCaptainsRaw = readNumber(obj, "maxCaptains", "captainsCount");
      const priceRaw = readNumber(obj, "price");
      const maxCaptains = maxCaptainsRaw !== null ? Math.round(maxCaptainsRaw) : 0;
      const price = priceRaw !== null ? Math.round(priceRaw * 100) / 100 : 0;
      const planDurationDays = 30;
      const planId =
        readString(obj, "planId") || `plan_${maxCaptains}_captains`;
      const planName =
        readString(obj, "planName", "label", "name") ||
        `${maxCaptains} كابتن - ${price} جنيه`;

      if (!isValidDocId(planId) || seenPlanIds.has(planId)) {
        throw new DomainHttpsError(
          "invalid-argument",
          `معرّف الباقة (${planId}) غير صالح أو مكرر.`
        );
      }
      if (maxCaptains < 1 || maxCaptains > 100) {
        throw new DomainHttpsError(
          "invalid-argument",
          `عدد الكباتن في الباقة "${planName}" يجب أن يكون بين 1 و 100.`
        );
      }
      if (price <= 0 || price > 100000) {
        throw new DomainHttpsError(
          "invalid-argument",
          `سعر الباقة "${planName}" غير صالح.`
        );
      }
      seenPlanIds.add(planId);
      plans.push({
        planId,
        planName,
        maxCaptains,
        price,
        durationDays: planDurationDays,
        isActive: obj.isActive !== false,
      });
    }

    if (plans.length === 0) {
      throw new DomainHttpsError(
        "invalid-argument",
        "قائمة باقات الاشتراك غير صالحة."
      );
    }

    const settingsPayload: ManualSubscriptionSettingsDoc = {
      vodafoneCashNumber: rawWallet,
      walletHolderName,
      isAcceptingSubscriptions,
      pauseMessage,
      durationDays,
      plans,
    };

    const settingsRef = this.db
      .collection("settings")
      .doc("manual_subscription_config");
    const opLogRef = this.db
      .collection("operation_logs")
      .doc(`update_manual_sub_settings_${nowMs}`);

    await this.db.runTransaction(async (tx) => {
      tx.set(
        settingsRef,
        {
          ...settingsPayload,
          updatedBy: masterAdmin.uid,
          updatedByEmail: masterAdmin.email,
          updatedByName: masterAdmin.name,
          updatedAt: s.serverTimestamp(),
        },
        {merge: true}
      );

      tx.set(opLogRef, {
        action: "update_manual_subscription_settings",
        entityType: "settings",
        settingsDocId: "manual_subscription_config",
        vodafoneCashNumber: rawWallet,
        isAcceptingSubscriptions,
        durationDays,
        plansCount: plans.length,
        adminUid: masterAdmin.uid,
        adminEmail: masterAdmin.email,
        adminName: masterAdmin.name,
        createdAt: s.serverTimestamp(),
      });
    });

    return {
      success: true,
      settings: settingsPayload,
      updatedBy: masterAdmin.uid,
      message: "تم حفظ إعدادات الاشتراكات وفودافون كاش بنجاح.",
    };
  }

  /**
   * 5. Trigger handler when a merchant submits a new manual subscription request.
   * Creates a deterministic admin alert notification and dispatches admin FCM tokens if available.
   * @param {string} requestId Newly created request document ID.
   * @param {Record<string, unknown>} reqData Request fields.
   */
  async handleNewManualSubscriptionRequest(
    requestId: string,
    reqData: Record<string, unknown>
  ): Promise<void> {
    if (!requestId || !reqData) return;
    const s = this.effects.sentinels;

    const merchantId = readString(reqData, "merchantId", "restaurantId", "uid");
    const merchantName =
      readString(reqData, "merchantName", "restaurantName") || "تاجر مسجل";
    const planName = readString(reqData, "planName", "plan") || "باقة اشتراك";
    const amount = readNumber(reqData, "amount", "price") ?? 0;

    // Use a deterministic document and create it only once. A retried
    // Firestore event must not reset isRead after an admin has opened the alert.
    const notificationRef = this.db
      .collection("notifications")
      .doc(`manual_sub_req_${requestId}`);
    const notificationCreated = await this.db.runTransaction(async (tx) => {
      const existing = await tx.get(notificationRef);
      if (existing.exists) return false;
      tx.set(notificationRef, {
        type: "manual_subscription_request",
        targetRole: "admin",
        title: `طلب اشتراك فودافون كاش جديد — ${merchantName}`,
        message: `أرسل التاجر "${merchantName}" إيصال تحويل بمبلغ ${amount} ج.م للباقة "${planName}" بانتظار المراجعة.`,
        body: `أرسل التاجر "${merchantName}" إيصال تحويل بمبلغ ${amount} ج.م للباقة "${planName}" بانتظار المراجعة.`,
        requestId,
        merchantId,
        restaurantName: merchantName,
        planName,
        amount,
        isRead: false,
        createdAt: s.serverTimestamp(),
      });
      return true;
    });

    // The in-app notification is the durable alert. Send its push only for the
    // first successful creation so duplicate event deliveries cannot spam admins.
    if (!notificationCreated) return;

    // Collect admin FCM tokens if registered
    const adminTokens = new Set<string>();
    const adminsSnap = await this.db.collection("admins").limit(20).get();
    for (const doc of adminsSnap.docs) {
      const token = readString(doc.data(), "fcmToken");
      if (token) adminTokens.add(token);
    }

    if (adminTokens.size > 0) {
      await this.effects.sendAdminNewManualRequestNotification({
        requestId,
        merchantId,
        merchantName,
        planName,
        amount,
        tokens: Array.from(adminTokens),
      });
    }
  }
}
