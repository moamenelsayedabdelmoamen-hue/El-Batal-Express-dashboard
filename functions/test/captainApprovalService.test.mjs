import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {CaptainApprovalServerService} from "../lib/captainApprovalService.js";
import {
  assertCaptainOperationalForOrder,
  resolveCaptainAccountStatus,
} from "../lib/validators.js";
import {DomainHttpsError} from "../lib/types.js";

class InMemoryFirestore {
  constructor() {
    this.docs = new Map();
    this.autoId = 1;
  }

  seed(path, data) {
    this.docs.set(path, structuredClone(data));
  }

  getDocData(path) {
    const data = this.docs.get(path);
    return data ? structuredClone(data) : undefined;
  }

  listCollection(basePath) {
    const prefix = `${basePath}/`;
    const items = [];
    for (const [path, data] of this.docs.entries()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest.includes("/")) continue;
      items.push({id: rest, path, data: structuredClone(data)});
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
      get: async () => this._wrapSnap(path, this.docs.get(path)),
      set: async (data, options) => {
        const cur = this.docs.get(path);
        const target = options?.merge && cur ? structuredClone(cur) : {};
        this._applyMutations(target, data);
        this.docs.set(path, target);
      },
      update: async (data) => {
        const cur = this.docs.get(path);
        if (!cur) throw new Error(`Document not found for update: ${path}`);
        const target = structuredClone(cur);
        this._applyMutations(target, data);
        this.docs.set(path, target);
      },
    };
  }

  _makeCollectionRef(basePath) {
    const q = this._makeQuery(basePath, [], null);
    return {
      ...q,
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
      get: async () => {
        const matched = [];
        for (const item of this.listCollection(basePath)) {
          let ok = true;
          for (const f of filters) {
            const val = item.data[f.fieldPath];
            if (f.opStr === "==" && val !== f.value) ok = false;
            if (f.opStr === "in" && (!Array.isArray(f.value) || !f.value.includes(val))) ok = false;
            if (f.opStr === "array-contains" && (!Array.isArray(val) || !val.includes(f.value))) ok = false;
          }
          if (ok) {
            matched.push(item);
            if (limitCount !== null && matched.length >= limitCount) break;
          }
        }
        return {
          empty: matched.length === 0,
          size: matched.length,
          docs: matched.map((m) => this._wrapSnap(m.path, m.data)),
        };
      },
    };
  }

  async runTransaction(fn) {
    const staged = new Map();
    const tx = {
      get: async (ref) => {
        const data = staged.has(ref.path)
          ? staged.get(ref.path)
          : this.docs.get(ref.path);
        return this._wrapSnap(ref.path, data);
      },
      getQuery: async (q) => q.get(),
      set: (ref, data, options) => {
        const cur = staged.has(ref.path)
          ? staged.get(ref.path)
          : this.docs.get(ref.path);
        const target = options?.merge && cur ? structuredClone(cur) : {};
        this._applyMutations(target, data);
        staged.set(ref.path, target);
      },
      update: (ref, data) => {
        const cur = staged.has(ref.path)
          ? staged.get(ref.path)
          : this.docs.get(ref.path);
        if (!cur) throw new Error(`Missing doc in tx update: ${ref.path}`);
        const target = structuredClone(cur);
        this._applyMutations(target, data);
        staged.set(ref.path, target);
      },
    };
    const result = await fn(tx);
    for (const [k, v] of staged.entries()) {
      this.docs.set(k, v);
    }
    return result;
  }

  _wrapSnap(path, data) {
    const exists = data !== undefined;
    return {
      id: path.split("/").pop(),
      exists,
      ref: this._makeDocRef(path),
      data: () => (exists ? structuredClone(data) : undefined),
    };
  }

  _applyMutations(target, patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === "object" && "__sentinel" in v) {
        if (v.__sentinel === "serverTimestamp") {
          target[k] = new Date(1762800000000);
        } else if (v.__sentinel === "deleteField") {
          delete target[k];
        } else if (v.__sentinel === "increment") {
          target[k] = Number(target[k] || 0) + Number(v.operand || 0);
        }
      } else {
        target[k] = structuredClone(v);
      }
    }
  }
}

