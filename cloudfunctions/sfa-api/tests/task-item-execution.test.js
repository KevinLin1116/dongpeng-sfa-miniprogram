const assert = require("assert");
const {
  ITEM_EXECUTION_SHEET,
  MAX_BATCH_SIZE,
  ITEM_EXECUTION_STATUS_LABELS,
  normalizeItemExecutionStatus,
  itemExecutionStatusLabel,
  itemExecutionKey,
  buildDesiredTaskItemExecutions,
  existingExecutionIndex,
  planTaskItemExecutionBatches,
  ensureTaskItemExecutions,
} = require("../task-item-execution");

function item(id, order, overrides = {}) {
  return {
    configItemId: id,
    name: `任务项${id}`,
    order,
    required: true,
    status: "pending",
    schemaSnapshot: { resultSheetTitle: "12_物料打卡结果" },
    ...overrides,
  };
}

function parent(id, items) {
  return { smartSheetExecutionRecordId: id, items };
}

function smartSheetIdentity(record) {
  return {
    parentExecutionRecordId: record.values["执行记录"][0],
    taskItemRecordId: record.values["任务项"][0],
  };
}

function smartSheetRecord(record) {
  return {
    values: {
      "执行记录": [record.parentExecutionRecordId],
      "任务项": [record.taskItemRecordId],
      "当前状态": [{ text: record.statusLabel }],
      "是否必做": record.required,
      "展示顺序": record.order,
    },
  };
}

async function testStatusMapping() {
  assert.strictEqual(ITEM_EXECUTION_SHEET, "16_任务项执行");
  assert.strictEqual(MAX_BATCH_SIZE, 500);
  assert.deepStrictEqual(ITEM_EXECUTION_STATUS_LABELS, {
    pending: "待执行",
    active: "执行中",
    review: "待复核",
    rectify: "待整改",
    completed: "已完成",
  });
  assert.strictEqual(normalizeItemExecutionStatus("执行中"), "active");
  assert.strictEqual(normalizeItemExecutionStatus("进行中"), "active");
  assert.strictEqual(normalizeItemExecutionStatus("pending_review"), "review");
  assert.strictEqual(itemExecutionStatusLabel("done"), "已完成");
  await assert.rejects(async () => normalizeItemExecutionStatus("已取消"), (error) => error.code === "TASK_ITEM_EXECUTION_STATUS_INVALID");
}

async function testDesiredRecordsAreStableAndOrdered() {
  const desired = buildDesiredTaskItemExecutions([
    parent("execution-1", [
      item("item-2", 20, { status: "active", required: false }),
      item("item-1", 10, { requiresApproval: true, approvalTemplateIds: ["approval-1", "approval-1"] }),
    ]),
  ]);
  assert.deepStrictEqual(desired.map((record) => record.key), ["execution-1:item-1", "execution-1:item-2"]);
  assert.strictEqual(itemExecutionKey("execution-1", "item-1"), "execution-1:item-1");
  assert.strictEqual(desired[0].statusLabel, "待执行");
  assert.deepStrictEqual(desired[0].approvalTemplateRecordIds, ["approval-1"]);
  assert.strictEqual(desired[1].required, false);
  assert.strictEqual(desired[1].statusLabel, "执行中");
}

async function testIdempotentPlanSkipsExistingPair() {
  const existing = [{ record_id: "row-1", values: { "执行记录": ["execution-1"], "任务项": ["item-1"] } }];
  const plan = planTaskItemExecutionBatches({
    parentExecutions: [parent("execution-1", [item("item-1", 1), item("item-2", 2)])],
    existingRecords: existing,
    identityOfExisting: smartSheetIdentity,
    serializeRecord: smartSheetRecord,
  });
  assert.deepStrictEqual(plan.stats, { desired: 2, existing: 1, skipped: 1, toCreate: 1, batchCount: 1 });
  assert.deepStrictEqual(plan.toCreate.map((record) => record.key), ["execution-1:item-2"]);
  assert.deepStrictEqual(plan.batches[0][0].values["当前状态"], [{ text: "待执行" }]);
}

