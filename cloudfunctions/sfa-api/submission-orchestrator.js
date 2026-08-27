const crypto = require("crypto");
const { productsFromSnapshot, groupRecordId, groupName, imageFromCache } = require("./sampling-validation");
const { normalizeSamplingReview } = require("./product-review");

const SUBMISSION_PHASES = Object.freeze([
  "claimed",
  "reviewer_ready",
  "images_ready",
  "results_ready",
  "approval_ready",
  "audit_ready",
  "item_state_ready",
  "parent_state_ready",
  "completed",
]);

function orchestratorError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function approvalId(taskId, itemId, round) {
  const raw = `APPROVAL:${taskId}:${itemId}:${round}`;
  return `approval_${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 48)}`;
}

function samplingEvidence(snapshot, values, imageCache, samplingReview, resultRecordIds = []) {
  const review = normalizeSamplingReview(samplingReview);
  const qualified = new Set(review.qualifiedProductIds);
  const resultByProduct = new Map((resultRecordIds || []).filter((entry) => entry && typeof entry === "object").map((entry) => [String(entry.productRecordId || ""), entry]));
  const byProduct = new Map(productsFromSnapshot(snapshot).map(({ group, product }) => [product.productRecordId, { group, product }]));
  return (snapshot.groups || []).map((group) => ({
    productRuleRecordId: snapshot.productRule && snapshot.productRule.ruleRecordId || "",
    productRuleCode: snapshot.productRule && snapshot.productRule.ruleCode || "",
    productRuleName: snapshot.productRule && snapshot.productRule.ruleName || "",
    groupRecordId: groupRecordId(group),
    ruleRecordId: groupRecordId(group),
    ruleCode: group.groupCode || group.ruleCode,
    name: groupName(group),
    required: group.required !== false,
    minRequired: group.minRequired,
    products: (group.products || []).map((product) => {
      const fileIds = Array.isArray(values?.[product.productRecordId]) ? values[product.productRecordId] : [];
      if (!fileIds.length) return null;
      const isQualified = qualified.has(product.productRecordId);
      const rejected = review.rejectedProducts[product.productRecordId];
      const resultEntry = resultByProduct.get(product.productRecordId) || review.currentResultByProduct[product.productRecordId];
      return {
        productRecordId: product.productRecordId,
        code: product.code,
        name: product.name,
        specification: product.specification,
        selected: true,
        reviewRequired: !isQualified,
        sourceKind: isQualified ? "historical_qualified" : rejected ? "rectification" : "current_new",
        currentStatus: isQualified ? "qualified" : "pending",
        rejectionReason: rejected && rejected.reason || "",
        resultRecordId: resultEntry && resultEntry.recordId || "",
        resultKey: resultEntry && resultEntry.resultKey || "",
        images: fileIds.map((fileId) => imageFromCache(imageCache, fileId)).filter(Boolean),
      };
    }).filter(Boolean),
  })).filter((group) => group.products.some((product) => byProduct.has(product.productRecordId)));
}

function buildApprovalRecord({ task, item, draft, account, route, round, resultRecordIds = [], submittedAt = new Date().toISOString() }) {
  if (!route?.userId || !route?.nodeRecordId || !route?.regionRecordId) throw orchestratorError("APPROVAL_ROUTE_INVALID", `任务项“${item.name}”的审核路由不完整`);
  const id = approvalId(task.id, item.id, round);
  const evidenceGroups = item.renderer === "sampling" ? samplingEvidence(item.samplingSnapshot, draft.values, draft.smartSheetImageCache, draft.samplingReview, resultRecordIds) : [];
  const images = evidenceGroups.flatMap((group) => group.products.flatMap((product) => product.images || []));
  const reviewProductIds = evidenceGroups.flatMap((group) => group.products.filter((product) => product.reviewRequired).map((product) => product.productRecordId));
  if (item.renderer === "sampling" && !reviewProductIds.length) throw orchestratorError("APPROVAL_PRODUCT_SCOPE_EMPTY", "产品上样审批没有本轮待审核产品，请返回任务后重试");
  return {
    _id: id,
    id,
    taskId: task.id,
    taskName: task.name,
    itemId: item.id,
    itemName: item.name,
    itemExecutionRecordId: item.smartSheetItemExecutionRecordId,
    itemSubmissionRound: round,
    storeRecordId: task.storeRecordId,
    storeName: task.storeName,
    submitterName: account.name,
    submitterUserId: account.wecomUserId,
    submittedAt,
    status: "pending",
    statusLabel: "待审核",
    templateRecordId: route.templateRecordId,
    templateName: route.templateName,
    currentNodeIndex: route.nodeIndex,
    currentNodeRecordId: route.nodeRecordId,
    currentNodeName: route.nodeName,
    currentNodeDuty: route.nodeDuty,
    routeRecordId: route.routeRecordId,
    matchedRegionRecordId: route.regionRecordId,
    matchedRegionCode: route.regionCode,
    matchedRegionName: route.regionName,
    routeResolvedAt: route.resolvedAt,
    currentReviewerRecordId: route.reviewerRecordId,
    currentReviewerUserId: route.userId,
    currentReviewerName: route.name,
    resultRecordIds,
    reviewMode: item.renderer === "sampling" ? "product" : "item",
    reviewProductIds,
    inheritedQualifiedProductIds: evidenceGroups.flatMap((group) => group.products.filter((product) => !product.reviewRequired).map((product) => product.productRecordId)),
    evidenceGroups,
    images,
    history: [],
  };
}

async function runSubmissionOrchestrator({ startPhase = "claimed", advance, hooks, onPhaseComplete }) {
  const startIndex = SUBMISSION_PHASES.indexOf(startPhase);
  if (startIndex < 0) throw orchestratorError("SUBMISSION_PHASE_INVALID", `不支持的提交阶段：${startPhase}`);
  let context = {};
  for (let index = 1; index < SUBMISSION_PHASES.length - 1; index += 1) {
    const phase = SUBMISSION_PHASES[index];
    if (index <= startIndex) continue;
    const startedAt = Date.now();
    const hook = hooks[phase];
    try {
      if (typeof hook === "function") context = { ...context, ...(await hook(context) || {}) };
      await advance(phase, context);
      if (typeof onPhaseComplete === "function") onPhaseComplete({ phase, durationMs: Date.now() - startedAt, ok: true });
    } catch (error) {
      if (typeof onPhaseComplete === "function") onPhaseComplete({ phase, durationMs: Date.now() - startedAt, ok: false, code: error?.code || "ERROR" });
      throw error;
    }
  }
  return context;
}

module.exports = { SUBMISSION_PHASES, approvalId, samplingEvidence, buildApprovalRecord, runSubmissionOrchestrator, orchestratorError };
