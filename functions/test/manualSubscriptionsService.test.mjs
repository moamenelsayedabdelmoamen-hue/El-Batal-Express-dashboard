import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  ManualSubscriptionsServerService,
  isSafeMerchantReceipt,
} from "../lib/manualSubscriptionsService.js";
import {DomainHttpsError} from "../lib/types.js";

/**
 * Stateful in-memory transactional Firestore engine with optimistic version checks,
 * retryable transaction conflict resolution, subcollections, and FieldValue sentinels.
 */
class InMemoryTransactionalFirestore {
  constructor() {
    this.docs = new Map(); // path -> { data: object, version: number }
    this.autoId = 1;
    this.YieldOnRead = false;
  }

  seed(path, data) {
    this.docs.set(path, {data: structuredClone(data), version: 1});
  }

  getDocData(path) {
    const entry = this.docs.get(path);
    return entry ? structuredClone(entry.data) : undefined;
  }

  listCollection(basePath) {
    const prefix = `${basePath}/`;
    const items = [];
    for (const [path, entry] of this.docs.entries()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest.includes("/")) continue;
      items.push({id: rest, path, data: structuredClone(entry.data)});
    }
    return items;
  }

  collection(collectionPath) {
    return this._makeCollectionRef(collectionPath);
  }

  _makeDocRef(path) {
    const parts = path.split("/");
    const id = parts[parts.length - 1];
    return {
      id,
      path,
      collection: (sub) => this._makeCollectionRef(`${path}/${sub}`),
      get: async () => {
        const entry = this.docs.get(path);
        return this._wrapSnap(path, entry);
      },
      set: async (data, options) => {
        const cur = this.docs.get(path);
        const merged = options?.merge && cur ? structuredClone(cur.data) : {};
        this._applyMutations(merged, data);
        this.docs.set(path, {
          data: merged,
          version: (cur?.version ?? 0) + 1,
        });
      },
      update: async (data) => {
        const cur = this.docs.get(path);
        if (!cur) throw new Error(`Document not found for update: ${path}`);
        const next = structuredClone(cur.data);
        this._applyMutations(next, data);
        this.docs.set(path, {data: next, version: cur.version + 1});
      },
    };
  }

  _makeCollectionRef(basePath) {
    const query = this._makeQuery(basePath, [], null);
    return {
      ...query,
      doc: (docId) => {
        const id = docId ?? `auto_${this.autoId++}`;
        return this._makeDocRef(`${basePath}/${id}`);
      },
      add: async (data) => {
        const id = `auto_${this.autoId++}`;
        const ref = this._makeDocRef(`${basePath}/${id}`);
        await ref.set(data);
        return ref;
      },
    };
  }

  _makeQuery(basePath, filters, limitCount) {
    return {
      where: (fieldPath, opStr, value) =>
        this._makeQuery(
          basePath,
          [...filters, {fieldPath, opStr, value}],
          limitCount
        ),
      limit: (n) => this._makeQuery(basePath, filters, n),
      get: async () => this._execQuery(basePath, filters, limitCount),
    };
  }

  _execQuery(basePath, filters, limitCount) {
    const prefix = `${basePath}/`;
    const matched = [];
    for (const [path, entry] of this.docs.entries()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest.includes("/")) continue;
      const d = entry.data;
      let ok = true;
      for (const f of filters) {
        const val = d[f.fieldPath];
        if (f.opStr === "==") {
          if (val !== f.value) ok = false;
        } else if (f.opStr === "in") {
          if (!Array.isArray(f.value) || !f.value.includes(val)) ok = false;
        } else if (f.opStr === "array-contains") {
          if (!Array.isArray(val) || !val.includes(f.value)) ok = false;
        }
        if (!ok) break;
      }
      if (ok) {
        matched.push({path, entry});
        if (limitCount !== null && matched.length >= limitCount) break;
      }
    }
    return {
      empty: matched.length === 0,
      size: matched.length,
      docs: matched.map((m) => this._wrapSnap(m.path, m.entry)),
    };
  }

  _wrapSnap(path, entry) {
    const parts = path.split("/");
    const id = parts[parts.length - 1];
    return {
      id,
      exists: Boolean(entry),
      ref: this._makeDocRef(path),
      data: () => (entry ? structuredClone(entry.data) : undefined),
    };
  }

  _applyMutations(target, patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === "object" && v.__sentinel) {
        if (v.__sentinel === "serverTimestamp") {
          target[k] = Date.now();
        } else if (v.__sentinel === "deleteField") {
          delete target[k];
        } else if (v.__sentinel === "increment") {
          target[k] = Number(target[k] ?? 0) + v.operand;
        } else if (v.__sentinel === "arrayUnion") {
          const cur = Array.isArray(target[k]) ? [...target[k]] : [];
          for (const el of v.elements) {
            cur.push(structuredClone(el));
          }
          target[k] = cur;
        }
      } else {
        target[k] = structuredClone(v);
      }
    }
  }

  async runTransaction(fn) {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const readVersions = new Map();
      const pendingWrites = [];

      const tx = {
        get: async (ref) => {
          const snap = this.docs.get(ref.path);
          if (!readVersions.has(ref.path)) {
            readVersions.set(ref.path, snap?.version ?? 0);
          }
          if (this.YieldOnRead) {
            await new Promise((r) => setTimeout(r, 8));
          }
          return this._wrapSnap(ref.path, snap);
        },
        getQuery: async (q) => q.get(),
        set: (ref, data, options) => {
          pendingWrites.push({type: "set", path: ref.path, data, options});
        },
        update: (ref, data) => {
          pendingWrites.push({type: "update", path: ref.path, data});
        },
      };

      const result = await fn(tx);

      let conflict = false;
      for (const [path, expectedVersion] of readVersions.entries()) {
        const currentVersion = this.docs.get(path)?.version ?? 0;
        if (currentVersion !== expectedVersion) {
          conflict = true;
          break;
        }
      }
      if (conflict) {
        continue;
      }

      for (const w of pendingWrites) {
        const cur = this.docs.get(w.path);
        if (w.type === "update") {
          if (!cur) throw new Error(`Missing document on commit: ${w.path}`);
          const next = structuredClone(cur.data);
          this._applyMutations(next, w.data);
          this.docs.set(w.path, {data: next, version: cur.version + 1});
        } else {
          const base = w.options?.merge && cur ? structuredClone(cur.data) : {};
          this._applyMutations(base, w.data);
          this.docs.set(w.path, {data: base, version: (cur?.version ?? 0) + 1});
        }
      }

      return result;
    }
    throw new Error("Transaction failed due to repeated concurrent conflicts");
  }
}

