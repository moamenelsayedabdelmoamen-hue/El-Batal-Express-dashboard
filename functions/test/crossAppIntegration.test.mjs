import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  ManualSubscriptionsServerService,
} from "../lib/manualSubscriptionsService.js";
import {DomainHttpsError} from "../lib/types.js";

/**
 * In-memory Firestore emulator with true per-transaction serialization so concurrent
 * approval races behave identically to Firestore production transactions.
 */
function deepClone(val) {
  if (val === null || val === undefined || typeof val !== "object") return val;
  if (val.__sentinel) return val;
  if (Array.isArray(val)) return val.map(deepClone);
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    out[k] = deepClone(v);
  }
  return out;
}

class InMemoryFirestore {
  constructor(nowFn) {
    this.store = new Map();
    this.nowFn = nowFn;
    this.txChain = Promise.resolve();
  }

  seed(path, data) {
    this.store.set(path, deepClone(data));
  }

  getDocData(path) {
    const val = this.store.get(path);
    return val ? deepClone(val) : undefined;
  }

  listCollection(colPath) {
    const prefix = `${colPath}/`;
    const results = [];
    for (const [path, data] of this.store.entries()) {
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) {
        results.push({id: path.slice(prefix.length), data: deepClone(data)});
      }
    }
    return results;
  }

  applySentinels(existing, incoming, merge) {
    const base = merge && existing ? deepClone(existing) : {};
    for (const [k, v] of Object.entries(incoming)) {
      if (v && typeof v === "object" && v.__sentinel === "serverTimestamp") {
        base[k] = this.nowFn();
      } else if (v && typeof v === "object" && v.__sentinel === "deleteField") {
        delete base[k];
      } else if (v && typeof v === "object" && v.__sentinel === "increment") {
        base[k] = (typeof base[k] === "number" ? base[k] : 0) + v.value;
      } else if (v && typeof v === "object" && v.__sentinel === "arrayUnion") {
        const cur = Array.isArray(base[k]) ? deepClone(base[k]) : [];
        for (const el of v.elements) {
          cur.push(deepClone(el));
        }
        base[k] = cur;
      } else {
        base[k] = deepClone(v);
      }
    }
    return base;
  }

  makeDocRef(path) {
    const db = this;
    const parts = path.split("/");
    const id = parts[parts.length - 1];
    return {
      id,
      path,
      collection(subName) {
        return db.collection(`${path}/${subName}`);
      },
      async get() {
        const d = db.store.get(path);
        return {
          id,
          exists: d !== undefined,
          ref: this,
          data: () => (d !== undefined ? deepClone(d) : undefined),
        };
      },
      async set(data, options) {
        const existing = db.store.get(path);
        db.store.set(path, db.applySentinels(existing, data, Boolean(options?.merge)));
      },
      async update(data) {
        const existing = db.store.get(path);
        if (existing === undefined) {
          throw new Error(`Document ${path} does not exist`);
        }
        db.store.set(path, db.applySentinels(existing, data, true));
      },
    };
  }

  collection(colPath) {
    const db = this;
    const makeQuery = (filters = [], limitN = null) => ({
      where(field, op, value) {
        return makeQuery([...filters, {field, op, value}], limitN);
      },
      limit(n) {
        return makeQuery(filters, n);
      },
      async get() {
        const docs = [];
        for (const item of db.listCollection(colPath)) {
          let match = true;
          for (const f of filters) {
            if (f.op === "==" && item.data[f.field] !== f.value) {
              match = false;
              break;
            }
          }
          if (match) {
            docs.push({
              id: item.id,
              exists: true,
              ref: db.makeDocRef(`${colPath}/${item.id}`),
              data: () => deepClone(item.data),
            });
          }
        }
        const sliced = limitN !== null ? docs.slice(0, limitN) : docs;
        return {
          empty: sliced.length === 0,
          size: sliced.length,
          docs: sliced,
        };
      },
    });

    return {
      doc(docId) {
        return db.makeDocRef(`${colPath}/${docId}`);
      },
      ...makeQuery(),
    };
  }

  async runTransaction(fn) {
    let release;
    const prev = this.txChain;
    this.txChain = new Promise((r) => {
      release = r;
    });
    await prev;

    const stagedWrites = [];
    const tx = {
      async get(refOrQuery) {
        return refOrQuery.get();
      },
      set(ref, data, options) {
        stagedWrites.push({type: "set", path: ref.path, data, merge: Boolean(options?.merge)});
      },
      update(ref, data) {
        stagedWrites.push({type: "update", path: ref.path, data});
      },
    };

    try {
      const result = await fn(tx);
      for (const w of stagedWrites) {
        const existing = this.store.get(w.path);
        if (w.type === "update" && existing === undefined) {
          throw new Error(`Transaction update target missing: ${w.path}`);
        }
        this.store.set(
          w.path,
          this.applySentinels(existing, w.data, w.type === "update" || w.merge)
        );
      }
      return result;
    } finally {
      release();
    }
  }
}

