const assert = require("assert");
const { SUBMISSION_PHASES, approvalId, buildApprovalRecord, runSubmissionOrchestrator } = require("../submission-orchestrator");

async function testPhasesAndResume() {
  const visited = [];
  const hooks = Object.fromEntries(SUBMISSION_PHASES.slice(1, -1).map((phase) => [phase, async () => { visited.push(phase); return { [phase]: true }; }]));
  const advanced = [];
  const timings = [];
  const result = await runSubmissionOrchestrator({ startPhase: "images_ready", hooks, advance: async (phase) => advanced.push(phase), onPhaseComplete: (entry) => timings.push(entry) });
  assert.deepStrictEqual(visited, ["results_ready", "approval_ready", "audit_ready", "item_state_ready", "parent_state_ready"]);
  assert.deepStrictEqual(advanced, visited);
  assert.deepStrictEqual(timings.map((entry) => entry.phase), visited);
  assert.ok(timings.every((entry) => entry.ok === true && entry.durationMs >= 0));
  assert.strictEqual(result.results_ready, true);
}

function testApprovalRecord() {
  const item = {
    id: "item-1", name: "产品上样", renderer: "sampling", smartSheetItemExecutionRecordId: "exec-item-1",
    samplingSnapshot: { groups: [{ ruleRecordId: "rule-1", name: "必上", minRequired: 1, products: [{ productRecordId: "product-1", code: "DP1", name: "产品1", specification: "600x1200" }] }] },
  };
  const record = buildApprovalRecord({
    task: { id: "task-1", name: "门店任务", taskType: "STORE", taskTypeName: "门店任务", storeRecordId: "store-1", storeName: "门店1" }, item,
    draft: { values: { "product-1": ["cloud://p1"] }, smartSheetImageCache: { "cloud://p1": { image_url: "https://doc/p1" } } },
    account: { wecomUserId: "SalesA", name: "业务员甲" }, round: 1, resultRecordIds: [{ productRecordId: "product-1", recordId: "result-1", resultKey: "key-1" }],
    route: { templateRecordId: "template-1", templateName: "产品审批", nodeIndex: 0, nodeRecordId: "node-1", nodeName: "产品经理审批", nodeDuty: "产品经理", routeRecordId: "route-1", regionRecordId: "region-1", regionCode: "SOUTH", regionName: "华南", resolvedAt: "2026-08-12T00:00:00.000Z", reviewerRecordId: "person-1", userId: "ManagerA", name: "经理甲" },
  });
  assert.strictEqual(record.currentReviewerUserId, "ManagerA");
  assert.deepStrictEqual({ taskType: record.taskType, taskTypeName: record.taskTypeName }, { taskType: "STORE", taskTypeName: "门店任务" });
  assert.strictEqual(record.evidenceGroups[0].products[0].images[0].image_url, "https://doc/p1");
  assert.strictEqual(record.resultRecordIds[0].recordId, "result-1");
  assert.deepStrictEqual(record.reviewProductIds, ["product-1"]);
  assert.strictEqual(record.evidenceGroups[0].products[0].sourceKind, "current_new");
  assert.strictEqual(record.evidenceGroups[0].products[0].resultRecordId, "result-1");
  assert.strictEqual(record._id, approvalId("task-1", "item-1", 1));
}

function testApprovalEvidenceExcludesEmptyAndLocksHistoricalQualified() {
  const item = {
    id: "item-2", name: "产品上样", renderer: "sampling", smartSheetItemExecutionRecordId: "exec-item-2",
    samplingSnapshot: { groups: [{ ruleRecordId: "rule-1", name: "必上", minRequired: 1, products: [
      { productRecordId: "qualified", name: "已合格" }, { productRecordId: "rectify", name: "待整改" }, { productRecordId: "empty", name: "未上传" },
    ] }] },
  };
  const record = buildApprovalRecord({
    task: { id: "task-2", name: "任务", storeRecordId: "store-1", storeName: "门店1" }, item,
    draft: {
      values: { qualified: ["cloud://qualified"], rectify: ["cloud://rectify"], empty: [] },
      smartSheetImageCache: { "cloud://qualified": { image_url: "https://doc/qualified" }, "cloud://rectify": { image_url: "https://doc/rectify" } },
      samplingReview: { qualifiedProductIds: ["qualified"], rejectedProducts: { rectify: { reason: "重拍" } } },
    },
    account: { wecomUserId: "SalesA", name: "业务员甲" }, round: 2,
    resultRecordIds: [{ productRecordId: "rectify", recordId: "r2", resultKey: "k2" }],
    route: { templateRecordId: "t", templateName: "审批", nodeIndex: 0, nodeRecordId: "n", nodeName: "审批", nodeDuty: "产品经理", routeRecordId: "route", regionRecordId: "region", regionCode: "S", regionName: "华南", resolvedAt: "now", reviewerRecordId: "p", userId: "M", name: "经理" },
  });
  assert.deepStrictEqual(record.reviewProductIds, ["rectify"]);
  assert.deepStrictEqual(record.inheritedQualifiedProductIds, ["qualified"]);
  assert.strictEqual(record.evidenceGroups[0].products.length, 2);
}

async function main() {
  await testPhasesAndResume();
  testApprovalRecord();
  testApprovalEvidenceExcludesEmptyAndLocksHistoricalQualified();
  process.stdout.write("submission orchestrator tests passed\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