const ADMIN_AUTH = {
  uid: "admin_1",
  token: {
    email: "ops.admin@elbatalexpress.com",
    email_verified: true,
    role: "admin",
  },
};

const MASTER_ADMIN_AUTH = {
  uid: "master_admin_1",
  token: {
    email: "moamen.elsayed.abdelmoamen@gmail.com",
    email_verified: true,
    role: "admin",
    isMasterAdmin: true,
  },
};

const MERCHANT_AUTH = {
  uid: "merchant_1",
  token: {
    email: "merchant1@store.com",
    email_verified: true,
    role: "merchant",
  },
};

function createHarness(initialNowMs = Date.UTC(2026, 10, 20, 10, 0, 0)) {
  const db = new InMemoryTransactionalFirestore();
  let nowMs = initialNowMs;
  const merchantPushes = [];
  const adminPushes = [];

  const effects = {
    now: () => nowMs,
    sentinels: {
      serverTimestamp: () => ({__sentinel: "serverTimestamp"}),
      deleteField: () => ({__sentinel: "deleteField"}),
      increment: (operand) => ({__sentinel: "increment", operand}),
      arrayUnion: (...elements) => ({__sentinel: "arrayUnion", elements}),
    },
    sendMerchantSubscriptionNotification: async (payload) => {
      merchantPushes.push(payload);
    },
    sendAdminNewManualRequestNotification: async (payload) => {
      adminPushes.push(payload);
    },
  };

  // Seed admin accounts & official manual settings
  db.seed("admins/admin_1", {
    uid: "admin_1",
    email: "ops.admin@elbatalexpress.com",
    displayName: "مشرف العمليات",
    role: "admin",
    status: "active",
    fcmToken: "fcm_admin_1",
  });
  db.seed("admins/master_admin_1", {
    uid: "master_admin_1",
    email: "moamen.elsayed.abdelmoamen@gmail.com",
    displayName: "المسؤول الرئيسي",
    role: "super_admin",
    isMasterAdmin: true,
    status: "active",
  });
  db.seed("settings/manual_subscription_config", {
    vodafoneCashNumber: "01099887766",
    walletHolderName: "البطل إكسبريس للتحصيل",
    isAcceptingSubscriptions: true,
    pauseMessage: "",
    durationDays: 30,
    plans: [
      {planId: "plan_2_captains", planName: "باقة 2 كابتن", maxCaptains: 2, price: 400, isActive: true},
      {planId: "plan_4_captains", planName: "باقة 4 كابتن", maxCaptains: 4, price: 800, isActive: true},
      {planId: "plan_6_captains", planName: "باقة 6 كابتن", maxCaptains: 6, price: 1200, isActive: true},
    ],
  });

  const service = new ManualSubscriptionsServerService(db, effects);
  return {
    db,
    service,
    merchantPushes,
    adminPushes,
    advanceMs: (delta) => {
      nowMs += delta;
    },
  };
}

