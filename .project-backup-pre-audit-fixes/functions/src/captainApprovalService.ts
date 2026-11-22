import {
  CallableAuthContext,
  CaptainAccountStatus,
  CaptainApprovalEffectsPort,
  CaptainApprovalEventType,
  DatabaseLike,
  DomainHttpsError,
} from "./types.js";
import {
  isEligibleCaptainIdentity,
  readString,
  resolveCaptainAccountStatus,
} from "./validators.js";

const ADMIN_EMAIL_ALLOWLIST = new Set([
  "moamen.elsayed.abdelmoamen@gmail.com",
  "admin@elbatalexpress.com",
]);

export interface AdminActor {
  uid: string;
  email: string;
  name: string;
}

export interface CaptainModerationResult {
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

function isValidDocId(id: string): boolean {
  return id.length >= 1 && id.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(id);
}

/**
 * Authoritative server-side service for reviewing, approving, rejecting,
 * suspending, reactivating, and blocking captain accounts.
 */
export class CaptainApprovalServerService {
  private readonly db: DatabaseLike;
  private readonly effects: CaptainApprovalEffectsPort;

  /**
   * Constructs the CaptainApprovalServerService.
   * @param {DatabaseLike} db Firestore-compatible database adapter.
   * @param {CaptainApprovalEffectsPort} effects Clock, sentinels, and FCM effects port.
   */
  constructor(db: DatabaseLike, effects: CaptainApprovalEffectsPort) {
    this.db = db;
    this.effects = effects;
  }

  private async requireVerifiedAdmin(
    authContext: CallableAuthContext | undefined
  ): Promise<AdminActor> {
    const uid = typeof authContext?.uid === "string" ? authContext.uid.trim() : "";
    if (!uid) {
      throw new DomainHttpsError(
        "unauthenticated",
        "يجب تسجيل الدخول بحساب مدير معتمد لتنفيذ هذا الإجراء."
      );
    }

    const token = authContext?.token ?? {};
    const tokenEmail =
      typeof token.email === "string" ? token.email.trim().toLowerCase() : "";
    const tokenEmailVerified = token.email_verified === true;
    const tokenRole =
      typeof token.role === "string" ? token.role.trim().toLowerCase() : "";
    const tokenIsAdmin = token.admin === true || tokenRole === "admin";

    const adminSnap = await this.db.collection("admins").doc(uid).get();
    const adminDocData = adminSnap.exists ? adminSnap.data() ?? {} : undefined;

    const docRole = readString(adminDocData, "role").toLowerCase();
    const docStatus = readString(adminDocData, "status").toLowerCase();
    const isAdminByDoc =
      Boolean(adminDocData) &&
      (!docRole || docRole === "admin" || docRole === "super_admin") &&
      adminDocData?.emailVerified === true &&
      ["active", "approved"].includes(docStatus);

    const isAllowlistedByEmail =
      Boolean(tokenEmail) &&
      ADMIN_EMAIL_ALLOWLIST.has(tokenEmail) &&
      tokenEmailVerified;

    if (!tokenIsAdmin && !isAdminByDoc && !isAllowlistedByEmail) {
      throw new DomainHttpsError(
        "permission-denied",
        "هذا الحساب لا يمتلك صلاحية مدير نشطة ومعتمدة لإدارة حسابات الكباتن."
      );
    }

    const name =
      readString(adminDocData, "displayName", "name") ||
      (typeof token.name === "string" && token.name.trim() ? token.name.trim() : "") ||
      tokenEmail ||
      "مدير النظام";

    return {
      uid,
      email: tokenEmail || readString(adminDocData, "email"),
      name,
    };
  }

  private requireCaptainId(data: Record<string, unknown>): string {
    const captainId = readString(data, "captainId", "uid");
    if (!captainId || !isValidDocId(captainId)) {
      throw new DomainHttpsError("invalid-argument", "معرّف الكابتن غير صالح.");
    }
    return captainId;
  }

  private requireReason(data: Record<string, unknown>, actionLabel: string): string {
    const reason = readString(data, "reason", "rejectionReason", "suspensionReason", "blockReason", "note")
      .trim()
      .slice(0, 500);
    if (reason.length < 3) {
      throw new DomainHttpsError(
        "invalid-argument",
        `يرجى إدخال سبب واضح (${actionLabel}) لا يقل عن 3 أحرف.`
      );
    }
    return reason;
  }

