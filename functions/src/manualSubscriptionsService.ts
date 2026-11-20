import {
  CallableAuthContext,
  DatabaseLike,
  DomainHttpsError,
  ManualSubscriptionEffectsPort,
} from "./types.js";
import {readNumber, readString} from "./validators.js";

const MASTER_ADMIN_EMAILS = new Set([
  "moamen.elsayed.abdelmoamen@gmail.com",
]);

const SUPER_ADMIN_EMAILS = new Set([
  "moamen.elsayed.abdelmoamen@gmail.com",
  "admin@elbatalexpress.com",
]);

const REVIEWABLE_STATUSES = new Set([
  "pending",
  "under_review",
  "pending_review",
  "resubmission_requested",
]);

export interface OfficialPlanConfig {
  planId: string;
  planName: string;
  maxCaptains: number;
  price: number;
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
  status: "resubmission_requested";
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

function formatYmdUtc(ms: number): string {
  return new Date(ms).toISOString().split("T")[0];
}

function normalizeStatus(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
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
      `merchants/${merchantId}/`,
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
      `merchants/${merchantId}/`,
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

      const settingsData = settingsSnap.exists ? settingsSnap.data() ?? {} : {};
      const configuredDuration = readNumber(settingsData, "durationDays");
      const requestDuration = readNumber(reqData, "durationDays");
      const durationDays =
        configuredDuration && configuredDuration >= 1 && configuredDuration <= 365
          ? Math.round(configuredDuration)
          : requestDuration && requestDuration >= 1 && requestDuration <= 365
            ? Math.round(requestDuration)
            : 30;

      // Resolve official plan from settings if matched, while keeping compatibility with request fields
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
      const amount =
        readNumber(reqData, "amount", "price", "requiredAmount") ??
        readNumber(matchedPlan, "price") ??
        0;

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
          startDate: startDateYmd,
          endDate: endDateYmd,
          startDateMs,
          endDateMs,
          expiresAt: endDateMs,
          durationDays,
          approvedBy: admin.uid,
          approvedByEmail: admin.email,
          approvedAt: s.serverTimestamp(),
          subscriptionVersion: nextVersion,
          updatedAt: s.serverTimestamp(),
        },
        {merge: true}
      );

      // 3. Sync merchants/{merchantId} (fully compatible with Merchant App)
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
          paymentStatus: "paid",
          subscriptionStartDate: startDateYmd,
          subscriptionEndDate: endDateYmd,
          subscriptionExpiresAt: endDateMs,
          startDate: startDateYmd,
          endDate: endDateYmd,
          expiresAt: endDateMs,
          lastApprovedRequestId: requestId,
          lastPaymentId: paymentDocId,
          subscriptionVersion: nextVersion,
          updatedAt: s.serverTimestamp(),
        },
        {merge: true}
      );

      // 4. Create single deterministic financial payment transaction
      tx.set(paymentRef, {
        id: paymentDocId,
        requestId,
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
        paymentMethod: "Vodafone Cash",
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
        date: startDateYmd,
        notes: `تفعيل اشتراك يدوي (${planName}) عبر فودافون كاش — طلب #${requestId}`,
        createdAt: s.serverTimestamp(),
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

      const merchantSnap = await tx.get(
        this.db.collection("merchants").doc(merchantId)
      );
      const merchantData = merchantSnap.exists ? merchantSnap.data() ?? {} : {};
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
   * @param {CallableAuthContext | undefined} authContext Caller auth context.
   * @param {Record<string, unknown>} data Payload containing requestId and note.
   * @return {Promise<ResubmissionRequestResult>} Resubmission request result.
   */
  async requestManualSubscriptionResubmission(
    authContext: CallableAuthContext | undefined,
    data: Record<string, unknown>
  ): Promise<ResubmissionRequestResult> {
    const admin = await this.requireAdmin(authContext);
    const requestId = readString(data, "requestId");
    const note = readString(data, "note", "resubmissionNote", "reason");

    if (!requestId || !isValidDocId(requestId)) {
      throw new DomainHttpsError("invalid-argument", "معرّف طلب الاشتراك غير صالح.");
    }
    if (!note || note.length < 3) {
      throw new DomainHttpsError(
        "invalid-argument",
        "يرجى كتابة ملاحظة واضحة للتاجر توضح المطلوب إعادة رفعه."
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
      const currentStatus = normalizeStatus(reqData.status) || "pending";
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

      const merchantSnap = await tx.get(
        this.db.collection("merchants").doc(merchantId)
      );
      const merchantData = merchantSnap.exists ? merchantSnap.data() ?? {} : {};
      merchantFcmToken = readString(merchantData, "fcmToken");
      planName = readString(reqData, "planName", "plan") || "باقة الاشتراك";

      const reviewEntry = {
        action: "resubmission_requested",
        reviewerId: admin.uid,
        reviewerEmail: admin.email,
        reviewerName: admin.name,
        note: cleanNote,
        timestampMs: nowMs,
        timestampIso: new Date(nowMs).toISOString(),
      };

      tx.update(requestRef, {
        status: "resubmission_requested",
        paymentStatus: "resubmission_requested",
        resubmissionNote: cleanNote,
        lastReviewedBy: admin.uid,
        lastReviewedByEmail: admin.email,
        lastReviewedByName: admin.name,
        lastReviewedAt: s.serverTimestamp(),
        lastReviewedAtMs: nowMs,
        reviewHistory: s.arrayUnion(reviewEntry),
        updatedAt: s.serverTimestamp(),
      });

      tx.set(opLogRef, {
        action: "request_manual_subscription_resubmission",
        entityType: "manual_subscription_request",
        requestId,
        merchantId,
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
        status: "resubmission_requested" as const,
        note: cleanNote,
        reviewedBy: admin.uid,
        message: "تم إرسال طلب إعادة رفع الإيصال إلى التاجر دون تفعيل الاشتراك.",
      };
    });

    const notifTitle = "مطلوب إعادة رفع إيصال التحويل";
    const notifBody = `يرجى إعادة رفع إيصال الاشتراك (${planName}). ملاحظة الإدارة: ${cleanNote}`;

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
    const durationDaysRaw = readNumber(data, "durationDays");
    const durationDays =
      durationDaysRaw !== null ? Math.round(durationDaysRaw) : 30;

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

    await this.db
      .collection("notifications")
      .doc(`manual_sub_req_${requestId}`)
      .set(
        {
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
        },
        {merge: true}
      );

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
