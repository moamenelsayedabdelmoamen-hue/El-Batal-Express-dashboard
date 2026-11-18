"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.reassignOrderOffer = exports.onOrderUpdatedDispatch = exports.onOrderCreatedDispatch = exports.resolveCaptainEmailByPhone = exports.expireDeliveryOffer = exports.confirmDelivery = exports.submitCustomerDeliveryDetails = exports.confirmPickup = exports.captainArrivedAtMerchant = exports.acceptOrder = void 0;
const app_1 = require("firebase-admin/app");
const firestore_1 = require("firebase-admin/firestore");
const firebase_functions_1 = require("firebase-functions");
const logger = __importStar(require("firebase-functions/logger"));
const firestore_2 = require("firebase-functions/v2/firestore");
const https_1 = require("firebase-functions/v2/https");
const tasks_1 = require("firebase-functions/v2/tasks");
const firebaseAdapter_js_1 = require("./firebaseAdapter.js");
const ordersService_js_1 = require("./ordersService.js");
const types_js_1 = require("./types.js");
const validators_js_1 = require("./validators.js");
(0, app_1.initializeApp)();
(0, firebase_functions_1.setGlobalOptions)({ region: "us-central1", maxInstances: 10 });
const service = new ordersService_js_1.OrderServerService((0, firebaseAdapter_js_1.createAdminDatabaseAdapter)((0, firestore_1.getFirestore)()), (0, firebaseAdapter_js_1.createAdminServerEffects)());
function mapError(err) {
    if (err instanceof https_1.HttpsError)
        return err;
    if (err instanceof types_js_1.DomainHttpsError) {
        return new https_1.HttpsError(err.code, err.message);
    }
    logger.error("Unhandled Cloud Function order error", {
        error: err instanceof Error ? err.message : String(err),
    });
    return new https_1.HttpsError("internal", "حدث خطأ غير متوقع في الخادم أثناء تنفيذ العملية.");
}
/**
 * Callable 1: Authoritative order acceptance by authenticated captain.
 */
exports.acceptOrder = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await service.acceptOrder((_b = request.auth) === null || _b === void 0 ? void 0 : _b.uid, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Callable 2: Captain records arrival at merchant pickup location.
 */
exports.captainArrivedAtMerchant = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await service.captainArrivedAtMerchant((_b = request.auth) === null || _b === void 0 ? void 0 : _b.uid, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Callable 3: Captain confirms picking up order from merchant.
 */
exports.confirmPickup = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await service.confirmPickup((_b = request.auth) === null || _b === void 0 ? void 0 : _b.uid, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Callable 4: Captain submits customer details and verified receipt Storage path.
 */
exports.submitCustomerDeliveryDetails = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await service.submitCustomerDeliveryDetails((_b = request.auth) === null || _b === void 0 ? void 0 : _b.uid, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Callable 5: Atomic idempotent delivery completion and wallet credit.
 */
exports.confirmDelivery = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await service.confirmDelivery((_b = request.auth) === null || _b === void 0 ? void 0 : _b.uid, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Callable 6: Server-verified offer expiry or explicit decline.
 */
exports.expireDeliveryOffer = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a, _b;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await service.expireDeliveryOffer((_b = request.auth) === null || _b === void 0 ? void 0 : _b.uid, payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Callable 7: Read-only captain email lookup by phone number during pre-login.
 */
exports.resolveCaptainEmailByPhone = (0, https_1.onCall)({ region: "us-central1" }, async (request) => {
    var _a;
    try {
        const payload = ((_a = request.data) !== null && _a !== void 0 ? _a : {});
        return await service.resolveCaptainEmailByPhone(payload);
    }
    catch (err) {
        throw mapError(err);
    }
});
/**
 * Trigger 1: Auto-dispatches newly created pending orders to nearest eligible captain
 * with a server-authored 60-second offer deadline + Cloud Task watchdog.
 */
exports.onOrderCreatedDispatch = (0, firestore_2.onDocumentCreated)({ document: "orders/{orderId}", region: "us-central1" }, async (event) => {
    const orderId = event.params.orderId;
    try {
        await service.dispatchNewOrSearchingOrder(orderId);
    }
    catch (err) {
        logger.error("Failed initial dispatch for created order", {
            orderId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
});
/**
 * Trigger 2: Handles admin/merchant manual re-queue to searching state without looping.
 */
exports.onOrderUpdatedDispatch = (0, firestore_2.onDocumentUpdated)({ document: "orders/{orderId}", region: "us-central1" }, async (event) => {
    var _a, _b, _c, _d, _e;
    const after = (_a = event.data) === null || _a === void 0 ? void 0 : _a.after.data();
    const before = (_b = event.data) === null || _b === void 0 ? void 0 : _b.before.data();
    if (!after || !before)
        return;
    const afterStatus = (0, validators_js_1.readNormalizedOrderStatus)(after);
    const afterDispatch = String((_c = after.dispatchStatus) !== null && _c !== void 0 ? _c : "").toLowerCase();
    const beforeDispatch = String((_d = before.dispatchStatus) !== null && _d !== void 0 ? _d : "").toLowerCase();
    const afterOffered = String((_e = after.offeredCaptainId) !== null && _e !== void 0 ? _e : "").trim();
    if ((afterStatus === "pending" || afterStatus === "searching") &&
        afterDispatch === "searching" &&
        beforeDispatch !== "searching" &&
        !afterOffered) {
        try {
            await service.dispatchNewOrSearchingOrder(event.params.orderId);
        }
        catch (err) {
            logger.error("Failed re-queued dispatch for updated order", {
                orderId: event.params.orderId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
});
/**
 * Task Worker: Enforces the server-side 60-second offer expiry window and
 * reassigns to the next nearest eligible captain atomically.
 */
exports.reassignOrderOffer = (0, tasks_1.onTaskDispatched)({
    region: "us-central1",
    retryConfig: {
        maxAttempts: 3,
        minBackoffSeconds: 5,
    },
    rateLimits: {
        maxConcurrentDispatches: 20,
    },
}, async (req) => {
    var _a;
    const payload = ((_a = req.data) !== null && _a !== void 0 ? _a : {});
    try {
        await service.handleReassignOfferTask(payload);
    }
    catch (err) {
        logger.error("Error in reassignOrderOffer task", {
            orderId: payload === null || payload === void 0 ? void 0 : payload.orderId,
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }
});
//# sourceMappingURL=index.js.map