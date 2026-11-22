"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CaptainApprovalServerService = void 0;
const types_js_1 = require("./types.js");
const validators_js_1 = require("./validators.js");
function isValidDocId(id) {
    return id.length >= 1 && id.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(id);
}
/**
 * Authoritative server-side service for reviewing, approving, rejecting,
 * suspending, reactivating, and blocking captain accounts.
 */
class CaptainApprovalServerService {
    /**
     * Constructs the CaptainApprovalServerService.
     * @param {DatabaseLike} db Firestore-compatible database adapter.
     * @param {CaptainApprovalEffectsPort} effects Clock, sentinels, and FCM effects port.
     */
    constructor(db, effects) {
        this.db = db;
        this.effects = effects;
    }
    async requireVerifiedAdmin(authContext) {
        var _a;
        const uid = typeof (authContext === null || authContext === void 0 ? void 0 : authContext.uid) === "string" ? authContext.uid.trim() : "";
        const adminSnap = uid ? await this.db.collection("admins").doc(uid).get() : null;
        const verified = (0, validators_js_1.evaluateVerifiedAdminAccess)({
            authContext,
            adminDocExists: Boolean(adminSnap === null || adminSnap === void 0 ? void 0 : adminSnap.exists),
            adminDocData: (adminSnap === null || adminSnap === void 0 ? void 0 : adminSnap.exists) ? ((_a = adminSnap.data()) !== null && _a !== void 0 ? _a : {}) : undefined,
        });
        return {
            uid: verified.uid,
            email: verified.email,
            name: verified.name,
        };
    }
    requireCaptainId(data) {
        const captainId = (0, validators_js_1.readString)(data, "captainId", "uid");
        if (!captainId || !isValidDocId(captainId)) {
            throw new types_js_1.DomainHttpsError("invalid-argument", "معرّف الكابتن غير صالح.");
        }
        return captainId;
    }
    requireReason(data, actionLabel) {
        const reason = (0, validators_js_1.readString)(data, "reason", "rejectionReason", "suspensionReason", "blockReason", "note")
            .trim()
            .slice(0, 500);
        if (reason.length < 3) {
            throw new types_js_1.DomainHttpsError("invalid-argument", `يرجى إدخال سبب واضح (${actionLabel}) لا يقل عن 3 أحرف.`);
        }
        return reason;
    }
    async executeModerationAction(params) {
        const admin = await this.requireVerifiedAdmin(params.authContext);
        const captainId = this.requireCaptainId(params.data);
        const note = (0, validators_js_1.readString)(params.data, "note", "adminNote").trim().slice(0, 500);
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
        let previousAccountStatus = "pending";
        await this.db.runTransaction(async (tx) => {
            var _a;
            const captainSnap = await tx.get(captainRef);
            if (!captainSnap.exists) {
                throw new types_js_1.DomainHttpsError("not-found", "حساب الكابتن غير موجود في النظام.");
            }
            const existingData = (_a = captainSnap.data()) !== null && _a !== void 0 ? _a : {};
            if (!(0, validators_js_1.isEligibleCaptainIdentity)(existingData)) {
                throw new types_js_1.DomainHttpsError("failed-precondition", "هذا المستند لا يمثل حساب كابتن صالح.");
            }
            previousAccountStatus = (0, validators_js_1.resolveCaptainAccountStatus)(existingData);
            captainName = (0, validators_js_1.readString)(existingData, "fullName", "name") || "كابتن البطل";
            captainFcmToken = (0, validators_js_1.readString)(existingData, "fcmToken", "pushToken");
            const captainPatch = {
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
                }
                else {
                    captainPatch.reactivatedAt = s.serverTimestamp();
                    captainPatch.reactivatedBy = admin.uid;
                    captainPatch.reactivatedByName = admin.name;
                    captainPatch.reactivatedByEmail = admin.email;
                }
                captainPatch.rejectionReason = s.deleteField();
                captainPatch.suspensionReason = s.deleteField();
                captainPatch.blockReason = s.deleteField();
            }
            else {
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
                }
                else if (params.targetAccountStatus === "suspended") {
                    captainPatch.isBlocked = false;
                    captainPatch.isSuspended = true;
                    captainPatch.suspendedAt = s.serverTimestamp();
                    captainPatch.suspendedBy = admin.uid;
                    captainPatch.suspendedByName = admin.name;
                    captainPatch.suspendedByEmail = admin.email;
                    captainPatch.suspensionReason = reason;
                }
                else if (params.targetAccountStatus === "blocked") {
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
            const auditPayload = {
                id: auditLogId,
                captainId,
                captainName,
                captainPhone: (0, validators_js_1.readString)(existingData, "phone", "phoneNumber"),
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
        }
        catch (_a) {
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
    async approveCaptain(authContext, data) {
        return this.executeModerationAction({
            authContext,
            data,
            action: "approved",
            targetAccountStatus: "approved",
            targetOperationalStatus: "offline",
            requireReason: false,
            actionArabicLabel: "موافقة",
            notificationTitle: "تم اعتماد حسابك في البطل إكسبريس 🎉",
            notificationBodyBuilder: (name) => `مرحباً كابتن ${name}! تمت مراجعة بياناتك واعتماد حسابك بنجاح. يمكنك الآن الدخول وبدء استقبال طلبات التوصيل.`,
            successMessageBuilder: (name) => `تمت الموافقة على حساب الكابتن "${name}" وتفعيله بنجاح.`,
        });
    }
    /**
     * Rejects a captain registration request with a mandatory reason.
     * @param {CallableAuthContext | undefined} authContext Caller auth context.
     * @param {Record<string, unknown>} data Payload containing captainId and mandatory reason.
     * @return {Promise<CaptainModerationResult>} Moderation outcome.
     */
    async rejectCaptain(authContext, data) {
        return this.executeModerationAction({
            authContext,
            data,
            action: "rejected",
            targetAccountStatus: "rejected",
            targetOperationalStatus: "rejected",
            requireReason: true,
            actionArabicLabel: "رفض الحساب",
            notificationTitle: "تم رفض طلب تسجيل حساب الكابتن",
            notificationBodyBuilder: (_name, reason) => `عذراً، لم يتم قبول طلب انضمامك. السبب: ${reason}`,
            successMessageBuilder: (name) => `تم رفض طلب تسجيل الكابتن "${name}" وحفظ السبب.`,
        });
    }
    /**
     * Suspends an approved/active captain account temporarily with a mandatory reason.
     * @param {CallableAuthContext | undefined} authContext Caller auth context.
     * @param {Record<string, unknown>} data Payload containing captainId and mandatory reason.
     * @return {Promise<CaptainModerationResult>} Moderation outcome.
     */
    async suspendCaptain(authContext, data) {
        return this.executeModerationAction({
            authContext,
            data,
            action: "suspended",
            targetAccountStatus: "suspended",
            targetOperationalStatus: "suspended",
            requireReason: true,
            actionArabicLabel: "إيقاف الحساب",
            notificationTitle: "تم إيقاف حسابك مؤقتاً",
            notificationBodyBuilder: (_name, reason) => `تم إيقاف حساب الكابتن الخاص بك مؤقتاً من قبل الإدارة. السبب: ${reason}`,
            successMessageBuilder: (name) => `تم إيقاف حساب الكابتن "${name}" مؤقتاً ومنعه من استقبال الطلبات.`,
        });
    }
    /**
     * Reactivates a suspended, rejected, or blocked captain back to approved status.
     * @param {CallableAuthContext | undefined} authContext Caller auth context.
     * @param {Record<string, unknown>} data Payload containing captainId and optional note.
     * @return {Promise<CaptainModerationResult>} Moderation outcome.
     */
    async reactivateCaptain(authContext, data) {
        return this.executeModerationAction({
            authContext,
            data,
            action: "reactivated",
            targetAccountStatus: "approved",
            targetOperationalStatus: "offline",
            requireReason: false,
            actionArabicLabel: "إعادة التفعيل",
            notificationTitle: "تمت إعادة تفعيل حسابك في البطل إكسبريس",
            notificationBodyBuilder: (name) => `مرحباً كابتن ${name}! تمت إعادة تفعيل حسابك بنجاح ويمكنك العودة للعمل واستقبال الطلبات الآن.`,
            successMessageBuilder: (name) => `تمت إعادة تفعيل حساب الكابتن "${name}" بنجاح.`,
        });
    }
    /**
     * Permanently blocks a captain account with a mandatory reason.
     * @param {CallableAuthContext | undefined} authContext Caller auth context.
     * @param {Record<string, unknown>} data Payload containing captainId and mandatory reason.
     * @return {Promise<CaptainModerationResult>} Moderation outcome.
     */
    async blockCaptain(authContext, data) {
        return this.executeModerationAction({
            authContext,
            data,
            action: "blocked",
            targetAccountStatus: "blocked",
            targetOperationalStatus: "blocked",
            requireReason: true,
            actionArabicLabel: "حظر الحساب",
            notificationTitle: "تم حظر حسابك من منصة البطل إكسبريس",
            notificationBodyBuilder: (_name, reason) => `تم حظر حسابك نهائياً ولا يمكنك استخدام المنصة. السبب: ${reason}`,
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
    async handleNewCaptainCreated(captainId, data) {
        if (!captainId || !(0, validators_js_1.isEligibleCaptainIdentity)(data)) {
            return;
        }
        const accountStatus = (0, validators_js_1.resolveCaptainAccountStatus)(data);
        if (accountStatus !== "pending") {
            return;
        }
        const nowMs = this.effects.now();
        const s = this.effects.sentinels;
        const captainName = (0, validators_js_1.readString)(data, "fullName", "name") || "كابتن جديد";
        const captainPhone = (0, validators_js_1.readString)(data, "phone", "phoneNumber");
        const vehicleType = (0, validators_js_1.readString)(data, "vehicleType", "vehicle");
        const captainFcmToken = (0, validators_js_1.readString)(data, "fcmToken", "pushToken");
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
                    action: "registration_received",
                    previousAccountStatus: "pending",
                    newAccountStatus: "pending",
                    reason: "",
                    note: "تم استلام طلب تسجيل كابتن جديد وإدراجه في قائمة انتظار المراجعة.",
                    performedByUid: captainId,
                    performedByEmail: (0, validators_js_1.readString)(data, "email"),
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
        }
        catch (_a) {
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
            const adminTokens = Array.from(new Set(adminsSnap.docs
                .map((d) => (0, validators_js_1.readString)(d.data(), "fcmToken", "webFcmToken"))
                .filter(Boolean)));
            if (adminTokens.length > 0) {
                await this.effects.sendAdminNewCaptainNotification({
                    captainId,
                    captainName,
                    captainPhone,
                    vehicleType,
                    tokens: adminTokens,
                });
            }
        }
        catch (_b) {
            // Non-fatal
        }
    }
}
exports.CaptainApprovalServerService = CaptainApprovalServerService;
//# sourceMappingURL=captainApprovalService.js.map