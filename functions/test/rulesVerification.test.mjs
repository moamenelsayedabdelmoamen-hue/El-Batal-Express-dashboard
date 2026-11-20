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
const functionsIndexSrc = fs.readFileSync(
  path.join(repoRoot, "functions/src/index.ts"),
  "utf8"
);

function collectSourceFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "lib") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

describe("Static Security & Architecture Invariants (Rules + Server-Only + Paymob Removal)", () => {
  it("1. firestore.rules allows merchant-scoped reads but blocks every direct write to manual_subscription_requests", () => {
    const requestRules = firestoreRules.match(
      /match\s+\/manual_subscription_requests\/\{requestId\}\s*\{([\s\S]*?)\n    \}/
    )?.[1] || "";
    assert.match(requestRules, /allow get, list:\s*if isAdmin\(\) \|\|/);
    assert.match(requestRules, /allow create, update, delete:\s*if false;/);
    assert.doesNotMatch(requestRules, /allow\s+(?:create|update|delete|write):\s*if\s+(?!false\s*;)/);
  });

  it("2. firestore.rules locks settings/manual_subscription_config, operation_logs, and retired webhook_events to server-only / read-only", () => {
    assert.match(
      firestoreRules,
      /match\s+\/settings\/manual_subscription_config\s*\{[\s\S]*?allow read:\s*if isSignedIn\(\);[\s\S]*?allow write:\s*if false;/
    );
    assert.match(
      firestoreRules,
      /match\s+\/operation_logs\/\{logId\}\s*\{[\s\S]*?allow read:\s*if isAdmin\(\);[\s\S]*?allow write:\s*if false;/
    );
    assert.match(
      firestoreRules,
      /match\s+\/webhook_events\/\{eventId\}\s*\{[\s\S]*?allow read:\s*if isAdmin\(\);[\s\S]*?allow write:\s*if false;/
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
    // Legacy nested receipts must not inherit authenticated-user read access from merchant assets.
    assert.match(
      storageRules,
      /match\s+\/merchants\/\{merchantId\}\/\{allFiles=\*\*\}\s*\{[\s\S]*?allow read:\s*if isAuthenticated\(\)[\s\S]*?!allFiles\.matches\('subscription_receipts\/\.\*'\)/
    );
    // Nested merchant receipt paths are create-only for the owner; generic asset rules cannot grant updates.
    const genericMerchantRules = storageRules.match(
      /match\s+\/merchants\/\{merchantId\}\/\{allFiles=\*\*\}\s*\{([\s\S]*?)\n    \}/
    )?.[1] || "";
    assert.match(
      genericMerchantRules,
      /allow create, update:\s*if isAuthenticated\(\)[\s\S]*?!allFiles\.matches\('subscription_receipts\/\.\*'\)/
    );
    const nestedReceiptRules = storageRules.match(
      /match\s+\/merchants\/\{merchantId\}\/subscription_receipts\/\{fileName\}\s*\{([\s\S]*?)\n    \}/
    )?.[1] || "";
    assert.match(
      nestedReceiptRules,
      /allow create:\s*if isAuthenticated\(\)[\s\S]*?request\.auth\.uid == merchantId/
    );
    assert.match(nestedReceiptRules, /allow update, delete:\s*if isAdmin\(\);/);
  });

  it("5. Central Cloud Functions exports all 4 required functions + settings updater + notification trigger", () => {
    assert.match(functionsIndexSrc, /export const submitManualSubscriptionRequest\b/);
    assert.match(functionsIndexSrc, /export const approveManualSubscriptionRequest\b/);
    assert.match(functionsIndexSrc, /export const rejectManualSubscriptionRequest\b/);
    assert.match(functionsIndexSrc, /export const requestSubscriptionReceiptResubmission\b/);
    assert.match(functionsIndexSrc, /export const updateManualSubscriptionSettings\b/);
    assert.match(functionsIndexSrc, /export const onManualSubscriptionRequestCreated\b/);
  });

  it("6. Frontend ManualSubscriptionService performs ZERO direct Firestore writes and invokes Cloud Functions exclusively", () => {
    assert.doesNotMatch(
      manualSubServiceSrc,
      /\b(setDoc|updateDoc|addDoc|deleteDoc|writeBatch|runTransaction)\b/,
      "Frontend ManualSubscriptionService must NOT execute direct Firestore writes"
    );
    assert.match(manualSubServiceSrc, /'approveManualSubscriptionRequest'/);
    assert.match(manualSubServiceSrc, /'rejectManualSubscriptionRequest'/);
    assert.match(manualSubServiceSrc, /'requestSubscriptionReceiptResubmission'/);
    assert.match(manualSubServiceSrc, /'updateManualSubscriptionSettings'/);
  });

  it("7. No hardcoded Vodafone Cash wallet number or hardcoded package prices exist in ManualSubscriptionService or Settings page", () => {
    assert.match(manualSubServiceSrc, /vodafoneCashNumber:\s*''/);
    assert.match(manualSubServiceSrc, /plans:\s*\[\]/);
    assert.match(settingsPageSrc, /useState\(''\)/);
    assert.doesNotMatch(
      manualSubServiceSrc,
      /DEFAULT_PLAN_TEMPLATES/,
      "Package prices must NOT be hardcoded in ManualSubscriptionService"
    );
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

  it("8. Zero Paymob references remain anywhere in src/ or functions/src/", () => {
    const allFiles = [
      ...collectSourceFiles(path.join(repoRoot, "src")),
      ...collectSourceFiles(path.join(repoRoot, "functions/src")),
    ];
    const offending = [];
    for (const file of allFiles) {
      const content = fs.readFileSync(file, "utf8");
      if (/paymob/i.test(content)) {
        offending.push(path.relative(repoRoot, file));
      }
    }
    assert.deepEqual(
      offending,
      [],
      `Found leftover Paymob references in: ${offending.join(", ")}`
    );
  });
});