function seedMerchantAndRequest(db, {
  merchantId = "merchant_1",
  requestId = "req_1001",
  requestOverrides = {},
  merchantOverrides = {},
} = {}) {
  db.seed(`merchants/${merchantId}`, {
    uid: merchantId,
    accountType: "merchant",
    role: "merchant",
    name: "مطعم الأمل",
    phone: "01012345678",
    email: "alamal@merchant.com",
    fcmToken: `fcm_${merchantId}`,
    subscriptionStatus: "inactive",
    isSubscribed: false,
    subscriptionVersion: 1,
    ...merchantOverrides,
  });

  db.seed(`manual_subscription_requests/${requestId}`, {
    requestNumber: "SUB-1001",
    merchantId,
    merchantName: "مطعم الأمل",
    merchantPhone: "01012345678",
    merchantEmail: "alamal@merchant.com",
    planId: "plan_4_captains",
    planName: "باقة 4 كابتن",
    maxCaptains: 4,
    amount: 800,
    durationDays: 30,
    senderPhone: "01022223333",
    receiverWalletNumber: "01099887766",
    transactionReference: "VF-TX-998811",
    receiptImagePath: `subscription_receipts/${merchantId}/${requestId}.jpg`,
    status: "pending",
    paymentStatus: "pending_verification",
    createdAt: Date.UTC(2026, 10, 20, 9, 45, 0),
    ...requestOverrides,
  });
}

