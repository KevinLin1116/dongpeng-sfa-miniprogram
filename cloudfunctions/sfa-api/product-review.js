function productReviewError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function uniqueIds(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean)));
}

function normalizeSamplingReview(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const rejectedSource = source.rejectedProducts && typeof source.rejectedProducts === "object" && !Array.isArray(source.rejectedProducts)
    ? source.rejectedProducts
    : {};
  const currentResultSource = source.currentResultByProduct && typeof source.currentResultByProduct === "object" && !Array.isArray(source.currentResultByProduct)
    ? source.currentResultByProduct
    : {};
  const rejectedProducts = {};
  for (const [productRecordId, entry] of Object.entries(rejectedSource)) {
    const id = String(productRecordId || "").trim();
    if (!id) continue;
    const item = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
    rejectedProducts[id] = {
      reason: String(item.reason || "").trim(),
      resultRecordId: String(item.resultRecordId || "").trim(),
      rejectedAt: String(item.rejectedAt || "").trim(),
      rejectedNodeRecordId: String(item.rejectedNodeRecordId || "").trim(),
      previousFileIds: uniqueIds(item.previousFileIds),
    };
  }
  const currentResultByProduct = {};
  for (const [productRecordId, entry] of Object.entries(currentResultSource)) {
    const id = String(productRecordId || "").trim();
    if (!id) continue;
    const item = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
    const recordId = String(item.recordId || "").trim();
    if (!recordId) continue;
    currentResultByProduct[id] = { recordId, resultKey: String(item.resultKey || "").trim() };
  }
  return {
    qualifiedProductIds: uniqueIds(source.qualifiedProductIds),
    rejectedProducts,
    currentResultByProduct,
    pendingDeleteFileIds: uniqueIds(source.pendingDeleteFileIds),
    reviewVersion: 1,
  };
}

function normalizeProductDecisions(input, requiredProductIds) {
  const required = uniqueIds(requiredProductIds);
  if (!required.length) throw productReviewError("PRODUCT_REVIEW_SCOPE_EMPTY", "当前审批没有可审核的产品，请刷新后重试");
  if (!Array.isArray(input)) throw productReviewError("PRODUCT_DECISIONS_REQUIRED", "请逐一判断所有待审核产品");
  const requiredSet = new Set(required);
  const seen = new Set();
  const normalized = [];
  for (const raw of input) {
    const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const productRecordId = String(item.productRecordId || "").trim();
    if (!productRecordId) throw productReviewError("PRODUCT_DECISION_ID_REQUIRED", "审核结果中存在缺少产品标识的记录");
    if (seen.has(productRecordId)) throw productReviewError("PRODUCT_DECISION_DUPLICATE", "同一产品不能重复提交审核结果", { productRecordId });
    if (!requiredSet.has(productRecordId)) throw productReviewError("PRODUCT_DECISION_OUT_OF_SCOPE", "审核结果包含当前审批范围外的产品，请刷新后重试", { productRecordId });
    const decision = String(item.decision || "").trim();
    if (!["qualified", "unqualified"].includes(decision)) throw productReviewError("PRODUCT_DECISION_INVALID", "每个产品必须选择合格或不合格", { productRecordId });
    const reason = decision === "unqualified" ? String(item.reason || "").trim() : "";
    if (decision === "unqualified" && !reason) throw productReviewError("PRODUCT_REASON_REQUIRED", "每个不合格产品都必须填写不合格原因", { productRecordId });
    if (reason.length > 500) throw productReviewError("PRODUCT_REASON_TOO_LONG", "单个产品的不合格原因最多500字", { productRecordId, maximum: 500 });
    seen.add(productRecordId);
    normalized.push({ productRecordId, decision, reason });
  }
  const missing = required.filter((id) => !seen.has(id));
  if (missing.length) throw productReviewError("PRODUCT_DECISIONS_INCOMPLETE", `还有${missing.length}个产品未完成判断`, { productRecordIds: missing });
  return normalized.sort((left, right) => left.productRecordId.localeCompare(right.productRecordId));
}