  private async executeModerationAction(params: {
    authContext: CallableAuthContext | undefined;
    data: Record<string, unknown>;
    action: "approved" | "rejected" | "suspended" | "reactivated" | "blocked";
    targetAccountStatus: CaptainAccountStatus;
    targetOperationalStatus: string;
    requireReason: boolean;
    actionArabicLabel: string;
    notificationTitle: string;
    notificationBodyBuilder: (captainName: string, reason: string, note: string) => string;
    successMessageBuilder: (captainName: string) => string;
  }): Promise<CaptainModerationResult> {
    const admin = await this.requireVerifiedAdmin(params.authContext);
    const captainId = this.requireCaptainId(params.data);
    const note = readString(params.data, "note", "adminNote").trim().slice(0, 500);
    const reason = params.requireReason
      ? this.requireReason(params.data, params.actionArabicLabel)
      : note;

    const nowMs = this.effects.now();
    const s = this.effects.sentinels;
    const captainRef = this.db.collection("captains").doc(captainId);
    const auditLogId = `capt_${captainId}_${params.action}_${nowMs}`;
    const auditRef = this.db.collection("captain_audit_logs").doc(auditLogId);
    const opLogRef = this.db.collection("operation_logs").doc(auditLogId);

    let captainFcmToken = "";
    let captainName = "كابتن البطل";
    let previousAccountStatus: CaptainAccountStatus = "pending";

    await this.db.runTransaction(async (tx) => {
      const captainSnap = await tx.get(captainRef);
      if (!captainSnap.exists) {
        throw new DomainHttpsError("not-found", "حساب الكابتن غير موجود في النظام.");
      }

      const existingData = captainSnap.data() ?? {};
      if (!isEligibleCaptainIdentity(existingData)) {
        throw new DomainHttpsError(
          "failed-precondition",
          "هذا المستند لا يمثل حساب كابتن صالح."
        );
      }

      previousAccountStatus = resolveCaptainAccountStatus(existingData);
      captainName = readString(existingData, "fullName", "name") || "كابتن البطل";
      captainFcmToken = readString(existingData, "fcmToken", "pushToken");

      const captainPatch: Record<string, unknown> = {
        accountStatus: params.targetAccountStatus,
        isApproved: params.targetAccountStatus === "approved",
        status: params.targetOperationalStatus,
        statusUpdatedAt: s.serverTimestamp(),
        updatedAt: s.serverTimestamp(),
        lastModeratedAt: s.serverTimestamp(),
        lastModeratedBy: admin.uid,
        lastModeratedByName: admin.name,
        lastModerationAction: params.action,
      };

      if (params.targetAccountStatus === "approved") {
        captainPatch.isBlocked = false;
        captainPatch.isSuspended = false;
        captainPatch.canReceiveOrders = true;
        captainPatch.isReceivingOrders = true;
        captainPatch.receiveOrders = true;
        captainPatch.orderReceptionDisabled = false;
        if (params.action === "approved") {
          captainPatch.approvedAt = s.serverTimestamp();
          captainPatch.approvedBy = admin.uid;
          captainPatch.approvedByName = admin.name;
          captainPatch.approvedByEmail = admin.email;
        } else {
          captainPatch.reactivatedAt = s.serverTimestamp();
          captainPatch.reactivatedBy = admin.uid;
          captainPatch.reactivatedByName = admin.name;
          captainPatch.reactivatedByEmail = admin.email;
        }
        captainPatch.rejectionReason = s.deleteField();
        captainPatch.suspensionReason = s.deleteField();
        captainPatch.blockReason = s.deleteField();
      } else {
        captainPatch.isOnline = false;
        captainPatch.availabilityStatus = "offline";
        captainPatch.presenceStatus = "offline";
        captainPatch.canReceiveOrders = false;
        captainPatch.isReceivingOrders = false;
        captainPatch.receiveOrders = false;
        captainPatch.orderReceptionDisabled = true;

        if (params.targetAccountStatus === "rejected") {
          captainPatch.isBlocked = false;
          captainPatch.isSuspended = false;
          captainPatch.rejectedAt = s.serverTimestamp();
          captainPatch.rejectedBy = admin.uid;
          captainPatch.rejectedByName = admin.name;
          captainPatch.rejectedByEmail = admin.email;
          captainPatch.rejectionReason = reason;
        } else if (params.targetAccountStatus === "suspended") {
          captainPatch.isBlocked = false;
          captainPatch.isSuspended = true;
          captainPatch.suspendedAt = s.serverTimestamp();
          captainPatch.suspendedBy = admin.uid;
          captainPatch.suspendedByName = admin.name;
          captainPatch.suspendedByEmail = admin.email;
          captainPatch.suspensionReason = reason;
        } else if (params.targetAccountStatus === "blocked") {
          captainPatch.isBlocked = true;
          captainPatch.isSuspended = false;
          captainPatch.blockedAt = s.serverTimestamp();
          captainPatch.blockedBy = admin.uid;
          captainPatch.blockedByName = admin.name;
          captainPatch.blockedByEmail = admin.email;
          captainPatch.blockReason = reason;
        }
      }

      tx.update(captainRef, captainPatch);

      const auditPayload: Record<string, unknown> = {
        id: auditLogId,
        captainId,
        captainName,
        captainPhone: readString(existingData, "phone", "phoneNumber"),
        action: params.action,
        previousAccountStatus,
        newAccountStatus: params.targetAccountStatus,
        reason: reason || "",
        note: note || "",
        performedByUid: admin.uid,
        performedByEmail: admin.email,
        performedByName: admin.name,
        createdAt: s.serverTimestamp(),
        createdAtMs: nowMs,
      };
      tx.set(auditRef, auditPayload);

      tx.set(opLogRef, {
        id: auditLogId,
        action: `captain_${params.action}`,
        category: "captain_moderation",
        targetCollection: "captains",
        targetId: captainId,
        captainId,
        captainName,
        previousStatus: previousAccountStatus,
        newStatus: params.targetAccountStatus,
        reason: reason || "",
        note: note || "",
        actorUid: admin.uid,
        actorEmail: admin.email,
        actorName: admin.name,
        createdAt: s.serverTimestamp(),
        createdAtMs: nowMs,
      });
    });

    const notificationBody = params.notificationBodyBuilder(captainName, reason, note);

    try {
      await captainRef.collection("notifications").doc(auditLogId).set({
        id: auditLogId,
        type: "captain_account_status",
        eventType: params.action,
        accountStatus: params.targetAccountStatus,
        title: params.notificationTitle,
        body: notificationBody,
        reason: reason || "",
        note: note || "",
        isRead: false,
        createdAt: s.serverTimestamp(),
        createdAtMs: nowMs,
      });
    } catch {
      // Non-fatal post-commit notification record failure
    }

    await this.effects.sendCaptainStatusNotification({
      captainId,
      fcmToken: captainFcmToken,
      eventType: params.action,
      accountStatus: params.targetAccountStatus,
      title: params.notificationTitle,
      body: notificationBody,
      reason: reason || undefined,
      dedupeKey: auditLogId,
    });

    return {
      success: true,
      captainId,
      captainName,
      previousAccountStatus,
      accountStatus: params.targetAccountStatus,
      isApproved: params.targetAccountStatus === "approved",
      status: params.targetOperationalStatus,
      auditLogId,
      moderatedBy: admin.uid,
      moderatedByName: admin.name,
      moderatedByEmail: admin.email,
      reason: reason || undefined,
      note: note || undefined,
      message: params.successMessageBuilder(captainName),
    };
  }

