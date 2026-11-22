"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DomainHttpsError = void 0;
/**
 * Domain error mapped directly to Firebase Functions HttpsError codes.
 */
class DomainHttpsError extends Error {
    /**
     * Constructs a structured callable domain error.
     * @param {CallableErrorCode} code Firebase callable error code.
     * @param {string} message Localized Arabic error message.
     */
    constructor(code, message) {
        super(message);
        this.name = "DomainHttpsError";
        this.code = code;
    }
}
exports.DomainHttpsError = DomainHttpsError;
//# sourceMappingURL=types.js.map