function deriveProductReview(decisions) {
  const normalized = Array.isArray(decisions) ? decisions : [];
  const qualified = normalized.filter((item) => item.decision === "qualified");
  const unqualified = normalized.filter((item) => item.decision === "unqualified");
  return {
    decision: unqualified.length ? "rejected" : "approved",
    qualified,
    unqualified,
    summary: {
      pending: 0,
      decided: normalized.length,
      qualified: qualified.length,
      unqualified: unqualified.length,
    },
  };
}

function productLabels(evidenceGroups) {
  const labels = new Map();
  for (const group of Array.isArray(evidenceGroups) ? evidenceGroups : []) {
    for (const product of Array.isArray(group.products) ? group.products : []) {
      const id = String(product.productRecordId || "").trim();
      if (!id) continue;
      labels.set(id, [product.code, product.name].map((value) => String(value || "").trim()).filter(Boolean).join(" ") || id);
    }
  }
  return labels;
}

function formatProductReviewOpinion(review, evidenceGroups) {
  const labels = productLabels(evidenceGroups);
  const rejected = (review.unqualified || []).map((item) => `${labels.get(item.productRecordId) || item.productRecordId}—${item.reason}`);
  const prefix = `合格 ${review.qualified.length} 款；不合格 ${review.unqualified.length} 款`;
  return rejected.length ? `${prefix}：${rejected.join("；")}` : prefix;
}

function resultEntryMap(resultRecordIds) {
  const result = new Map();
  for (const raw of Array.isArray(resultRecordIds) ? resultRecordIds : []) {
    if (typeof raw === "string") continue;
    const productRecordId = String(raw && raw.productRecordId || "").trim();
    const recordId = String(raw && raw.recordId || "").trim();
    if (productRecordId && recordId) result.set(productRecordId, { recordId, resultKey: String(raw.resultKey || "").trim() });
  }
  return result;
}

function applyRejectedProductReview({ current, review, approval, values, decidedAt }) {
  const state = normalizeSamplingReview(current);
  const qualified = new Set(state.qualifiedProductIds);
  const results = resultEntryMap(approval && approval.resultRecordIds);
  const evidenceResultByProduct = new Map();
  for (const group of Array.isArray(approval && approval.evidenceGroups) ? approval.evidenceGroups : []) {
    for (const product of Array.isArray(group.products) ? group.products : []) {
      const productRecordId = String(product.productRecordId || "").trim();
      const resultRecordId = String(product.resultRecordId || "").trim();
      if (productRecordId && resultRecordId) evidenceResultByProduct.set(productRecordId, resultRecordId);
    }
  }
  for (const item of review.qualified) qualified.add(item.productRecordId);
  const rejectedProducts = {};
  for (const item of review.unqualified) {
    const mapped = results.get(item.productRecordId);
    rejectedProducts[item.productRecordId] = {
      reason: item.reason,
      resultRecordId: mapped && mapped.recordId || evidenceResultByProduct.get(item.productRecordId) || "",
      rejectedAt: decidedAt,
      rejectedNodeRecordId: String(approval && approval.currentNodeRecordId || ""),
      previousFileIds: uniqueIds(values && values[item.productRecordId]),
    };
  }
  return {
    ...state,
    qualifiedProductIds: Array.from(qualified).sort(),
    rejectedProducts,
    pendingDeleteFileIds: uniqueIds([...state.pendingDeleteFileIds, ...Object.values(rejectedProducts).flatMap((item) => item.previousFileIds)]),
  };
}

function scrubRejectedEvidence(evidenceGroups, review) {
  const rejected = new Map((review?.unqualified || []).map((item) => [item.productRecordId, item.reason]));
  return (Array.isArray(evidenceGroups) ? evidenceGroups : []).map((group) => ({
    ...group,
    products: (Array.isArray(group.products) ? group.products : []).map((product) => rejected.has(product.productRecordId)
      ? { ...product, images: [], currentStatus: "unqualified", rejectionReason: rejected.get(product.productRecordId) }
      : product),
  }));
}

module.exports = {
  productReviewError,
  uniqueIds,
  normalizeSamplingReview,
  normalizeProductDecisions,
  deriveProductReview,
  formatProductReviewOpinion,
  resultEntryMap,
  applyRejectedProductReview,
  scrubRejectedEvidence,
};