/**
 * Mirrors Dashboard Payments.tsx & Dashboard.tsx `computePaymentRevenueMetrics`
 * so integration tests directly prove monthly & cumulative revenue behavior.
 */
function computeDashboardRevenueMetrics(paymentDocs, referenceMonthKey) {
  let totalRevenue = 0;
  let monthlyRevenue = 0;
  let successfulCount = 0;
  let monthlySuccessfulCount = 0;

  for (const doc of paymentDocs) {
    const p = doc.data;
    const status = String(p.status || p.paymentStatus || "").toLowerCase();
    const isSuccess = status === "success" || status === "paid" || status === "approved";
    if (!isSuccess) continue;

    const amount = Number(p.amount || 0);
    totalRevenue += amount;
    successfulCount += 1;

    const billingMonth =
      typeof p.billingMonth === "string" && /^\d{4}-\d{2}$/.test(p.billingMonth)
        ? p.billingMonth
        : typeof p.date === "string"
          ? p.date.slice(0, 7)
          : "";
    if (billingMonth === referenceMonthKey) {
      monthlyRevenue += amount;
      monthlySuccessfulCount += 1;
    }
  }

  return {
    totalRevenue,
    monthlyRevenue,
    successfulCount,
    monthlySuccessfulCount,
  };
}

/**
 * Mirrors El-Batal-Express-tager's `SubscriptionSyncResolver.kt` dual-doc reconciliation
 * so integration tests directly verify Merchant App screen behavior after approval.
 */
function resolveMerchantAppSubscriptionState(subDoc, merchantDoc, nowMs) {
  const subVer = Number(subDoc?.subscriptionVersion || 0);
  const merchVer = Number(merchantDoc?.subscriptionVersion || 0);

  const subUpdated = Number(subDoc?.subscriptionUpdatedAt || subDoc?.updatedAt || 0);
  const merchExplicitSubUpdated = Number(merchantDoc?.subscriptionUpdatedAt || 0);
  const merchLastLogin = Number(merchantDoc?.lastLoginAt || 0);
  const merchRawUpdated = Number(merchantDoc?.updatedAt || 0);
  const isLoginBump =
    !merchExplicitSubUpdated &&
    merchLastLogin > 0 &&
    Math.abs(merchRawUpdated - merchLastLogin) <= 10_000;
  const merchUpdated = merchExplicitSubUpdated || (isLoginBump ? 0 : merchRawUpdated);

  const useMerchant =
    !subDoc ||
    merchVer > subVer ||
    (merchVer === subVer && merchUpdated > subUpdated);

  const primary = useMerchant ? merchantDoc : subDoc;
  const status = String(
    primary?.status || primary?.subscriptionStatus || "unsubscribed"
  ).toLowerCase();
  const maxCaptains = Number(primary?.captainLimit ?? primary?.maxCaptains ?? 0);
  const endDateMs = Number(primary?.expiresAt ?? primary?.endDateMs ?? 0);
  const isActive =
    status === "active" &&
    primary?.isActive !== false &&
    primary?.isSubscribed === true &&
    maxCaptains > 0 &&
    endDateMs > nowMs;

  return {
    isSubscribed: isActive,
    status: isActive ? "active" : status,
    maxCaptains: isActive ? maxCaptains : 0,
    planName: primary?.planName || "غير مشترك",
    price: Number(primary?.price || 0),
    suspensionReason: primary?.suspensionReason ?? null,
    cancellationReason: primary?.cancellationReason ?? null,
    canRequestCaptain: isActive && primary?.paymentStatus === "paid",
  };
}