  /**
   * Approves a pending or previously rejected captain account.
   * @param {CallableAuthContext | undefined} authContext Caller auth context.
   * @param {Record<string, unknown>} data Payload containing captainId and optional note.
   * @return {Promise<CaptainModerationResult>} Moderation outcome.
   */
  async approveCaptain(
    authContext: CallableAuthContext | undefined,
    data: Record<string, unknown>
  ): Promise<CaptainModerationResult> {
    return this.executeModerationAction({
      authContext,
      data,
      action: "approved",
      targetAccountStatus: "approved",
      targetOperationalStatus: "offline",
      requireReason: false,
      actionArabicLabel: "موافقة",
      notificationTitle: "تم اعتماد حسابك في البطل إكسبريس 🎉",
      notificationBodyBuilder: (name) =>
        `مرحباً كابتن ${name}! تمت مراجعة بياناتك واعتماد حسابك بنجاح. يمكنك الآن الدخول وبدء استقبال طلبات التوصيل.`,
      successMessageBuilder: (name) => `تمت الموافقة على حساب الكابتن "${name}" وتفعيله بنجاح.`,
    });
  }

  /**
   * Rejects a captain registration request with a mandatory reason.
   * @param {CallableAuthContext | undefined} authContext Caller auth context.
   * @param {Record<string, unknown>} data Payload containing captainId and mandatory reason.
   * @return {Promise<CaptainModerationResult>} Moderation outcome.
   */
  async rejectCaptain(
    authContext: CallableAuthContext | undefined,
    data: Record<string, unknown>
  ): Promise<CaptainModerationResult> {
    return this.executeModerationAction({
      authContext,
      data,
      action: "rejected",
      targetAccountStatus: "rejected",
      targetOperationalStatus: "rejected",
      requireReason: true,
      actionArabicLabel: "رفض الحساب",
      notificationTitle: "تم رفض طلب تسجيل حساب الكابتن",
      notificationBodyBuilder: (_name, reason) =>
        `عذراً، لم يتم قبول طلب انضمامك. السبب: ${reason}`,
      successMessageBuilder: (name) => `تم رفض طلب تسجيل الكابتن "${name}" وحفظ السبب.`,
    });
  }

