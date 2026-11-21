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
    email: "alamal@merchant.com",
    email_verified: true,
    role: "merchant",
  },
};

function createHarness(initialNowMs = Date.UTC(2026, 10, 20, 10, 0, 0)) {
  const db = new InMemoryTransactionalFirestore();
  let nowMs = initialNowMs;
  const merchantPushes = [];
  const adminPushes = [];
  const storageFiles = new Set();

  const effects = {
    now: () => nowMs,
    sentinels: {
      serverTimestamp: () => ({__sentinel: "serverTimestamp"}),
      deleteField: () => ({__sentinel: "deleteField"}),
      increment: (operand) => ({__sentinel: "increment", operand}),
      arrayUnion: (...elements) => ({__sentinel: "arrayUnion", elements}),
    },
    verifyStorageReceiptExists: async (storagePath) => {
      return storageFiles.has(storagePath);
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
      {
        planId: "plan_2_captains",
        planName: "باقة 2 كابتن",
        maxCaptains: 2,
        price: 400,
        durationDays: 30,
        isActive: true,
      },
      {
        planId: "plan_4_captains",
        planName: "باقة 4 كابتن",
        maxCaptains: 4,
        price: 800,
        durationDays: 30,
        isActive: true,
      },
      {
        planId: "plan_6_captains",
        planName: "باقة 6 كابتن",
        maxCaptains: 6,
        price: 1200,
        durationDays: 30,
        isActive: true,
      },
    ],
  });

  const service = new ManualSubscriptionsServerService(db, effects);
  return {
    db,
    service,
    merchantPushes,
    adminPushes,
    storageFiles,
    advanceMs: (delta) => {
      nowMs += delta;
    },
  };
}

function seedMerchant(db, {merchantId = "merchant_1", merchantOverrides = {}} = {}) {
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
}

function seedMerchantAndRequest(
  db,
  storageFiles,
  {
    merchantId = "merchant_1",
    requestId = "req_1001",
    requestOverrides = {},
    merchantOverrides = {},
    uploadReceiptToStorage = true,
  } = {}
) {
  seedMerchant(db, {merchantId, merchantOverrides});

  const defaultPath = `subscription_receipts/${merchantId}/${requestId}.jpg`;
  const receiptImagePath =
    requestOverrides.receiptImagePath !== undefined
      ? requestOverrides.receiptImagePath
      : defaultPath;

  if (uploadReceiptToStorage && receiptImagePath) {
    storageFiles.add(receiptImagePath);
  }

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
    receiptImagePath,
    status: "pending_review",
    paymentStatus: "pending_verification",
    previousReceipts: [],
    reviewHistory: [],
    createdAt: Date.UTC(2026, 10, 20, 9, 45, 0),
    ...requestOverrides,
  });
}

