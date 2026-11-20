import {describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const firestoreRules = fs.readFileSync(path.join(repoRoot, "firestore.rules"), "utf8");
const storageRules = fs.readFileSync(path.join(repoRoot, "storage.rules"), "utf8");
const manualSubServiceSrc = fs.readFileSync(
  path.join(repoRoot, "src/services/manualSubscriptionService.ts"),
  "utf8"
);
const settingsPageSrc = fs.readFileSync(
  path.join(repoRoot, "src/pages/Settings.tsx"),
  "utf8"
);

describe("Static Security & Architecture Invariants (Rules + Server-Only Enforcement)", () => {
  it("1. firestore.rules enforces merchant-scoped manual_subscription_requests and blocks direct approval/paid tampering", () => {
    assert.match(firestoreRules, /function isValidManualSubscriptionCreate\(data, uid\)/);
    assert.match(firestoreRules, /data\.merchantId == uid/);
    assert.match(firestoreRules, /data\.status == 'pending'/);
    assert.match(firestoreRules, /data\.paymentStatus == 'pending_verification'/);
    assert.match(firestoreRules, /match\s+\/manual_subscription_requests\/\{requestId\}/);
    assert.match(firestoreRules, /existing\(\)\.status == 'resubmission_requested'/);
    assert.match(firestoreRules, /allow delete:\s*if false;/);
  });

  it("2. firestore.rules locks settings/manual_subscription_config and operation_logs to server-side Admin SDK only", () => {
    assert.match(
      firestoreRules,
      /match\s+\/settings\/manual_subscription_config\s*\{[\s\S]*?allow read:\s*if isSignedIn\(\);[\s\S]*?allow write:\s*if false;/
    );
    assert.match(
      firestoreRules,
      /match\s+\/operation_logs\/\{logId\}\s*\{[\s\S]*?allow read:\s*if isAdmin\(\);[\s\S]*?allow write:\s*if false;/
    );
  });

  it("3. firestore.rules scopes merchant subscription notifications strictly to owning merchant (read/isRead only)", () => {
    assert.match(
      firestoreRules,
      /match\s+\/notifications\/\{notifId\}\s*\{[\s\S]*?allow get, list:\s*if isSignedIn\(\)[\s\S]*?isMerchantAccount\(\) && request\.auth\.uid == merchantId[\s\S]*?affectedKeys\(\)\.hasOnly\(\['isRead', 'readAt'\]\)[\s\S]*?allow create, delete:\s*if false;/
    );
  });

  it("4. storage.rules isolates subscription_receipts/{merchantId} to owning merchant + admin with image MIME & 10MB limit", () => {
    assert.match(
      storageRules,
      /match\s+\/subscription_receipts\/\{merchantId\}\/\{allFiles=\*\*\}\s*\{[\s\S]*?allow read:\s*if isAuthenticated\(\)[\s\S]*?request\.auth\.uid == merchantId \|\| isAdmin\(\)[\s\S]*?allow create, update:\s*if isAuthenticated\(\)[\s\S]*?isMerchantAccount\(\)[\s\S]*?request\.auth\.uid == merchantId[\s\S]*?isValidImageUpload\(\);[\s\S]*?allow delete:\s*if isAdmin\(\);/
    );
    assert.match(
      storageRules,
      /match\s+\/manual_subscription_receipts\/\{merchantId\}\/\{allFiles=\*\*\}/
    );
  });

  it("5. Frontend ManualSubscriptionService performs ZERO direct Firestore writes and invokes Cloud Functions exclusively", () => {
    assert.doesNotMatch(
      manualSubServiceSrc,
      /\b(setDoc|updateDoc|addDoc|deleteDoc|writeBatch|runTransaction)\b/,
      "Frontend ManualSubscriptionService must NOT execute direct Firestore writes"
    );
    assert.match(manualSubServiceSrc, /'approveManualSubscriptionRequest'/);
    assert.match(manualSubServiceSrc, /'rejectManualSubscriptionRequest'/);
    assert.match(manualSubServiceSrc, /'requestManualSubscriptionResubmission'/);
    assert.match(manualSubServiceSrc, /'updateManualSubscriptionSettings'/);
  });

  it("6. No hardcoded Vodafone Cash wallet number exists in ManualSubscriptionService or Settings page", () => {
    assert.match(manualSubServiceSrc, /vodafoneCashNumber:\s*''/);
    assert.match(settingsPageSrc, /useState\(''\)/);
    assert.doesNotMatch(
      manualSubServiceSrc,
      /vodafoneCashNumber:\s*['"]01[0125]\d{8}['"]/,
      "Vodafone Cash wallet number must NEVER be hardcoded"
    );
    assert.doesNotMatch(
      settingsPageSrc,
      /vodafoneCashNumber\s*=\s*['"]01[0125]\d{8}['"]/,
      "Vodafone Cash wallet number must NEVER be hardcoded in Settings.tsx"
    );
  });
});