  /**
   * Suspends an approved/active captain account temporarily with a mandatory reason.
   * @param {CallableAuthContext | undefined} authContext Caller auth context.
   * @param {Record<string, unknown>} data Payload containing captainId and mandatory reason.
   * @return {Promise<CaptainModerationResult>} Moderation outcome.
   */
  async suspendCaptain(
    authContext: CallableAuthContext | undefined,
    data: Record<string, unknown>
  ): Promise<CaptainModerationResult> {
    return this.executeModerationAction({
      authContext,
      data,
      action: "suspended",
      targetAccountStatus: "suspended",
      targetOperationalStatus: "suspended",
      requireReason: true,
      actionArabicLabel: "إيقاف الحساب",
      notificationTitle: "تم إيقاف حسابك مؤقتاً",
      notificationBodyBuilder: (_name, reason) =>
        `تم إيقاف حساب الكابتن الخاص بك مؤقتاً من قبل الإدارة. السبب: ${reason}`,
      successMessageBuilder: (name) => `تم إيقاف حساب الكابتن "${name}" مؤقتاً ومنعه من استقبال الطلبات.`,
    });
  }

  /**
   * Reactivates a suspended, rejected, or blocked captain back to approved status.
   * @param {CallableAuthContext | undefined} authContext Caller auth context.
   * @param {Record<string, unknown>} data Payload containing captainId and optional note.
   * @return {Promise<CaptainModerationResult>} Moderation outcome.
   */
  async reactivateCaptain(
    authContext: CallableAuthContext | undefined,
    data: Record<string, unknown>
  ): Promise<CaptainModerationResult> {
    return this.executeModerationAction({
      authContext,
      data,
      action: "reactivated",
      targetAccountStatus: "approved",
      targetOperationalStatus: "offline",
      requireReason: false,
      actionArabicLabel: "إعادة التفعيل",
      notificationTitle: "تمت إعادة تفعيل حسابك في البطل إكسبريس",
      notificationBodyBuilder: (name) =>
        `مرحباً كابتن ${name}! تمت إعادة تفعيل حسابك بنجاح ويمكنك العودة للعمل واستقبال الطلبات الآن.`,
      successMessageBuilder: (name) => `تمت إعادة تفعيل حساب الكابتن "${name}" بنجاح.`,
    });
  }

  /**
   * Permanently blocks a captain account with a mandatory reason.
   * @param {CallableAuthContext | undefined} authContext Caller auth context.
   * @param {Record<string, unknown>} data Payload containing captainId and mandatory reason.
   * @return {Promise<CaptainModerationResult>} Moderation outcome.
   */
  async blockCaptain(
    authContext: CallableAuthContext | undefined,
    data: Record<string, unknown>
  ): Promise<CaptainModerationResult> {
    return this.executeModerationAction({
      authContext,
      data,
      action: "blocked",
      targetAccountStatus: "blocked",
      targetOperationalStatus: "blocked",
      requireReason: true,
      actionArabicLabel: "حظر الحساب",
      notificationTitle: "تم حظر حسابك من منصة البطل إكسبريس",
      notificationBodyBuilder: (_name, reason) =>
        `تم حظر حسابك نهائياً ولا يمكنك استخدام المنصة. السبب: ${reason}`,
      successMessageBuilder: (name) => `تم حظر حساب الكابتن "${name}" نهائياً بنجاح.`,
    });
  }

