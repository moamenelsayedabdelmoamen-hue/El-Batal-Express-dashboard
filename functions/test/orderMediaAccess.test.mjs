import {describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "../src/index.ts"), "utf8");

describe("merchant order image access", () => {
  it("requires authentication and a real merchant profile", () => {
    assert.match(source, /export const getMerchantOrderImageUrl = onCall/);
    assert.match(source, /request\.auth\?\.uid/);
    assert.match(source, /collection\("merchants"\)\.doc\(uid\)\.get\(\)/);
    assert.match(source, /merchantSnap\.exists/);
  });

  it("only signs a receipt path recorded on an order owned by this merchant", () => {
    assert.match(source, /orders\\/\(\[\^\/\]\+\)\\/receipts/);
    assert.match(source, /const ownsOrder = \["merchantId", "restaurantId", "storeId", "vendorId", "ownerId"\]/);
    assert.match(source, /const recordedReceipt = \[/);
    assert.match(source, /authorized = ownsOrder && recordedReceipt/);
  });

  it("only signs a captain profile photo when the captain is assigned to a merchant-owned order", () => {
    assert.match(source, /captains\\/\(\[\^\/\]\+\)\\/profile\\/profile\\\.jpg/);
    assert.match(source, /const candidateFields = \["captainId", "captainUid", "driverId", "assignedCaptainId"\]/);
    assert.match(source, /orders\.docs\.some/);
    assert.match(source, /order\[key\] === uid/);
  });

  it("checks object existence and returns a short-lived read URL", () => {
    assert.match(source, /const \[exists\] = await file\.exists\(\)/);
    assert.match(source, /Date\.now\(\) \+ 15 \* 60 \* 1000/);
    assert.match(source, /file\.getSignedUrl\(\{action: "read", expires: expiresAt\}\)/);
  });
});