describe("Manual Vodafone Cash Subscriptions Server Service (Full 14-Scenario Suite)", () => {
  it("1. End-to-End Flow: merchant uploads receipt -> submitManualSubscriptionRequest -> admin approves -> subscription & merchant active + single payment", async () => {
    const now = Date.UTC(2026, 10, 20, 10, 0, 0);
    const {db, service, storageFiles, merchantPushes, adminPushes} = createHarness(now);
    seedMerchant(db, {merchantId: "merchant_1"});

    const receiptPath = "subscription_receipts/merchant_1/req_e2e_1.jpg";
    storageFiles.add(receiptPath);

    // Step 1-3: Merchant submits manual Vodafone Cash request via server Cloud Function
    const submitted = await service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
      requestId: "req_e2e_1",
      planId: "plan_6_captains",
      senderPhone: "01055556666",
      transactionReference: "VF-E2E-778899",
      receiptImagePath: receiptPath,
      merchantNote: "تم التحويل من محفظتي الشخصية",
    });

    assert.equal(submitted.success, true);
    assert.equal(submitted.requestId, "req_e2e_1");
    assert.equal(submitted.status, "pending_review");
    assert.equal(submitted.paymentStatus, "pending_verification");
    assert.equal(submitted.amount, 1200);
    assert.equal(submitted.maxCaptains, 6);
    assert.equal(submitted.durationDays, 30); // All packages have a fixed one-month term.
    assert.equal(submitted.receiverWalletNumber, "01099887766");
    assert.equal(submitted.isResubmission, false);

    // Pending review state must be synchronized to both documents consumed by the Merchant App.
    const pendingSub = db.getDocData("subscriptions/merchant_1");
    const pendingMerchant = db.getDocData("merchants/merchant_1");
    assert.equal(pendingSub.status, "pending_review");
    assert.equal(pendingSub.subscriptionStatus, "pending_review");
    assert.equal(pendingSub.pendingRequestId, "req_e2e_1");
    assert.equal(pendingSub.paymentMethod, "vodafone_cash_manual");
    assert.equal(pendingSub.isSubscribed, false);
    assert.equal(pendingMerchant.subscriptionStatus, "pending_review");
    assert.equal(pendingMerchant.pendingRequestId, "req_e2e_1");
    assert.equal(pendingMerchant.isSubscribed, false);
    assert.equal(db.listCollection("payments").length, 0);

    // Trigger fires admin notification
    const createdDoc = db.getDocData("manual_subscription_requests/req_e2e_1");
    await service.handleNewManualSubscriptionRequest("req_e2e_1", createdDoc);
    assert.equal(adminPushes.length, 1);

    // Step 4-6: Admin approves via approveManualSubscriptionRequest
    const approved = await service.approveManualSubscriptionRequest(ADMIN_AUTH, {
      requestId: "req_e2e_1",
      adminNote: "مطابق للتحويل الوارد",
    });

    assert.equal(approved.success, true);
    assert.equal(approved.status, "approved");
    assert.equal(approved.paymentStatus, "paid");
    assert.equal(approved.maxCaptains, 6);
    assert.equal(approved.amount, 1200);
    assert.equal(approved.startDate, "2026-11-20");
    assert.equal(approved.endDate, "2026-12-20"); // 30 days from 2026-11-20

    // Verify subscriptions/{merchantId}, merchants/{merchantId}, and single payment
    const subDoc = db.getDocData("subscriptions/merchant_1");
    assert.equal(subDoc.status, "active");
    assert.equal(subDoc.isActive, true);
    assert.equal(subDoc.isSubscribed, true);
    assert.equal(subDoc.maxCaptains, 6);
    assert.equal(subDoc.captainLimit, 6);
    assert.equal(subDoc.durationDays, 30);
    assert.equal(subDoc.endDate, "2026-12-20");

    const merchantDoc = db.getDocData("merchants/merchant_1");
    assert.equal(merchantDoc.subscriptionStatus, "active");
    assert.equal(merchantDoc.isSubscribed, true);
    assert.equal(merchantDoc.maxCaptains, 6);
    assert.equal(merchantDoc.captainLimit, 6);
    assert.equal(merchantDoc.activeManualSubscriptionRequestId, null);

    const payments = db.listCollection("payments");
    assert.equal(payments.length, 1);
    assert.equal(payments[0].id, "manual_sub_req_e2e_1");
    assert.equal(payments[0].data.amount, 1200);
    assert.equal(payments[0].data.status, "success");
    assert.equal(payments[0].data.paymentStatus, "paid");
    assert.equal(payments[0].data.type, "merchant_subscription");
    assert.equal(payments[0].data.source, "manual_vodafone_cash");
    assert.equal(payments[0].data.paymentMethod, "فودافون كاش (Vodafone Cash)");
    assert.equal(payments[0].data.billingMonth, "2026-11");
    assert.equal(payments[0].data.createdAtMs, now);
    assert.equal(payments[0].data.paidAtMs, now);
    assert.equal(payments[0].data.planName, "باقة 6 كابتن");
    assert.equal(payments[0].data.maxCaptains, 6);
    assert.equal(payments[0].data.senderPhone, "01055556666");
    assert.equal(payments[0].data.receiverWalletNumber, "01099887766");

    assert.equal(merchantPushes.length, 1);
    assert.equal(merchantPushes[0].eventType, "subscription_approved");
  });

  it("2. submitManualSubscriptionRequest blocks unauthenticated, forged merchantId, price tampering, missing Storage file, and duplicate requests", async () => {
    const {db, service, storageFiles} = createHarness();
    seedMerchant(db, {merchantId: "merchant_1"});

    const receiptPath = "subscription_receipts/merchant_1/req_sec_1.jpg";

    // Unauthenticated denied
    await assert.rejects(
      () => service.submitManualSubscriptionRequest(undefined, {
        planId: "plan_4_captains",
        senderPhone: "01022223333",
        receiptImagePath: receiptPath,
      }),
      (err) => err instanceof DomainHttpsError && err.code === "unauthenticated"
    );

    // Forged merchantId in payload denied
    storageFiles.add(receiptPath);
    await assert.rejects(
      () => service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
        merchantId: "merchant_2",
        planId: "plan_4_captains",
        senderPhone: "01022223333",
        receiptImagePath: receiptPath,
      }),
      (err) => err instanceof DomainHttpsError && err.code === "permission-denied"
    );

    // Missing Storage file denied
    await assert.rejects(
      () => service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
        planId: "plan_4_captains",
        senderPhone: "01022223333",
        receiptImagePath: "subscription_receipts/merchant_1/nonexistent.jpg",
      }),
      (err) => err instanceof DomainHttpsError && err.code === "failed-precondition"
    );

    // Cross-merchant receipt path denied
    await assert.rejects(
      () => service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
        planId: "plan_4_captains",
        senderPhone: "01022223333",
        receiptImagePath: "subscription_receipts/merchant_2/stolen.jpg",
      }),
      (err) => err instanceof DomainHttpsError && err.code === "permission-denied"
    );

    // Price tampering denied (client attempts to pay 50 EGP for an 800 EGP plan)
    await assert.rejects(
      () => service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
        planId: "plan_4_captains",
        amount: 50,
        senderPhone: "01022223333",
        receiptImagePath: receiptPath,
      }),
      (err) => err instanceof DomainHttpsError && err.code === "invalid-argument"
    );

    // First valid submission succeeds
    const ok = await service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
      requestId: "req_sec_1",
      planId: "plan_4_captains",
      senderPhone: "01022223333",
      transactionReference: "VF-DUP-CHECK-1",
      receiptImagePath: receiptPath,
    });
    assert.equal(ok.success, true);

    // Duplicate pending request by same merchant denied
    const receiptPath2 = "subscription_receipts/merchant_1/req_sec_2.jpg";
    storageFiles.add(receiptPath2);
    await assert.rejects(
      () => service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
        requestId: "req_sec_2",
        planId: "plan_4_captains",
        senderPhone: "01022223333",
        receiptImagePath: receiptPath2,
      }),
      (err) => err instanceof DomainHttpsError && err.code === "already-exists"
    );

    // Duplicate transactionReference by another merchant denied
    seedMerchant(db, {merchantId: "merchant_2"});
    const m2Receipt = "subscription_receipts/merchant_2/req_m2.jpg";
    storageFiles.add(m2Receipt);
    await assert.rejects(
      () => service.submitManualSubscriptionRequest(
        {uid: "merchant_2", token: {email: "m2@store.com", role: "merchant"}},
        {
          requestId: "req_m2_dup_ref",
          planId: "plan_4_captains",
          senderPhone: "01033334444",
          transactionReference: "VF-DUP-CHECK-1",
          receiptImagePath: m2Receipt,
        }
      ),
      (err) => err instanceof DomainHttpsError && err.code === "already-exists"
    );
  });

  it("2a. Accepts Android merchant payload aliases and safely replays the same idempotency key", async () => {
    const {db, service, storageFiles} = createHarness();
    seedMerchant(db, {merchantId: "merchant_1"});
    const receiptPath = "merchants/merchant_1/subscription_receipts/req_mobile_1.jpg";
    storageFiles.add(receiptPath);

    const payload = {
      requestId: "req_mobile_1",
      idempotencyKey: "android-manual-sub-req-mobile-1",
      merchantId: "merchant_1",
      planId: "plan_4_captains",
      packageId: "plan_4_captains",
      maxCaptains: 4,
      expectedAmount: 800,
      amount: 800,
      senderPhone: "01022223333",
      transactionReference: "VF-MOBILE-ALIAS-001",
      notes: "اختبار توافق تطبيق التاجر",
      receiptStoragePath: receiptPath,
    };

    const first = await service.submitManualSubscriptionRequest(MERCHANT_AUTH, payload);
    assert.equal(first.success, true);
    assert.equal(first.status, "pending_review");
    assert.equal(first.amount, 800);

    const stored = db.getDocData("manual_subscription_requests/req_mobile_1");
    assert.equal(stored.receiptImagePath, receiptPath);
    assert.equal(stored.merchantNote, "اختبار توافق تطبيق التاجر");
    assert.equal(stored.idempotencyKey, payload.idempotencyKey);
    assert.equal(db.getDocData("merchants/merchant_1").activeManualSubscriptionRequestId, "req_mobile_1");

    // Retry after a client timeout must return the same request and create no duplicate.
    const replay = await service.submitManualSubscriptionRequest(MERCHANT_AUTH, payload);
    assert.equal(replay.success, true);
    assert.equal(replay.requestId, "req_mobile_1");
    assert.equal(db.listCollection("manual_subscription_requests").length, 1);
    assert.equal(db.listCollection("manual_subscription_reference_locks").length, 1);

    // A correct amount field must not mask a forged expectedAmount alias.
    const {db: isolatedDb, service: isolatedService, storageFiles: isolatedStorage} = createHarness();
    seedMerchant(isolatedDb, {merchantId: "merchant_1"});
    const forgedReceipt = "subscription_receipts/merchant_1/forged_amount.jpg";
    isolatedStorage.add(forgedReceipt);
    await assert.rejects(
      () => isolatedService.submitManualSubscriptionRequest(MERCHANT_AUTH, {
        requestId: "req_forged_expected_amount",
        planId: "plan_4_captains",
        amount: 800,
        expectedAmount: 1,
        senderPhone: "01022223333",
        receiptStoragePath: forgedReceipt,
      }),
      (err) => err instanceof DomainHttpsError && err.code === "invalid-argument"
    );

    const forgedLimitReceipt = "subscription_receipts/merchant_1/forged_limit.jpg";
    isolatedStorage.add(forgedLimitReceipt);
    await assert.rejects(
      () => isolatedService.submitManualSubscriptionRequest(MERCHANT_AUTH, {
        requestId: "req_forged_captain_limit",
        planId: "plan_4_captains",
        amount: 800,
        maxCaptains: 4,
        captainLimit: 8,
        senderPhone: "01022223333",
        receiptStoragePath: forgedLimitReceipt,
      }),
      (err) => err instanceof DomainHttpsError && err.code === "invalid-argument"
    );
  });

  it("2b. Serializes concurrent merchant requests and globally reserves transaction references", async () => {
    // Two simultaneous requests from one merchant with different references must not both become pending.
    {
      const {db, service, storageFiles} = createHarness();
      seedMerchant(db, {merchantId: "merchant_1"});
      db.YieldOnRead = true;
      const p1 = "subscription_receipts/merchant_1/concurrent_1.jpg";
      const p2 = "subscription_receipts/merchant_1/concurrent_2.jpg";
      storageFiles.add(p1);
      storageFiles.add(p2);

      const results = await Promise.allSettled([
        service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
          requestId: "req_concurrent_1",
          planId: "plan_4_captains",
          senderPhone: "01022223333",
          transactionReference: "VF-CONCURRENT-MERCHANT-1",
          receiptImagePath: p1,
        }),
        service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
          requestId: "req_concurrent_2",
          planId: "plan_4_captains",
          senderPhone: "01022223333",
          transactionReference: "VF-CONCURRENT-MERCHANT-2",
          receiptImagePath: p2,
        }),
      ]);

      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      assert.equal(db.listCollection("manual_subscription_requests").length, 1);
    }

    // Two different merchants cannot reserve the same transfer reference concurrently.
    {
      const {db, service, storageFiles} = createHarness();
      seedMerchant(db, {merchantId: "merchant_1"});
      seedMerchant(db, {merchantId: "merchant_2"});
      db.YieldOnRead = true;
      const p1 = "subscription_receipts/merchant_1/shared_reference_1.jpg";
      const p2 = "subscription_receipts/merchant_2/shared_reference_2.jpg";
      storageFiles.add(p1);
      storageFiles.add(p2);

      const results = await Promise.allSettled([
        service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
          requestId: "req_reference_1",
          planId: "plan_4_captains",
          senderPhone: "01022223333",
          transactionReference: "VF-GLOBAL-REFERENCE-RACE",
          receiptImagePath: p1,
        }),
        service.submitManualSubscriptionRequest(
          {uid: "merchant_2", token: {email: "m2@store.com", role: "merchant"}},
          {
            requestId: "req_reference_2",
            planId: "plan_4_captains",
            senderPhone: "01033334444",
            transactionReference: "VF-GLOBAL-REFERENCE-RACE",
            receiptImagePath: p2,
          }
        ),
      ]);

      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      assert.equal(db.listCollection("manual_subscription_requests").length, 1);
      assert.equal(db.listCollection("manual_subscription_reference_locks").length, 1);
    }
  });

  it("3. New subscription request trigger creates admin notification & dispatches admin alert", async () => {
    const {db, service, adminPushes} = createHarness();
    const reqData = {
      merchantId: "merchant_1",
      merchantName: "مطعم الأمل",
      planName: "باقة 4 كابتن",
      amount: 800,
      status: "pending_review",
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

  it("4. Approval blocks missing Storage receipt, cross-merchant receipt path, and tampered request price", async () => {
    assert.equal(
      isSafeMerchantReceipt("merchant_1", "subscription_receipts/merchant_1/r1.jpg", ""),
      true
    );
    assert.equal(
      isSafeMerchantReceipt("merchant_1", "manual_subscription_receipts/merchant_1/r2.png", ""),
      true
    );
    assert.equal(isSafeMerchantReceipt("merchant_1", "", ""), false);
    assert.equal(
      isSafeMerchantReceipt("merchant_1", "subscription_receipts/merchant_2/stolen.jpg", ""),
      false
    );
    assert.equal(
      isSafeMerchantReceipt("merchant_1", "subscription_receipts/merchant_1/../merchant_2/x.jpg", ""),
      false
    );

    const {db, service, storageFiles} = createHarness();

    // Case A: cross-merchant path
    seedMerchantAndRequest(db, storageFiles, {
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

    // Case B: file does NOT exist in Storage
    seedMerchantAndRequest(db, storageFiles, {
      requestId: "req_missing_storage",
      uploadReceiptToStorage: false,
    });
    await assert.rejects(
      () => service.approveManualSubscriptionRequest(ADMIN_AUTH, {requestId: "req_missing_storage"}),
      (err) => err instanceof DomainHttpsError && err.code === "failed-precondition"
    );

    // Case C: tampered amount inside request doc (says 100 EGP instead of official 800 EGP)
    seedMerchantAndRequest(db, storageFiles, {
      requestId: "req_tampered_price",
      requestOverrides: {amount: 100},
    });
    await assert.rejects(
      () => service.approveManualSubscriptionRequest(ADMIN_AUTH, {requestId: "req_tampered_price"}),
      (err) => err instanceof DomainHttpsError && err.code === "failed-precondition"
    );

    // Ensure zero payments and zero subscriptions were created
    assert.equal(db.listCollection("payments").length, 0);
    assert.equal(db.getDocData("subscriptions/merchant_1"), undefined);
  });

  it("5. Duplicate approval is strictly prevented (sequential AND concurrent) with ONLY ONE payment record", async () => {
    const {db, service, storageFiles} = createHarness();
    db.YieldOnRead = true;
    seedMerchantAndRequest(db, storageFiles, {requestId: "req_race"});

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

  it("6. Rejection requires reason, records audit & notifies merchant, does NOT activate subscription, and blocks later approval", async () => {
    const {db, service, storageFiles, merchantPushes} = createHarness();
    seedMerchantAndRequest(db, storageFiles, {requestId: "req_reject_1"});

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

    // Rejection state is synced so the Merchant App can release the pending review state.
    const rejectedSub = db.getDocData("subscriptions/merchant_1");
    const rejectedMerchant = db.getDocData("merchants/merchant_1");
    assert.equal(rejectedSub.status, "rejected");
    assert.equal(rejectedSub.paymentStatus, "rejected");
    assert.equal(rejectedSub.pendingRequestId, null);
    assert.equal(rejectedMerchant.subscriptionStatus, "rejected");
    assert.equal(rejectedMerchant.pendingRequestId, null);
    assert.equal(rejectedMerchant.isSubscribed, false);
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

  it("7. Resubmission flow: admin requests resubmission -> archives previous receipt -> merchant resubmits via Cloud Function -> admin approves cleanly", async () => {
    const {db, service, storageFiles, merchantPushes, advanceMs} = createHarness();
    seedMerchantAndRequest(db, storageFiles, {requestId: "req_resub_1"});

    const resub = await service.requestSubscriptionReceiptResubmission(ADMIN_AUTH, {
      requestId: "req_resub_1",
      reason: "يرجى تصوير رقم العملية المرجعي بشكل أوضح",
    });

    assert.equal(resub.success, true);
    assert.equal(resub.status, "resubmission_required");
    const resubPendingSub = db.getDocData("subscriptions/merchant_1");
    const resubPendingMerchant = db.getDocData("merchants/merchant_1");
    assert.equal(resubPendingSub.status, "resubmission_required");
    assert.equal(resubPendingSub.pendingRequestId, "req_resub_1");
    assert.equal(resubPendingMerchant.subscriptionStatus, "resubmission_required");
    assert.equal(resubPendingMerchant.pendingRequestId, "req_resub_1");
    assert.equal(db.listCollection("payments").length, 0);
    assert.equal(merchantPushes.length, 1);
    assert.equal(merchantPushes[0].eventType, "subscription_resubmission_requested");

    const afterFlag = db.getDocData("manual_subscription_requests/req_resub_1");
    assert.equal(afterFlag.status, "resubmission_required");
    assert.equal(afterFlag.previousReceipts.length, 1);
    assert.equal(
      afterFlag.previousReceipts[0].receiptImagePath,
      "subscription_receipts/merchant_1/req_resub_1.jpg"
    );

    // Merchant uploads a clearer receipt and resubmits via submitManualSubscriptionRequest
    advanceMs(60_000);
    const newReceiptPath = "subscription_receipts/merchant_1/req_resub_1_v2.jpg";
    storageFiles.add(newReceiptPath);

    const resubmitted = await service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
      requestId: "req_resub_1",
      planId: "plan_4_captains",
      senderPhone: "01022223333",
      transactionReference: "VF-TX-998811",
      receiptImagePath: newReceiptPath,
      merchantNote: "تم رفع صورة واضحة كاملة",
    });

    assert.equal(resubmitted.success, true);
    assert.equal(resubmitted.isResubmission, true);
    assert.equal(resubmitted.status, "pending_review");
    assert.equal(db.getDocData("subscriptions/merchant_1").status, "pending_review");
    assert.equal(db.getDocData("subscriptions/merchant_1").pendingRequestId, "req_resub_1");
    assert.equal(db.getDocData("merchants/merchant_1").pendingRequestId, "req_resub_1");

    // Admin now approves cleanly
    advanceMs(60_000);
    const approved = await service.approveManualSubscriptionRequest(ADMIN_AUTH, {
      requestId: "req_resub_1",
      adminNote: "تمت مراجعة الصورة الجديدة والموافقة",
    });
    assert.equal(approved.success, true);
    const finalReq = db.getDocData("manual_subscription_requests/req_resub_1");
    assert.equal(finalReq.status, "approved");
    assert.equal(db.getDocData("subscriptions/merchant_1").pendingRequestId, null);
    assert.equal(db.getDocData("merchants/merchant_1").pendingRequestId, null);
    assert.equal(finalReq.reviewHistory.length, 3); // resubmission_required + resubmitted + approved
    assert.ok(finalReq.previousReceipts.length >= 1);

    // Rejecting or requesting resubmission on an already approved request MUST fail
    await assert.rejects(
      () => service.rejectManualSubscriptionRequest(ADMIN_AUTH, {
        requestId: "req_resub_1",
        rejectionReason: "محاولة رفض بعد التفعيل",
      }),
      (err) => err instanceof DomainHttpsError && err.code === "failed-precondition"
    );
    await assert.rejects(
      () => service.requestSubscriptionReceiptResubmission(ADMIN_AUTH, {
        requestId: "req_resub_1",
        reason: "محاولة إعادة إرسال بعد التفعيل",
      }),
      (err) => err instanceof DomainHttpsError && err.code === "failed-precondition"
    );
  });

  it("8. Strict authorization: blocks unauthenticated users, merchants self-approving, suspended admins, and restricts Vodafone Cash settings to Master Admin ONLY", async () => {
    const {db, service, storageFiles} = createHarness();
    seedMerchantAndRequest(db, storageFiles, {requestId: "req_auth_1"});

    // Unauthenticated denied
    await assert.rejects(
      () => service.approveManualSubscriptionRequest(undefined, {requestId: "req_auth_1"}),
      (err) => err instanceof DomainHttpsError && err.code === "unauthenticated"
    );

    // Merchant attempting self-approval or self-rejection denied
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
    await assert.rejects(
      () => service.requestSubscriptionReceiptResubmission(MERCHANT_AUTH, {
        requestId: "req_auth_1",
        reason: "spoof",
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
        {
          planId: "plan_2_captains",
          planName: "باقة 2 كابتن",
          maxCaptains: 2,
          price: 450,
          durationDays: 30,
          isActive: true,
        },
        {
          planId: "plan_8_captains",
          planName: "باقة 8 كابتن",
          maxCaptains: 8,
          price: 1650,
          durationDays: 30,
          isActive: true,
        },
      ],
    };

    await assert.rejects(
      () => service.updateManualSubscriptionSettings(ADMIN_AUTH, validSettingsPayload),
      (err) => err instanceof DomainHttpsError && err.code === "permission-denied"
    );

    // Master Admin saves every package with the fixed 30-day term
    const saved = await service.updateManualSubscriptionSettings(
      MASTER_ADMIN_AUTH,
      validSettingsPayload
    );
    assert.equal(saved.success, true);
    assert.equal(saved.settings.vodafoneCashNumber, "01011223344");
    assert.equal(saved.settings.plans[0].price, 450);
    assert.equal(saved.settings.plans[1].durationDays, 30);

    const persisted = db.getDocData("settings/manual_subscription_config");
    assert.equal(persisted.vodafoneCashNumber, "01011223344");
    assert.equal(persisted.updatedBy, "master_admin_1");
    assert.equal(persisted.plans[1].durationDays, 30);

    // Master Admin invalid Egyptian wallet number rejected
    await assert.rejects(
      () => service.updateManualSubscriptionSettings(MASTER_ADMIN_AUTH, {
        ...validSettingsPayload,
        vodafoneCashNumber: "12345",
      }),
      (err) => err instanceof DomainHttpsError && err.code === "invalid-argument"
    );
  }); 
  it("15. submitManualSubscriptionRequest refuses to replace an active paid subscription", async () => {
    const now = Date.UTC(2026, 10, 20, 10, 0, 0);
    const {db, service, storageFiles} = createHarness(now);
    seedMerchant(db, {
      merchantId: "merchant_1",
      merchantOverrides: {
        subscriptionStatus: "active",
        isActive: true,
        isSubscribed: true,
        subscriptionExpiresAt: now + 10 * 24 * 60 * 60 * 1000,
      },
    });
    db.seed("subscriptions/merchant_1", {
      status: "active",
      subscriptionStatus: "active",
      isActive: true,
      isSubscribed: true,
      expiresAt: now + 10 * 24 * 60 * 60 * 1000,
      subscriptionVersion: 7,
    });
    const receiptPath = "subscription_receipts/merchant_1/active_guard.jpg";
    storageFiles.add(receiptPath);

    await assert.rejects(
      () => service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
        requestId: "req_active_guard",
        planId: "plan_2_captains",
        senderPhone: "01055556666",
        transactionReference: "VF-ACTIVE-GUARD",
        receiptImagePath: receiptPath,
      }),
      (err) => err instanceof DomainHttpsError && err.code === "failed-precondition"
    );
    assert.equal(db.getDocData("subscriptions/merchant_1").status, "active");
    assert.equal(db.getDocData("merchants/merchant_1").subscriptionStatus, "active");
    assert.equal(db.getDocData("manual_subscription_requests/req_active_guard"), undefined);
    assert.equal(db.listCollection("payments").length, 0);
  });

  it("16. active merchant account flags alone do not masquerade as an active subscription", async () => {
    const now = Date.UTC(2026, 10, 20, 10, 0, 0);
    const {db, service, storageFiles} = createHarness(now);
    seedMerchant(db, {
      merchantId: "merchant_1",
      merchantOverrides: {
        status: "active",
        isActive: true,
        subscriptionStatus: "inactive",
        isSubscribed: false,
      },
    });
    const receiptPath = "subscription_receipts/merchant_1/account_active_only.jpg";
    storageFiles.add(receiptPath);

    const result = await service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
      requestId: "req_account_active_only",
      planId: "plan_2_captains",
      senderPhone: "01055556666",
      transactionReference: "VF-ACCOUNT-ACTIVE",
      receiptImagePath: receiptPath,
    });
    assert.equal(result.status, "pending_review");
    assert.equal(db.getDocData("subscriptions/merchant_1").pendingRequestId, "req_account_active_only");
  });

  it("17. Duplicate Firestore create-event delivery does not reset admin read state or resend push", async () => {
    const {db, service, adminPushes} = createHarness();
    const requestId = "req_retry_idempotent";
    const requestData = {
      merchantId: "merchant_1",
      merchantName: "مطعم الأمل",
      planName: "باقة 4 كابتن",
      amount: 800,
      status: "pending_review",
    };

    await service.handleNewManualSubscriptionRequest(requestId, requestData);
    const notificationPath = `notifications/manual_sub_req_${requestId}`;
    const first = db.getDocData(notificationPath);
    assert.ok(first);
    assert.equal(first.isRead, false);
    assert.equal(adminPushes.length, 1);

    await db.collection("notifications").doc(`manual_sub_req_${requestId}`)
      .update({isRead: true});
    await service.handleNewManualSubscriptionRequest(requestId, requestData);

    const afterRetry = db.getDocData(notificationPath);
    assert.equal(afterRetry.isRead, true);
    assert.deepEqual(afterRetry.createdAt, first.createdAt);
    assert.equal(adminPushes.length, 1, "Duplicate event delivery must not resend the admin push");
    assert.equal(db.listCollection("notifications").filter((item) =>
      item.id === `manual_sub_req_${requestId}`).length, 1);
  });


  it("18. General dashboard activation atomically writes the canonical merchant and subscription contract", async () => {
    const now = Date.UTC(2026, 10, 20, 10, 0, 0);
    const {db, service} = createHarness(now);
    seedMerchant(db, {
      merchantId: "merchant_1",
      merchantOverrides: {status: "approved"},
    });

    const result = await service.manageMerchantSubscription(ADMIN_AUTH, {
      operation: "upsert",
      merchantId: "merchant_1",
      maxCaptains: 4,
      price: 800,
      startDate: "2026-11-20",
      endDate: "2026-12-20",
      status: "Active",
    });

    const subscription = db.getDocData("subscriptions/merchant_1");
    const merchant = db.getDocData("merchants/merchant_1");
    assert.equal(result.status, "active");
    assert.equal(result.maxCaptains, 4);
    assert.equal(subscription.status, "active");
    assert.equal(subscription.planId, 2);
    assert.equal(subscription.maxCaptains, 4);
    assert.equal(subscription.paymentStatus, "admin_manual");
    assert.equal(merchant.subscriptionStatus, "active");
    assert.equal(merchant.isSubscribed, true);
    assert.equal(merchant.captainLimit, 4);
    assert.equal(db.listCollection("payments").length, 0, "Admin-managed activation must not fabricate a payment");
    assert.equal(db.listCollection("operation_logs").length, 1);
  });

  it("19. General dashboard activation rejects client-tampered package prices", async () => {
    const {db, service} = createHarness();
    seedMerchant(db, {
      merchantId: "merchant_1",
      merchantOverrides: {status: "active"},
    });
    await assert.rejects(
      () => service.manageMerchantSubscription(ADMIN_AUTH, {
        operation: "upsert",
        merchantId: "merchant_1",
        maxCaptains: 4,
        price: 1,
        startDate: "2026-11-20",
        endDate: "2026-12-20",
        status: "Active",
      }),
      (err) => err instanceof DomainHttpsError && err.code === "failed-precondition"
    );
    assert.equal(db.getDocData("subscriptions/merchant_1"), undefined);
    assert.equal(db.getDocData("merchants/merchant_1").isSubscribed, false);
  });

  it("20. General dashboard suspension and reactivation synchronize both canonical documents", async () => {
    const {db, service} = createHarness();
    seedMerchant(db, {
      merchantId: "merchant_1",
      merchantOverrides: {status: "approved"},
    });
    await service.manageMerchantSubscription(ADMIN_AUTH, {
      operation: "upsert",
      merchantId: "merchant_1",
      maxCaptains: 2,
      price: 400,
      startDate: "2026-11-20",
      endDate: "2026-12-20",
      status: "Active",
    });
    await service.manageMerchantSubscription(ADMIN_AUTH, {
      operation: "status",
      merchantId: "merchant_1",
      status: "Suspended",
    });
    assert.equal(db.getDocData("subscriptions/merchant_1").status, "suspended");
    assert.equal(db.getDocData("merchants/merchant_1").isSubscribed, false);

    await service.manageMerchantSubscription(ADMIN_AUTH, {
      operation: "status",
      merchantId: "merchant_1",
      status: "Active",
    });
    assert.equal(db.getDocData("subscriptions/merchant_1").status, "active");
    assert.equal(db.getDocData("merchants/merchant_1").isSubscribed, true);
  });

  it("21. General dashboard activation migrates an old subscription row without leaving it active", async () => {
    const {db, service} = createHarness();
    seedMerchant(db, {
      merchantId: "merchant_1",
      merchantOverrides: {status: "approved"},
    });
    db.seed("subscriptions/legacy_sub_1", {
      merchantId: "merchant_1",
      restaurantId: "merchant_1",
      status: "Active",
      maxCaptains: 2,
      price: 400,
    });

    await service.manageMerchantSubscription(ADMIN_AUTH, {
      operation: "upsert",
      merchantId: "merchant_1",
      legacySubscriptionId: "legacy_sub_1",
      maxCaptains: 2,
      price: 400,
      startDate: "2026-11-20",
      endDate: "2026-12-20",
      status: "Active",
    });

    const legacy = db.getDocData("subscriptions/legacy_sub_1");
    assert.equal(legacy.status, "migrated");
    assert.equal(legacy.migratedToMerchantId, "merchant_1");
    assert.equal(db.getDocData("subscriptions/merchant_1").status, "active");
  });

  it("22. Every general-dashboard package and renewal lasts exactly 30 days", async () => {
    const now = Date.UTC(2026, 10, 20, 10, 0, 0);
    const {db, service} = createHarness(now);
    seedMerchant(db, {
      merchantId: "merchant_1",
      merchantOverrides: {status: "approved"},
    });

    await service.manageMerchantSubscription(ADMIN_AUTH, {
      operation: "upsert",
      merchantId: "merchant_1",
      maxCaptains: 6,
      price: 1200,
      startDate: "2026-11-20",
      endDate: "2026-12-20",
      status: "Active",
    });

    const result = await service.manageMerchantSubscription(ADMIN_AUTH, {
      operation: "renew",
      merchantId: "merchant_1",
    });

    const subscription = db.getDocData("subscriptions/merchant_1");
    assert.equal(subscription.durationDays, 30);
    assert.equal(subscription.startDate, "2026-12-21");
    assert.equal(subscription.endDate, "2027-01-19");
    assert.equal(result.startDate, "2026-12-21");
    assert.equal(result.endDate, "2027-01-19");
    assert.equal(subscription.paymentStatus, "admin_manual");
  });

});