const ADMIN_AUTH = {
  uid: "admin_master_1",
  token: {
    email: "moamen.elsayed.abdelmoamen@gmail.com",
    email_verified: true,
    admin: true,
    isMasterAdmin: true,
  },
};

const MERCHANT_AUTH = {
  uid: "merchant_cross_1",
  token: {
    email: "store@merchant.com",
    email_verified: true,
  },
};

function createIntegrationHarness(initialNowMs = Date.UTC(2026, 10, 20, 10, 0, 0)) {
  let currentNow = initialNowMs;
  const db = new InMemoryFirestore(() => currentNow);
  const storageFiles = new Set();
  const merchantPushes = [];
  const adminPushes = [];

  db.seed("settings/manual_subscription_config", {
    vodafoneCashNumber: "01099887766",
    walletHolderName: "البطل إكسبريس",
    isAcceptingSubscriptions: true,
    pauseMessage: "",
    durationDays: 30,
    plans: [
      {planId: "plan_2_captains", planName: "باقة 2 كابتن", maxCaptains: 2, price: 400, durationDays: 30, isActive: true},
      {planId: "plan_4_captains", planName: "باقة 4 كابتن", maxCaptains: 4, price: 800, durationDays: 30, isActive: true},
      {planId: "plan_6_captains", planName: "باقة 6 كابتن", maxCaptains: 6, price: 1200, durationDays: 30, isActive: true},
      {planId: "plan_8_captains", planName: "باقة 8 كابتن", maxCaptains: 8, price: 1600, durationDays: 30, isActive: true},
    ],
  });

  db.seed("admins/admin_master_1", {
    email: "moamen.elsayed.abdelmoamen@gmail.com",
    role: "admin",
    isMasterAdmin: true,
    status: "active",
    fcmToken: "fcm_admin_1",
  });

  db.seed("merchants/merchant_cross_1", {
    uid: "merchant_cross_1",
    name: "مطعم البطل المتكامل",
    phone: "01012345678",
    email: "store@merchant.com",
    accountType: "merchant",
    role: "merchant",
    status: "approved",
    isSubscribed: false,
    subscriptionStatus: "suspended",
    suspensionReason: "انتهاء باقة سابقة",
    fcmToken: "fcm_merchant_cross_1",
  });

  const service = new ManualSubscriptionsServerService(db, {
    now: () => currentNow,
    sentinels: {
      serverTimestamp: () => ({__sentinel: "serverTimestamp"}),
      deleteField: () => ({__sentinel: "deleteField"}),
      increment: (value) => ({__sentinel: "increment", value}),
      arrayUnion: (...elements) => ({__sentinel: "arrayUnion", elements}),
    },
    async verifyStorageReceiptExists(storagePath) {
      return storageFiles.has(storagePath);
    },
    async sendMerchantSubscriptionNotification(payload) {
      merchantPushes.push(payload);
    },
    async sendAdminNewManualRequestNotification(payload) {
      adminPushes.push(payload);
    },
  });

  return {
    db,
    service,
    storageFiles,
    merchantPushes,
    adminPushes,
    advanceClock(deltaMs) {
      currentNow += deltaMs;
    },
    getNow: () => currentNow,
  };
}

