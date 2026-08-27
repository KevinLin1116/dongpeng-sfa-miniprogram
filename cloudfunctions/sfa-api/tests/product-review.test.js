const assert = require("assert");
const {
  normalizeSamplingReview,
  normalizeProductDecisions,
  deriveProductReview,
  formatProductReviewOpinion,
  applyRejectedProductReview,
  scrubRejectedEvidence,
} = require("../product-review");

function expectCode(fn, code) {
  assert.throws(fn, (error) => error && error.code === code);
}

function testDecisionValidationAndOutcome() {
  const decisions = normalizeProductDecisions([
    { productRecordId: "p2", decision: "unqualified", reason: " 图片模糊 " },
    { productRecordId: "p1", decision: "qualified", reason: "客户端多余原因" },
  ], ["p1", "p2"]);
  assert.deepStrictEqual(decisions, [
    { productRecordId: "p1", decision: "qualified", reason: "" },
    { productRecordId: "p2", decision: "unqualified", reason: "图片模糊" },
  ]);
  const review = deriveProductReview(decisions);
  assert.strictEqual(review.decision, "rejected");
  assert.deepStrictEqual(review.summary, { pending: 0, decided: 2, qualified: 1, unqualified: 1 });
  assert.strictEqual(formatProductReviewOpinion(review, [{ products: [{ productRecordId: "p1", code: "DP1", name: "产品1" }, { productRecordId: "p2", code: "DP2", name: "产品2" }] }]), "合格 1 款；不合格 1 款：DP2 产品2—图片模糊");
}

function testValidationFailures() {
  expectCode(() => normalizeProductDecisions([{ productRecordId: "p1", decision: "qualified" }], ["p1", "p2"]), "PRODUCT_DECISIONS_INCOMPLETE");
  expectCode(() => normalizeProductDecisions([{ productRecordId: "p1", decision: "qualified" }, { productRecordId: "p1", decision: "qualified" }], ["p1"]), "PRODUCT_DECISION_DUPLICATE");
  expectCode(() => normalizeProductDecisions([{ productRecordId: "p2", decision: "qualified" }], ["p1"]), "PRODUCT_DECISION_OUT_OF_SCOPE");
  expectCode(() => normalizeProductDecisions([{ productRecordId: "p1", decision: "unqualified", reason: "" }], ["p1"]), "PRODUCT_REASON_REQUIRED");
}

function testRectificationState() {
  const review = deriveProductReview(normalizeProductDecisions([
    { productRecordId: "p1", decision: "qualified" },
    { productRecordId: "p2", decision: "unqualified", reason: "需要重拍" },
  ], ["p1", "p2"]));
  const state = applyRejectedProductReview({
    current: { qualifiedProductIds: ["p0"], currentResultByProduct: { p1: { recordId: "r1", resultKey: "k1" } } },
    review,
    approval: { currentNodeRecordId: "node-1", resultRecordIds: [{ productRecordId: "p1", recordId: "r1" }, { productRecordId: "p2", recordId: "r2" }] },
    values: { p1: ["cloud://p1"], p2: ["cloud://p2-a", "cloud://p2-b"] },
    decidedAt: "2026-08-19T10:00:00.000Z",
  });
  assert.deepStrictEqual(state.qualifiedProductIds, ["p0", "p1"]);
  assert.deepStrictEqual(state.rejectedProducts.p2, {
    reason: "需要重拍", resultRecordId: "r2", rejectedAt: "2026-08-19T10:00:00.000Z", rejectedNodeRecordId: "node-1", previousFileIds: ["cloud://p2-a", "cloud://p2-b"],
  });
  assert.deepStrictEqual(state.pendingDeleteFileIds, ["cloud://p2-a", "cloud://p2-b"]);
  assert.deepStrictEqual(normalizeSamplingReview(state).currentResultByProduct.p1, { recordId: "r1", resultKey: "k1" });
}

function testRejectedEvidenceDoesNotKeepOldPhotos() {
  const evidence = scrubRejectedEvidence([{ products: [
    { productRecordId: "p1", images: [{ image_url: "qualified" }] },
    { productRecordId: "p2", images: [{ image_url: "old-rejected" }] },
  ] }], { unqualified: [{ productRecordId: "p2", reason: "重拍" }] });
  assert.strictEqual(evidence[0].products[0].images.length, 1);
  assert.deepStrictEqual(evidence[0].products[1].images, []);
  assert.strictEqual(evidence[0].products[1].rejectionReason, "重拍");
}

Promise.resolve()
  .then(testDecisionValidationAndOutcome)
  .then(testValidationFailures)
  .then(testRectificationState)
  .then(testRejectedEvidenceDoesNotKeepOldPhotos)
  .then(() => process.stdout.write("product review tests passed\n"))
  .catch((error) => { console.error(error); process.exitCode = 1; });