  /**
   * Trigger handler invoked on `onDocumentCreated("captains/{captainId}")`.
   * Records initial registration audit entry, creates idempotent admin & captain notifications,
   * and pushes FCM alerts without overriding existing approved legacy docs.
   * @param {string} captainId Created captain UID.
   * @param {Record<string, unknown>} data Captain document fields.
   * @return {Promise<void>} Completion promise.
   */
  async handleNewCaptainCreated(
    captainId: string,
    data: Record<string, unknown>
  ): Promise<void> {
    if (!captainId || !isEligibleCaptainIdentity(data)) {
      return;
    }

    const accountStatus = resolveCaptainAccountStatus(data);
    if (accountStatus !== "pending") {
      return;
    }

    const nowMs = this.effects.now();
    const s = this.effects.sentinels;
    const captainName = readString(data, "fullName", "name") || "كابتن جديد";
    const captainPhone = readString(data, "phone", "phoneNumber");
    const vehicleType = readString(data, "vehicleType", "vehicle");
    const captainFcmToken = readString(data, "fcmToken", "pushToken");

    const adminNotifRef = this.db
      .collection("notifications")
      .doc(`new_captain_${captainId}`);
    const initialAuditRef = this.db
      .collection("captain_audit_logs")
      .doc(`capt_${captainId}_registration_received`);

    let createdAdminAlert = false;
    await this.db.runTransaction(async (tx) => {
      const [adminNotifSnap, auditSnap] = await Promise.all([
        tx.get(adminNotifRef),
        tx.get(initialAuditRef),
      ]);

      if (!adminNotifSnap.exists) {
        createdAdminAlert = true;
        tx.set(adminNotifRef, {
          id: `new_captain_${captainId}`,
          type: "new_captain_registration",
          targetRole: "admin",
          title: `طلب تسجيل كابتن جديد — ${captainName}`,
          body: `تقدم الكابتن "${captainName}" (${captainPhone || "بدون هاتف"}) بطلب تسجيل جديد وهو بانتظار المراجعة والاعتماد.`,
          captainId,
          captainName,
          captainPhone,
          isRead: false,
          createdAt: s.serverTimestamp(),
          createdAtMs: nowMs,
        });
      }

      if (!auditSnap.exists) {
        tx.set(initialAuditRef, {
          id: `capt_${captainId}_registration_received`,
          captainId,
          captainName,
          captainPhone,
          action: "registration_received" as CaptainApprovalEventType,
          previousAccountStatus: "pending",
          newAccountStatus: "pending",
          reason: "",
          note: "تم استلام طلب تسجيل كابتن جديد وإدراجه في قائمة انتظار المراجعة.",
          performedByUid: captainId,
          performedByEmail: readString(data, "email"),
          performedByName: captainName,
          createdAt: s.serverTimestamp(),
          createdAtMs: nowMs,
        });
      }
    });

    if (!createdAdminAlert) {
      return;
    }

    try {
      await this.db
        .collection("captains")
        .doc(captainId)
        .collection("notifications")
        .doc(`welcome_${captainId}`)
        .set({
          id: `welcome_${captainId}`,
          type: "captain_account_status",
          eventType: "registration_received",
          accountStatus: "pending",
          title: "تم استلام طلب تسجيلك في البطل إكسبريس",
          body: "جاري مراجعة بياناتك ومستنداتك من قبل فريق الإدارة. سيتم إشعارك فور الاعتماد.",
          isRead: false,
          createdAt: s.serverTimestamp(),
          createdAtMs: nowMs,
        });
    } catch {
      // Non-fatal
    }

    if (captainFcmToken) {
      await this.effects.sendCaptainStatusNotification({
        captainId,
        fcmToken: captainFcmToken,
        eventType: "registration_received",
        accountStatus: "pending",
        title: "تم استلام طلب تسجيلك",
        body: "طلبك قيد المراجعة الآن من قبل إدارة البطل إكسبريس.",
        dedupeKey: `welcome_${captainId}`,
      });
    }

    try {
      const adminsSnap = await this.db
        .collection("admins")
        .where("status", "in", ["active", "approved"])
        .limit(50)
        .get();
      const adminTokens = Array.from(
        new Set(
          adminsSnap.docs
            .map((d) => readString(d.data(), "fcmToken", "webFcmToken"))
            .filter(Boolean)
        )
      );
      if (adminTokens.length > 0) {
        await this.effects.sendAdminNewCaptainNotification({
          captainId,
          captainName,
          captainPhone,
          vehicleType,
          tokens: adminTokens,
        });
      }
    } catch {
      // Non-fatal
    }
  }
}