describe("Cross-App End-to-End Integration: Merchant App <-> Cloud Functions <-> Admin Dashboard", () => {
  it("1. Full E2E path: receipt upload -> submitManualSubscriptionRequest -> Dashboard review -> approve -> single payment -> Merchant App active -> Monthly & Total Revenue updated ONCE", async () => {
    const h = createIntegrationHarness();
    const receiptPath = "subscription_receipts/merchant_cross_1/req_full_1.jpg";
    h.storageFiles.add(receiptPath);

    // Step 1: Merchant submits via central callable (also verifies numeric planId=3 maps to plan_6_captains)
    const submitted = await h.service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
      requestId: "req_full_1",
      planId: 3, // Legacy Merchant App numeric Plan ID -> resolves authoritatively to plan_6_captains (1200 EGP)
      senderPhone: "01055551111",
      transactionReference: "VF-CROSS-001",
      receiptImagePath: receiptPath,
    });

    assert.equal(submitted.status, "pending_review");
    assert.equal(submitted.paymentStatus, "pending_verification");
    assert.equal(submitted.planId, "plan_6_captains");
    assert.equal(submitted.maxCaptains, 6);
    assert.equal(submitted.amount, 1200);

    // Verify BEFORE approval: 0 payments, 0 revenue, merchant still unsubscribed
    assert.equal(h.db.listCollection("payments").length, 0);
    assert.equal(
      computeDashboardRevenueMetrics(h.db.listCollection("payments"), "2026-11").monthlyRevenue,
      0
    );
    const beforeState = resolveMerchantAppSubscriptionState(
      h.db.getDocData("subscriptions/merchant_cross_1"),
      h.db.getDocData("merchants/merchant_cross_1"),
      h.getNow()
    );
    assert.equal(beforeState.canRequestCaptain, false);

    // Step 2: Admin notification trigger fires & Dashboard reads manual_subscription_requests
    const reqDoc = h.db.getDocData("manual_subscription_requests/req_full_1");
    assert.equal(reqDoc.status, "pending_review");
    await h.service.handleNewManualSubscriptionRequest("req_full_1", reqDoc);
    assert.equal(h.adminPushes.length, 1);

    // Step 3: Admin approves via central approveManualSubscriptionRequest
    h.advanceClock(60_000);
    const approved = await h.service.approveManualSubscriptionRequest(ADMIN_AUTH, {
      requestId: "req_full_1",
      adminNote: "تمت مطابقة التحويل بنجاح",
    });

    assert.equal(approved.success, true);
    assert.equal(approved.status, "approved");
    assert.equal(approved.paymentStatus, "paid");
    assert.equal(approved.maxCaptains, 6);
    assert.equal(approved.amount, 1200);

    // Step 4: Verify atomic update of subscriptions/{merchantId} AND merchants/{merchantId}
    const subDoc = h.db.getDocData("subscriptions/merchant_cross_1");
    const merchDoc = h.db.getDocData("merchants/merchant_cross_1");

    assert.equal(subDoc.status, "active");
    assert.equal(subDoc.subscriptionStatus, "active");
    assert.equal(subDoc.isActive, true);
    assert.equal(subDoc.isSubscribed, true);
    assert.equal(subDoc.maxCaptains, 6);
    assert.equal(subDoc.captainLimit, 6);
    assert.equal(subDoc.price, 1200);
    assert.equal(subDoc.suspensionReason, null);
    assert.equal(subDoc.cancellationReason, null);
    assert.equal(subDoc.updatedBy, "admin_master_1");
    assert.ok(subDoc.activatedAt > 0);
    assert.ok(subDoc.subscriptionUpdatedAt > 0);

    assert.equal(merchDoc.subscriptionStatus, "active");
    assert.equal(merchDoc.isActive, true);
    assert.equal(merchDoc.isSubscribed, true);
    assert.equal(merchDoc.maxCaptains, 6);
    assert.equal(merchDoc.captainLimit, 6);
    assert.equal(merchDoc.price, 1200);
    assert.equal(merchDoc.suspensionReason, null);
    assert.equal(merchDoc.cancellationReason, null);
    assert.equal(merchDoc.subscriptionVersion, subDoc.subscriptionVersion);
    assert.ok(merchDoc.subscriptionUpdatedAt > 0);

    // Step 5: Verify Merchant App screen state updates cleanly — even after a subsequent login/FCM updatedAt bump!
    h.advanceClock(5_000);
    await h.db.collection("merchants").doc("merchant_cross_1").update({
      fcmToken: "fcm_refreshed_token",
      lastLoginAt: h.getNow(),
      updatedAt: h.getNow(),
    });
    const afterState = resolveMerchantAppSubscriptionState(
      h.db.getDocData("subscriptions/merchant_cross_1"),
      h.db.getDocData("merchants/merchant_cross_1"),
      h.getNow()
    );
    assert.equal(afterState.isSubscribed, true);
    assert.equal(afterState.status, "active");
    assert.equal(afterState.maxCaptains, 6);
    assert.equal(afterState.price, 1200);
    assert.equal(afterState.suspensionReason, null);
    assert.equal(afterState.canRequestCaptain, true);

    // Step 6: Verify SINGLE payment in payments/ AND Monthly + Total Revenue updated ONCE
    const payments = h.db.listCollection("payments");
    assert.equal(payments.length, 1);
    assert.equal(payments[0].id, "manual_sub_req_full_1");
    assert.equal(payments[0].data.status, "success");
    assert.equal(payments[0].data.paymentStatus, "paid");
    assert.equal(payments[0].data.paymentMethod, "فودافون كاش (Vodafone Cash)");
    assert.equal(payments[0].data.billingMonth, "2026-11");
    assert.equal(payments[0].data.amount, 1200);

    const rev = computeDashboardRevenueMetrics(payments, "2026-11");
    assert.equal(rev.totalRevenue, 1200);
    assert.equal(rev.monthlyRevenue, 1200);
    assert.equal(rev.successfulCount, 1);
    assert.equal(rev.monthlySuccessfulCount, 1);

    // Merchant push notification emitted
    assert.equal(h.merchantPushes.length, 1);
    assert.equal(h.merchantPushes[0].eventType, "subscription_approved");
  });

  it("2. Anti-tampering: merchant CANNOT forge price, inflate captainLimit, or self-approve", async () => {
    const h = createIntegrationHarness();
    const receiptPath = "subscription_receipts/merchant_cross_1/req_tamper.jpg";
    h.storageFiles.add(receiptPath);

    // Price tampering blocked
    await assert.rejects(
      () =>
        h.service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
          planId: "plan_6_captains",
          amount: 100, // Official is 1200
          senderPhone: "01055551111",
          receiptImagePath: receiptPath,
        }),
      (err) => err instanceof DomainHttpsError && err.code === "invalid-argument"
    );

    // captainLimit inflation blocked
    await assert.rejects(
      () =>
        h.service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
          planId: "plan_2_captains",
          captainLimit: 8, // Official is 2
          senderPhone: "01055551111",
          receiptImagePath: receiptPath,
        }),
      (err) => err instanceof DomainHttpsError && err.code === "invalid-argument"
    );

    // Self-approval blocked
    await h.service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
      requestId: "req_self_approve",
      planId: "plan_2_captains",
      senderPhone: "01055551111",
      receiptImagePath: receiptPath,
    });
    await assert.rejects(
      () =>
        h.service.approveManualSubscriptionRequest(MERCHANT_AUTH, {
          requestId: "req_self_approve",
        }),
      (err) => err instanceof DomainHttpsError && err.code === "permission-denied"
    );

    assert.equal(h.db.listCollection("payments").length, 0);
  });

  it("3. Rejection flow: blocks approval, leaves subscription inactive, and keeps payments & revenue at 0", async () => {
    const h = createIntegrationHarness();
    const receiptPath = "subscription_receipts/merchant_cross_1/req_reject.jpg";
    h.storageFiles.add(receiptPath);

    await h.service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
      requestId: "req_reject",
      planId: "plan_4_captains",
      senderPhone: "01055551111",
      receiptImagePath: receiptPath,
    });

    const rejected = await h.service.rejectManualSubscriptionRequest(ADMIN_AUTH, {
      requestId: "req_reject",
      reason: "رقم العملية غير موجود في كشف فودافون كاش",
    });

    assert.equal(rejected.status, "rejected");
    assert.equal(h.db.listCollection("payments").length, 0);
    assert.equal(
      computeDashboardRevenueMetrics(h.db.listCollection("payments"), "2026-11").monthlyRevenue,
      0
    );
    assert.equal(h.db.getDocData("subscriptions/merchant_cross_1"), undefined);

    // Later approval of rejected request strictly denied
    await assert.rejects(
      () =>
        h.service.approveManualSubscriptionRequest(ADMIN_AUTH, {
          requestId: "req_reject",
        }),
      (err) => err instanceof DomainHttpsError && err.code === "failed-precondition"
    );
  });

  it("4. Resubmission flow + 5x concurrent approval race: preserves receipt history, activates ONCE, and records EXACTLY ONE payment & revenue entry", async () => {
    const h = createIntegrationHarness();
    const oldReceipt = "subscription_receipts/merchant_cross_1/req_resub_old.jpg";
    const newReceipt = "subscription_receipts/merchant_cross_1/req_resub_new.jpg";
    h.storageFiles.add(oldReceipt);
    h.storageFiles.add(newReceipt);

    // Submit initial blurry receipt
    await h.service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
      requestId: "req_resub_race",
      planId: "plan_4_captains",
      senderPhone: "01055552222",
      transactionReference: "VF-RESUB-01",
      receiptImagePath: oldReceipt,
    });

    // Admin requests resubmission
    const resubReq = await h.service.requestSubscriptionReceiptResubmission(ADMIN_AUTH, {
      requestId: "req_resub_race",
      note: "الصورة غير واضحة، يرجى رفع إيصال أوضح",
    });
    assert.equal(resubReq.status, "resubmission_required");
    assert.equal(h.db.listCollection("payments").length, 0);

    // Merchant re-uploads & resubmits through central Cloud Function
    h.advanceClock(30_000);
    const resubmitted = await h.service.submitManualSubscriptionRequest(MERCHANT_AUTH, {
      requestId: "req_resub_race",
      planId: "plan_4_captains",
      senderPhone: "01055552222",
      transactionReference: "VF-RESUB-01",
      receiptImagePath: newReceipt,
    });
    assert.equal(resubmitted.isResubmission, true);
    assert.equal(resubmitted.status, "pending_review");

    const updatedReq = h.db.getDocData("manual_subscription_requests/req_resub_race");
    assert.equal(updatedReq.previousReceipts.length, 1);
    assert.equal(updatedReq.previousReceipts[0].receiptImagePath, oldReceipt);
    assert.equal(updatedReq.receiptImagePath, newReceipt);

    // 5 concurrent admin approval attempts fire simultaneously
    h.advanceClock(30_000);
    const outcomes = await Promise.allSettled(
      Array.from({length: 5}, () =>
        h.service.approveManualSubscriptionRequest(ADMIN_AUTH, {
          requestId: "req_resub_race",
          adminNote: "موافقة متزامنة",
        })
      )
    );

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 4);

    // Strictly ONE payment & revenue counted ONCE (800 EGP)
    const payments = h.db.listCollection("payments");
    assert.equal(payments.length, 1);
    assert.equal(payments[0].id, "manual_sub_req_resub_race");
    assert.equal(payments[0].data.amount, 800);

    const rev = computeDashboardRevenueMetrics(payments, "2026-11");
    assert.equal(rev.totalRevenue, 800);
    assert.equal(rev.monthlyRevenue, 800);
    assert.equal(rev.monthlySuccessfulCount, 1);

    const finalAppState = resolveMerchantAppSubscriptionState(
      h.db.getDocData("subscriptions/merchant_cross_1"),
      h.db.getDocData("merchants/merchant_cross_1"),
      h.getNow()
    );
    assert.equal(finalAppState.canRequestCaptain, true);
    assert.equal(finalAppState.maxCaptains, 4);
  });
});
