import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import {deleteApp, initializeApp} from "firebase-admin/app";
import {FieldValue, getFirestore} from "firebase-admin/firestore";

// This script is only run by firebase emulators:exec. Never point it at production.
const projectId = process.env.GCLOUD_PROJECT || "demo-elbatal-express";
if (!projectId.startsWith("demo-")) {
  throw new Error(`Refusing to run trigger integration tests against non-demo project: ${projectId}`);
}
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8085";

const app = initializeApp({projectId}, `firestore-trigger-tests-${process.pid}`);
const db = getFirestore(app);
const runId = `${Date.now().toString(36)}_${process.pid}`;
const merchantId = `it_merchant_${runId}`;

async function waitForDocument(ref, predicate, description, timeoutMs = 45_000) {
  const startedAt = Date.now();
  let latest;
  while (Date.now() - startedAt < timeoutMs) {
    const snap = await ref.get();
    latest = snap.data();
    if (snap.exists && predicate(latest)) return latest;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(latest)}`);
}

async function seedMerchantAndSubscription() {
  await Promise.all([
    db.collection("merchants").doc(merchantId).set({
      uid: merchantId,
      accountType: "merchant",
      role: "merchant",
      status: "active",
      name: "متجر اختبار التكامل",
      phone: "01000000000",
      logoUrl: "https://example.invalid/test-logo.png",
      latitude: 30.0444,
      longitude: 31.2357,
    }),
    db.collection("subscriptions").doc(merchantId).set({
      merchantId,
      status: "active",
      subscriptionVersion: 1,
      maxCaptains: 2,
      endDate: "2099-12-31",
    }),
  ]);
}

function dispatcherOrder(orderId) {
  return {
    orderId,
    orderNumber: orderId,
    status: "pending",
    dispatchStatus: "searching",
    dispatchAuthority: "dashboard_functions",
    createdByServerFunction: "merchantCreateOrder",
    merchantId,
    restaurantId: merchantId,
    captainId: null,
    driverId: null,
    offeredCaptainId: null,
    offerGeneration: 0,
    pickupLat: 30.0444,
    pickupLng: 31.2357,
    pickupAddress: "عنوان اختبار",
    deliveryAddress: "وجهة اختبار",
    storeName: "متجر اختبار التكامل",
    storePhone: "01000000000",
    storeImage: "https://example.invalid/test-logo.png",
    deliveryFee: 20,
    createdAt: FieldValue.serverTimestamp(),
  };
}

const cleanup = [];
try {
  console.log("1/4 Seed merchant and active subscription");
  await seedMerchantAndSubscription();

  // A known invalid subscription is a permanent business error, not a retry loop.
  const invalidMerchantId = `${merchantId}_expired`;
  cleanup.push(
    db.collection("merchants").doc(invalidMerchantId),
    db.collection("subscriptions").doc(invalidMerchantId)
  );
  await Promise.all([
    db.collection("merchants").doc(invalidMerchantId).set({
      uid: invalidMerchantId,
      accountType: "merchant",
      status: "active",
      name: "متجر اشتراك منتهي",
      phone: "01000000001",
      logoUrl: "https://example.invalid/expired-logo.png",
      latitude: 30.0444,
      longitude: 31.2357,
    }),
    db.collection("subscriptions").doc(invalidMerchantId).set({
      merchantId: invalidMerchantId,
      status: "expired",
      endDate: "2020-01-01",
    }),
  ]);
  const failedOrderId = `it_order_invalid_subscription_${runId}`;
  const failedOrderRef = db.collection("orders").doc(failedOrderId);
  const failedAlertRef = db.collection("notifications").doc(`dispatch_failed_${failedOrderId}`);
  cleanup.push(failedOrderRef, failedAlertRef);
  await failedOrderRef.set({
    ...dispatcherOrder(failedOrderId),
    merchantId: invalidMerchantId,
    restaurantId: invalidMerchantId,
  });
  const failedOrder = await waitForDocument(
    failedOrderRef,
    (data) => data.dispatchStatus === "dispatch_failed",
    "permanent dispatch business error to be recorded"
  );
  assert.equal(failedOrder.dispatchFailureCode, "failed-precondition");
  assert.equal((await failedAlertRef.get()).exists, true);

  console.log("2/4 Test Firestore document-created dispatch trigger");
  const createdOrderId = `it_order_created_${runId}`;
  const createdOrderRef = db.collection("orders").doc(createdOrderId);
  cleanup.push(createdOrderRef);
  const createdAlertRef = db.collection("notifications")
    .doc(`captain_assignment_failed_${createdOrderId}`);
  cleanup.push(createdAlertRef);

  await createdOrderRef.set(dispatcherOrder(createdOrderId));
  const createdOrder = await waitForDocument(
    createdOrderRef,
    (data) => data.dispatchStatus === "no_captains_available",
    "created order to be processed by onOrderCreatedDispatch"
  );
  assert.equal(createdOrder.status, "searching");
  assert.equal(createdOrder.offeredCaptainId, null);
  const createdAlert = await waitForDocument(
    createdAlertRef,
    (data) => data.type === "captain_assignment_failed",
    "admin alert for order with no eligible captains"
  );
  assert.equal(createdAlert.orderId, createdOrderId);
  const alertsForCreatedOrder = await db.collection("notifications")
    .where("orderId", "==", createdOrderId).get();
  assert.equal(alertsForCreatedOrder.size, 1, "Duplicate event deliveries must not duplicate the admin alert");

  console.log("3/4 Test Firestore document-updated dispatch and capacity release triggers");
  // Re-queue the same order. The update trigger should run the dispatcher again.
  await createdOrderRef.update({
    status: "searching",
    dispatchStatus: "searching",
    requeueTestMarker: runId,
    updatedAt: FieldValue.serverTimestamp(),
  });
  const requeuedOrder = await waitForDocument(
    createdOrderRef,
    (data) => data.dispatchStatus === "no_captains_available" &&
      data.requeueTestMarker === runId,
    "re-queued order to be processed by onOrderUpdatedDispatch"
  );
  assert.equal(requeuedOrder.offeredCaptainId, null);

  const capacityOrderId = `it_capacity_order_${runId}`;
  const capacityOrderRef = db.collection("orders").doc(capacityOrderId);
  const capacityRef = db.collection("merchants").doc(merchantId)
    .collection("capacity").doc("current");
  cleanup.push(capacityOrderRef, capacityRef);

  await capacityRef.set({
    merchantId,
    reservedOrderIds: [capacityOrderId],
    activeReservationsCount: 1,
    capacityVersion: 0,
  });
  await capacityOrderRef.set({
    orderId: capacityOrderId,
    orderNumber: capacityOrderId,
    merchantId,
    status: "en_route",
    dispatchStatus: "assigned",
    captainId: "integration_test_captain",
  });
  await capacityOrderRef.update({
    status: "delivered",
    deliveredAt: FieldValue.serverTimestamp(),
  });

  const releasedOrder = await waitForDocument(
    capacityOrderRef,
    (data) => data.capacityReleased === true,
    "terminal order capacity to be released"
  );
  assert.equal(releasedOrder.status, "delivered");
  const afterRelease = await capacityRef.get();
  assert.deepEqual(afterRelease.data().reservedOrderIds, []);
  assert.equal(afterRelease.data().activeReservationsCount, 0);
  assert.equal(afterRelease.data().capacityVersion, 1);

  // A second update after the terminal transition must not release the slot twice.
  await capacityOrderRef.update({postReleaseAuditMarker: runId});
  await delay(1_000);
  const afterDuplicateEvent = await capacityRef.get();
  assert.deepEqual(afterDuplicateEvent.data().reservedOrderIds, []);
  assert.equal(afterDuplicateEvent.data().capacityVersion, 1);

  console.log("4/4 Test Firestore document-created manual subscription trigger");
  const requestId = `it_manual_request_${runId}`;
  const requestRef = db.collection("manual_subscription_requests").doc(requestId);
  const manualNotificationRef = db.collection("notifications")
    .doc(`manual_sub_req_${requestId}`);
  cleanup.push(requestRef, manualNotificationRef);

  await requestRef.set({
    merchantId,
    merchantName: "متجر اختبار التكامل",
    planName: "باقة اختبار",
    amount: 100,
    status: "pending_review",
    createdAt: FieldValue.serverTimestamp(),
  });
  const manualNotification = await waitForDocument(
    manualNotificationRef,
    (data) => data.type === "manual_subscription_request",
    "manual subscription admin notification"
  );
  assert.equal(manualNotification.requestId, requestId);

  assert.equal(manualNotification.amount, 100);

  console.log("PASS: Firestore create/update triggers, permanent-error handling, capacity release, and manual-subscription alert");
} finally {
  await Promise.all(cleanup.map((ref) => ref.delete().catch(() => undefined)));
  await Promise.all([
    db.collection("merchants").doc(merchantId).delete().catch(() => undefined),
    db.collection("subscriptions").doc(merchantId).delete().catch(() => undefined),
  ]);
  await deleteApp(app);
}