function createFakeEffects(initialMs = 1762800000000) {
  let now = initialMs;
  const captainPushes = [];
  const adminPushes = [];
  return {
    captainPushes,
    adminPushes,
    advance: (deltaMs) => {
      now += deltaMs;
    },
    port: {
      now: () => now,
      sentinels: {
        serverTimestamp: () => ({__sentinel: "serverTimestamp"}),
        deleteField: () => ({__sentinel: "deleteField"}),
        increment: (operand) => ({__sentinel: "increment", operand}),
        arrayUnion: (...elements) => ({__sentinel: "arrayUnion", elements}),
      },
      sendCaptainStatusNotification: async (payload) => {
        captainPushes.push(payload);
      },
      sendAdminNewCaptainNotification: async (payload) => {
        adminPushes.push(payload);
      },
    },
  };
}

const ADMIN_AUTH = {
  uid: "admin_1",
  token: {
    email: "admin@elbatalexpress.com",
    email_verified: true,
    role: "admin",
  },
};

const CAPTAIN_AUTH = {
  uid: "cap_1",
  token: {
    email: "cap1@example.com",
    email_verified: true,
    role: "captain",
  },
};

describe("CaptainApprovalServerService & Approval Eligibility", () => {
  it("1. New pending captain triggers admin alert, welcome notification, and initial audit log (idempotent)", async () => {
    const db = new InMemoryFirestore();
    const effects = createFakeEffects();
    const svc = new CaptainApprovalServerService(db, effects.port);

    db.seed("admins/admin_1", {
      role: "admin",
      status: "active",
      emailVerified: true,
      fcmToken: "admin_fcm_token_1",
    });

    const newCaptainDoc = {
      uid: "cap_pending_1",
      name: "أحمد محمود",
      fullName: "أحمد محمود",
      phone: "01012345678",
      accountType: "captain",
      role: "captain",
      status: "pending",
      accountStatus: "pending",
      isApproved: false,
      vehicleType: "موتوسيكل",
      fcmToken: "cap_fcm_1",
    };

    await svc.handleNewCaptainCreated("cap_pending_1", newCaptainDoc);
    await svc.handleNewCaptainCreated("cap_pending_1", newCaptainDoc);

    assert.equal(db.listCollection("notifications").length, 1);
    assert.equal(db.getDocData("notifications/new_captain_cap_pending_1").type, "new_captain_registration");
    assert.equal(db.getDocData("captain_audit_logs/capt_cap_pending_1_registration_received").action, "registration_received");
    assert.equal(db.getDocData("captains/cap_pending_1/notifications/welcome_cap_pending_1").accountStatus, "pending");
    assert.equal(effects.adminPushes.length, 1);
    assert.deepEqual(effects.adminPushes[0].tokens, ["admin_fcm_token_1"]);
    assert.equal(effects.captainPushes.length, 1);
  });

  it("2. Rejects non-admin or unauthenticated moderation attempts with permission-denied / unauthenticated", async () => {
    const db = new InMemoryFirestore();
    const effects = createFakeEffects();
    const svc = new CaptainApprovalServerService(db, effects.port);

    db.seed("captains/cap_1", {
      uid: "cap_1",
      name: "كابتن تجريبي",
      accountType: "captain",
      role: "captain",
      status: "pending",
      accountStatus: "pending",
      isApproved: false,
    });

    await assert.rejects(
      () => svc.approveCaptain(undefined, {captainId: "cap_1"}),
      (err) => err instanceof DomainHttpsError && err.code === "unauthenticated"
    );

    await assert.rejects(
      () => svc.approveCaptain(CAPTAIN_AUTH, {captainId: "cap_1"}),
      (err) => err instanceof DomainHttpsError && err.code === "permission-denied"
    );
  });

  it("3. Approves, suspends (requires reason), reactivates, rejects, and permanently blocks captain atomically with audit logs", async () => {
    const db = new InMemoryFirestore();
    const effects = createFakeEffects();
    const svc = new CaptainApprovalServerService(db, effects.port);

    db.seed("admins/admin_1", {
      role: "admin",
      status: "active",
      emailVerified: true,
      displayName: "سوبر أدمن",
    });
    db.seed("captains/cap_1", {
      uid: "cap_1",
      name: "كابتن علي",
      phone: "01099887766",
      accountType: "captain",
      role: "captain",
      status: "pending",
      accountStatus: "pending",
      isApproved: false,
      isOnline: false,
      fcmToken: "cap_fcm_token",
    });

    // Reject requires a mandatory reason
    await assert.rejects(
      () => svc.rejectCaptain(ADMIN_AUTH, {captainId: "cap_1", reason: "  "}),
      (err) => err instanceof DomainHttpsError && err.code === "invalid-argument"
    );

    // 1) Approve
    const approveRes = await svc.approveCaptain(ADMIN_AUTH, {
      captainId: "cap_1",
      note: "المستندات مكتملة وصحيحة",
    });
    assert.equal(approveRes.success, true);
    assert.equal(approveRes.accountStatus, "approved");
    assert.equal(approveRes.isApproved, true);
    let cap = db.getDocData("captains/cap_1");
    assert.equal(cap.accountStatus, "approved");
    assert.equal(cap.isApproved, true);
    assert.equal(cap.canReceiveOrders, true);

    // 2) Suspend with reason forces offline & blocks order eligibility
    effects.advance(1000);
    await assert.rejects(
      () => svc.suspendCaptain(ADMIN_AUTH, {captainId: "cap_1", reason: ""}),
      (err) => err instanceof DomainHttpsError && err.code === "invalid-argument"
    );
    await svc.suspendCaptain(ADMIN_AUTH, {
      captainId: "cap_1",
      reason: "عدم الالتزام بمواعيد التسليم المتكرر",
    });
    cap = db.getDocData("captains/cap_1");
    assert.equal(cap.accountStatus, "suspended");
    assert.equal(cap.isApproved, false);
    assert.equal(cap.isSuspended, true);
    assert.equal(cap.isOnline, false);
    assert.equal(cap.canReceiveOrders, false);
    assert.equal(cap.suspensionReason, "عدم الالتزام بمواعيد التسليم المتكرر");

    // 3) Reactivate restores approved state and clears suspensionReason
    effects.advance(1000);
    await svc.reactivateCaptain(ADMIN_AUTH, {captainId: "cap_1"});
    cap = db.getDocData("captains/cap_1");
    assert.equal(cap.accountStatus, "approved");
    assert.equal(cap.isApproved, true);
    assert.equal(cap.isSuspended, false);
    assert.equal(cap.suspensionReason, undefined);

    // 4) Permanent Block
    effects.advance(1000);
    await svc.blockCaptain(ADMIN_AUTH, {
      captainId: "cap_1",
      reason: "مخالفة جسيمة لسياسة المنصة",
    });
    cap = db.getDocData("captains/cap_1");
    assert.equal(cap.accountStatus, "blocked");
    assert.equal(cap.isBlocked, true);
    assert.equal(cap.isApproved, false);
    assert.equal(cap.blockReason, "مخالفة جسيمة لسياسة المنصة");

    assert.equal(db.listCollection("captain_audit_logs").length, 4);
    assert.equal(db.listCollection("operation_logs").length, 4);
    assert.equal(effects.captainPushes.length, 4);
    assert.equal(effects.captainPushes[3].eventType, "blocked");
  });

  it("4. Preserves backward compatibility for legacy approved captains lacking accountStatus/isApproved while blocking unapproved captains from orders", () => {
    const nowMs = 1762800000000;
    const legacyCaptain = {
      uid: "legacy_1",
      accountType: "captain",
      role: "captain",
      status: "online",
      isOnline: true,
      workStatus: "working",
      readyConfirmed: true,
      readyShiftKey: "legacy-test-shift",
      workingShiftKey: "legacy-test-shift",
      presenceStatus: "working",
      latitude: 30.0444,
      longitude: 31.2357,
      lastLocationTimestamp: nowMs - 10000,
    };
    assert.equal(resolveCaptainAccountStatus(legacyCaptain), "approved");
    const coords = assertCaptainOperationalForOrder(legacyCaptain, nowMs);
    assert.equal(coords.lat, 30.0444);

    const pendingCaptain = {
      ...legacyCaptain,
      status: "pending",
      accountStatus: "pending",
      isApproved: false,
    };
    assert.equal(resolveCaptainAccountStatus(pendingCaptain), "pending");
    assert.throws(
      () => assertCaptainOperationalForOrder(pendingCaptain, nowMs),
      (err) => err instanceof DomainHttpsError && err.code === "permission-denied"
    );

    const rejectedCaptain = {
      ...legacyCaptain,
      accountStatus: "rejected",
      isApproved: false,
    };
    assert.equal(resolveCaptainAccountStatus(rejectedCaptain), "rejected");
    assert.throws(
      () => assertCaptainOperationalForOrder(rejectedCaptain, nowMs),
      (err) => err instanceof DomainHttpsError && err.code === "permission-denied"
    );
  });
});