async function testDuplicateDesiredInputIsDeduplicated() {
  const plan = planTaskItemExecutionBatches({
    parentExecutions: [parent("execution-1", [item("item-1", 1), item("item-1", 1)])],
  });
  assert.strictEqual(plan.stats.desired, 1);
  assert.strictEqual(plan.stats.toCreate, 1);
}

async function testDuplicateExistingRowsStopPlanning() {
  const duplicateRows = [
    { record_id: "row-1", values: { "执行记录": ["execution-1"], "任务项": ["item-1"] } },
    { record_id: "row-2", values: { "执行记录": ["execution-1"], "任务项": ["item-1"] } },
  ];
  assert.throws(
    () => existingExecutionIndex(duplicateRows, smartSheetIdentity),
    (error) => error.code === "TASK_ITEM_EXECUTION_DUPLICATE_EXISTING" && /重复记录/.test(error.message),
  );
}

async function testBatchPlanningForOneHundredStores() {
  const parents = Array.from({ length: 100 }, (_, index) => parent(`execution-${index + 1}`, [
    item("item-1", 1),
    item("item-2", 2),
    item("item-3", 3),
  ]));
  const plan = planTaskItemExecutionBatches({ parentExecutions: parents, batchSize: 120 });
  assert.deepStrictEqual(plan.batches.map((batch) => batch.length), [120, 120, 60]);
  assert.deepStrictEqual(plan.stats, { desired: 300, existing: 0, skipped: 0, toCreate: 300, batchCount: 3 });
  assert.throws(
    () => planTaskItemExecutionBatches({ parentExecutions: parents, batchSize: 501 }),
    (error) => error.code === "TASK_ITEM_EXECUTION_BATCH_SIZE_INVALID",
  );
}

async function testInjectedOrchestratorIsIdempotentAcrossRuns() {
  const stored = [];
  const calls = [];
  const dependencies = {
    parentExecutions: [parent("execution-1", [item("item-1", 1), item("item-2", 2)])],
    loadExisting: async () => stored,
    identityOfExisting: smartSheetIdentity,
    serializeRecord: smartSheetRecord,
    batchSize: 1,
    addBatch: async (records, context) => {
      calls.push({ records, context });
      records.forEach((record, index) => stored.push({ record_id: `row-${stored.length + index + 1}`, ...record }));
      return { records: records.length };
    },
  };
  const first = await ensureTaskItemExecutions(dependencies);
  assert.strictEqual(first.stats.toCreate, 2);
  assert.strictEqual(first.responses.length, 2);
  assert.strictEqual(calls[0].context.sheetTitle, "16_任务项执行");
  assert.deepStrictEqual(calls.map((call) => call.context.batchIndex), [0, 1]);

  const second = await ensureTaskItemExecutions(dependencies);
  assert.deepStrictEqual(second.stats, { desired: 2, existing: 2, skipped: 2, toCreate: 0, batchCount: 0 });
  assert.strictEqual(calls.length, 2, "重复执行不应继续新增记录");
}

async function testValidation() {
  assert.throws(
    () => buildDesiredTaskItemExecutions([parent("", [item("item-1", 1)])]),
    (error) => error.code === "TASK_ITEM_EXECUTION_INVALID" && /父执行记录ID/.test(error.message),
  );
  assert.throws(
    () => buildDesiredTaskItemExecutions([parent("execution-1", [item("", 1)])]),
    (error) => error.code === "TASK_ITEM_EXECUTION_INVALID" && /任务项记录ID/.test(error.message),
  );
}

async function main() {
  await testStatusMapping();
  await testDesiredRecordsAreStableAndOrdered();
  await testIdempotentPlanSkipsExistingPair();
  await testDuplicateDesiredInputIsDeduplicated();
  await testDuplicateExistingRowsStopPlanning();
  await testBatchPlanningForOneHundredStores();
  await testInjectedOrchestratorIsIdempotentAcrossRuns();
  await testValidation();
  process.stdout.write("task item execution tests passed\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