describe("Manual Vodafone Cash Subscriptions Server Service", () => {
  it("1. New subscription request trigger creates admin notification & dispatches admin alert", async () => {
    const {db, service, adminPushes} = createHarness();
    const reqData = {
      merchantId: "merchant_1",
      merchantName: "مطعم الأمل",
      planName: "باقة 4 كابتن",
      amount: 800,
      status: "pending",
    };

    await service.handleNewManualSubscriptionRequest("req_new_1", reqData);

    const adminNotif = db.getDocData("notifications/manual_sub_req_req_new_1");
    assert.ok(adminNotif, "Admin notification document must be created");
    assert.equal(adminNotif.type, "manual_subscription_request");
    assert.equal(adminNotif.targetRole, "admin");
    assert.equal(adminNotif.requestId, "req_new_1");
    assert.equal(adminNotif.merchantId, "merchant_1");
    assert.equal(adminNotif.amount, 800);

    assert.equal(adminPushes.length, 1);
    assert.equal(adminPushes[0].requestId, "req_new_1");
    assert.equal(adminPushes[0].merchantName, "مطعم الأمل");
  });

  it("2. Receipt ownership validator blocks missing, path-traversal, and cross-merchant receipts", async () => {
    assert.equal(
      isSafeMerchantReceipt("merchant_1", "subscription_receipts/merchant_1/r1.jpg", ""),
      true
    );
    assert.equal(
      isSafeMerchantReceipt("merchant_1", "manual_subscription_receipts/merchant_1/r2.png", ""),
      true
    );
    assert.equal(
      isSafeMerchantReceipt("merchant_1", "", ""),
      false
    );
    assert.equal(
      isSafeMerchantReceipt("merchant_1", "subscription_receipts/merchant_2/stolen.jpg", ""),
      false
    );
    assert.equal(
      isSafeMerchantReceipt("merchant_1", "subscription_receipts/merchant_1/../merchant_2/x.jpg", ""),
      false
    );

    const {db, service} = createHarness();
    seedMerchantAndRequest(db, {
      requestId: "req_bad_receipt",
      requestOverrides: {
        receiptImagePath: "subscription_receipts/other_merchant/forged.jpg",
        receiptImageUrl: "",
      },
    });

    await assert.rejects(
      () => service.approveManualSubscriptionRequest(ADMIN_AUTH, {requestId: "req_bad_receipt"}),
      (err) => err instanceof DomainHttpsError && err.code === "failed-precondition"
    );

    // Ensure no payment or subscription activation occurred
    assert.equal(db.getDocData("payments/manual_sub_req_bad_receipt"), undefined);
    assert.equal(db.getDocData("subscriptions/merchant_1"), undefined);
  });

  it("3. Approval atomically updates request, subscriptions, merchants, creates SINGLE payment, audit log & notifies merchant", async () => {
    const now = Date.UTC(2026, 10, 20, 10, 0, 0);
    const {db, service, merchantPushes} = createHarness(now);
    seedMerchantAndRequest(db, {requestId: "req_approve_1"});

    const res = await service.approveManualSubscriptionRequest(ADMIN_AUTH, {
      requestId: "req_approve_1",
      adminNote: "تمت مطابقة الحوالة بنجاح",
    });

    assert.equal(res.success, true);
    assert.equal(res.status, "approved");
    assert.equal(res.paymentStatus, "paid");
    assert.equal(res.paymentDocId, "manual_sub_req_approve_1");
    assert.equal(res.planId, "plan_4_captains");
    assert.equal(res.planName, "باقة 4 كابتن");
    assert.equal(res.maxCaptains, 4);
    assert.equal(res.amount, 800);
    assert.equal(res.startDate, "2026-11-20");
    assert.equal(res.endDate, "2026-12-20");
    assert.equal(res.subscriptionVersion, 2);

    // 1. Request document updated
    const reqDoc = db.getDocData("manual_subscription_requests/req_approve_1");
    assert.equal(reqDoc.status, "approved");
    assert.equal(reqDoc.paymentStatus, "paid");
    assert.equal(reqDoc.approvedBy, "admin_1");
    assert.equal(reqDoc.paymentDocId, "manual_sub_req_approve_1");
    assert.equal(reqDoc.reviewHistory.length, 1);
    assert.equal(reqDoc.reviewHistory[0].action, "approved");

    // 2. subscriptions/{merchantId} activated
    const subDoc = db.getDocData("subscriptions/merchant_1");
    assert.equal(subDoc.status, "active");
    assert.equal(subDoc.isActive, true);
    assert.equal(subDoc.isSubscribed, true);
    assert.equal(subDoc.paymentStatus, "paid");
    assert.equal(subDoc.planId, "plan_4_captains");
    assert.equal(subDoc.planName, "باقة 4 كابتن");
    assert.equal(subDoc.maxCaptains, 4);
    assert.equal(subDoc.captainLimit, 4);
    assert.equal(subDoc.startDate, "2026-11-20");
    assert.equal(subDoc.endDate, "2026-12-20");
    assert.equal(subDoc.subscriptionVersion, 2);

    // 3. merchants/{merchantId} synced for Merchant App compatibility
    const merchantDoc = db.getDocData("merchants/merchant_1");
    assert.equal(merchantDoc.subscriptionStatus, "active");
    assert.equal(merchantDoc.isSubscribed, true);
    assert.equal(merchantDoc.planId, "plan_4_captains");
    assert.equal(merchantDoc.planName, "باقة 4 كابتن");
    assert.equal(merchantDoc.maxCaptains, 4);
    assert.equal(merchantDoc.captainLimit, 4);
    assert.equal(merchantDoc.paymentStatus, "paid");
    assert.equal(merchantDoc.subscriptionEndDate, "2026-12-20");
    assert.equal(merchantDoc.subscriptionVersion, 2);

    // 4. Exactly ONE financial payment record created
    const payments = db.listCollection("payments");
    assert.equal(payments.length, 1);
    assert.equal(payments[0].id, "manual_sub_req_approve_1");
    assert.equal(payments[0].data.amount, 800);
    assert.equal(payments[0].data.status, "success");
    assert.equal(payments[0].data.paymentStatus, "paid");
    assert.equal(payments[0].data.transactionReference, "VF-TX-998811");

    // 5. Audit log recorded in operation_logs
    const opLog = db.getDocData("operation_logs/approve_manual_sub_req_approve_1");
    assert.ok(opLog);
    assert.equal(opLog.action, "approve_manual_subscription_request");
    assert.equal(opLog.adminUid, "admin_1");

    // 6. Merchant notification + FCM dispatched
    const mNotif = db.getDocData("merchants/merchant_1/notifications/sub_approved_req_approve_1");
    assert.ok(mNotif);
    assert.equal(mNotif.type, "subscription_approved");
    assert.equal(merchantPushes.length, 1);
    assert.equal(merchantPushes[0].merchantId, "merchant_1");
    assert.equal(merchantPushes[0].eventType, "subscription_approved");
  });

  it("4. Duplicate approval is strictly prevented (sequential AND concurrent) with ONLY ONE payment record", async () => {
    const {db, service} = createHarness();
    db.YieldOnRead = true; // Force concurrent transaction interleaving
    seedMerchantAndRequest(db, {requestId: "req_race"});

    const results = await Promise.allSettled([
      service.approveManualSubscriptionRequest(ADMIN_AUTH, {requestId: "req_race"}),
      service.approveManualSubscriptionRequest(MASTER_ADMIN_AUTH, {requestId: "req_race"}),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1, "Exactly one approval must succeed");
    assert.equal(rejected.length, 1, "Second concurrent approval must be rejected");
    assert.equal(rejected[0].reason.code, "already-exists");

    // Sequential third attempt must ALSO fail
    await assert.rejects(
      () => service.approveManualSubscriptionRequest(ADMIN_AUTH, {requestId: "req_race"}),
      (err) => err instanceof DomainHttpsError && err.code === "already-exists"
    );

    // Strictly ONE payment record exists
    const payments = db.listCollection("payments");
    assert.equal(payments.length, 1);
    assert.equal(payments[0].id, "manual_sub_req_race");
  });

  it("5. Rejection requires reason, records audit & notifies merchant, does NOT activate subscription, and blocks later approval", async () => {
    const {db, service, merchantPushes} = createHarness();
    seedMerchantAndRequest(db, {requestId: "req_reject_1"});

    // Empty / too-short rejection reason rejected
    await assert.rejects(
      () => service.rejectManualSubscriptionRequest(ADMIN_AUTH, {
        requestId: "req_reject_1",
        rejectionReason: "لا",
      }),
      (err) => err instanceof DomainHttpsError && err.code === "invalid-argument"
    );

    const rejRes = await service.rejectManualSubscriptionRequest(ADMIN_AUTH, {
      requestId: "req_reject_1",
      rejectionReason: "لم يتم استلام المبلغ على محفظة فودافون كاش",
    });

    assert.equal(rejRes.success, true);
    assert.equal(rejRes.status, "rejected");

    const reqDoc = db.getDocData("manual_subscription_requests/req_reject_1");
    assert.equal(reqDoc.status, "rejected");
    assert.equal(reqDoc.rejectionReason, "لم يتم استلام المبلغ على محفظة فودافون كاش");
    assert.equal(reqDoc.rejectedBy, "admin_1");

    // Subscription MUST remain inactive and NO payment created
    assert.equal(db.getDocData("subscriptions/merchant_1"), undefined);
    assert.equal(db.getDocData("merchants/merchant_1").isSubscribed, false);
    assert.equal(db.listCollection("payments").length, 0);

    // Merchant notified
    const mNotif = db.getDocData("merchants/merchant_1/notifications/sub_rejected_req_reject_1");
    assert.ok(mNotif);
    assert.equal(mNotif.type, "subscription_rejected");
    assert.equal(merchantPushes.length, 1);
    assert.equal(merchantPushes[0].eventType, "subscription_rejected");

    // Approving a rejected request MUST fail
    await assert.rejects(
      () => service.approveManualSubscriptionRequest(ADMIN_AUTH, {requestId: "req_reject_1"}),
      (err) => err instanceof DomainHttpsError && err.code === "failed-precondition"
    );
  });

  it("6. Request resubmission updates status without activating subscription, then allows approval after review", async () => {
    const {db, service, merchantPushes, advanceMs} = createHarness();
    seedMerchantAndRequest(db, {requestId: "req_resub_1"});

    const resub = await service.requestManualSubscriptionResubmission(ADMIN_AUTH, {
      requestId: "req_resub_1",
      note: "يرجى تصوير رقم العملية المرجعي بشكل أوضح",
    });

    assert.equal(resub.success, true);
    assert.equal(resub.status, "resubmission_requested");
    assert.equal(db.getDocData("subscriptions/merchant_1"), undefined);
    assert.equal(db.listCollection("payments").length, 0);
    assert.equal(merchantPushes.length, 1);
    assert.equal(merchantPushes[0].eventType, "subscription_resubmission_requested");

    // After merchant re-uploads clearer receipt, admin approves -> succeeds cleanly
    advanceMs(60_000);
    const approved = await service.approveManualSubscriptionRequest(ADMIN_AUTH, {
      requestId: "req_resub_1",
      adminNote: "تمت مراجعة الصورة الجديدة والموافقة",
    });
    assert.equal(approved.success, true);
    assert.equal(db.getDocData("manual_subscription_requests/req_resub_1").reviewHistory.length, 2);

    // Rejecting or requesting resubmission on an already approved request MUST fail
    await assert.rejects(
      () => service.rejectManualSubscriptionRequest(ADMIN_AUTH, {
        requestId: "req_resub_1",
        rejectionReason: "محاولة رفض بعد التفعيل",
      }),
      (err) => err instanceof DomainHttpsError && err.code === "failed-precondition"
    );
    await assert.rejects(
      () => service.requestManualSubscriptionResubmission(ADMIN_AUTH, {
        requestId: "req_resub_1",
        note: "محاولة إعادة إرسال بعد التفعيل",
      }),
      (err) => err instanceof DomainHttpsError && err.code === "failed-precondition"
    );
  });

  it("7. Strict authorization: blocks unauthenticated users, merchants, suspended admins, and restricts settings to Master Admin ONLY", async () => {
    const {db, service} = createHarness();
    seedMerchantAndRequest(db, {requestId: "req_auth_1"});

    // Unauthenticated denied
    await assert.rejects(
      () => service.approveManualSubscriptionRequest(undefined, {requestId: "req_auth_1"}),
      (err) => err instanceof DomainHttpsError && err.code === "unauthenticated"
    );

    // Merchant attempting self-approval denied
    await assert.rejects(
      () => service.approveManualSubscriptionRequest(MERCHANT_AUTH, {requestId: "req_auth_1"}),
      (err) => err instanceof DomainHttpsError && err.code === "permission-denied"
    );
    await assert.rejects(
      () => service.rejectManualSubscriptionRequest(MERCHANT_AUTH, {
        requestId: "req_auth_1",
        rejectionReason: "spoof",
      }),
      (err) => err instanceof DomainHttpsError && err.code === "permission-denied"
    );

    // Suspended admin denied
    db.seed("admins/susp_admin", {
      uid: "susp_admin",
      role: "admin",
      status: "suspended",
    });
    await assert.rejects(
      () => service.approveManualSubscriptionRequest(
        {uid: "susp_admin", token: {email: "susp@elbatal.com"}},
        {requestId: "req_auth_1"}
      ),
      (err) => err instanceof DomainHttpsError && err.code === "permission-denied"
    );

    // Regular admin CANNOT update Vodafone Cash settings (Master Admin ONLY)
    const validSettingsPayload = {
      vodafoneCashNumber: "01011223344",
      walletHolderName: "شركة البطل إكسبريس",
      isAcceptingSubscriptions: true,
      pauseMessage: "",
      durationDays: 30,
      plans: [
        {planId: "plan_2_captains", planName: "باقة 2 كابتن", maxCaptains: 2, price: 450, isActive: true},
      ],
    };

    await assert.rejects(
      () => service.updateManualSubscriptionSettings(ADMIN_AUTH, validSettingsPayload),
      (err) => err instanceof DomainHttpsError && err.code === "permission-denied"
    );

    // Master Admin succeeds with valid payload
    const saved = await service.updateManualSubscriptionSettings(
      MASTER_ADMIN_AUTH,
      validSettingsPayload
    );
    assert.equal(saved.success, true);
    assert.equal(saved.settings.vodafoneCashNumber, "01011223344");
    assert.equal(saved.settings.plans[0].price, 450);

    const persisted = db.getDocData("settings/manual_subscription_config");
    assert.equal(persisted.vodafoneCashNumber, "01011223344");
    assert.equal(persisted.updatedBy, "master_admin_1");

    // Master Admin invalid Egyptian wallet number rejected
    await assert.rejects(
      () => service.updateManualSubscriptionSettings(MASTER_ADMIN_AUTH, {
        ...validSettingsPayload,
        vodafoneCashNumber: "12345",
      }),
      (err) => err instanceof DomainHttpsError && err.code === "invalid-argument"
    );
  });
});
