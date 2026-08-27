const assert = require("assert");
const { loadSamplingResultContract, samplingResultKey, desiredSamplingResults, writeSamplingResults, updateSamplingResultApprovalStatus, updateSamplingProductDecisions } = require("../sampling-writeback");

const field = (title, type, id, property = {}) => ({ field_title: title, field_type: type, field_id: id, ...property });
const select = (values) => ({ property_single_select: { is_quick_add: false, options: values.map((text) => ({ text })) } });
const reference = (subId) => ({ property_reference: { sub_id: subId, field_id: "" } });
const sheets = () => [
  { title: "16_任务项执行", sheet_id: "s16" },
  { title: "21_产品主档", sheet_id: "s21" },
  { title: "22_产品规则", sheet_id: "s22" },
  { title: "23_上样规则明细", sheet_id: "s23" },
  { title: "24_产品上样结果", sheet_id: "s24" },
];
const fields = () => [
  field("任务项执行", "FIELD_TYPE_REFERENCE", "f-item", reference("s16")),
  field("上样规则", "FIELD_TYPE_REFERENCE", "f-rule", reference("s22")),
  field("规则分组", "FIELD_TYPE_REFERENCE", "f-group", reference("s23")),
  field("上样产品", "FIELD_TYPE_REFERENCE", "f-product", reference("s21")),
  field("上样图片", "FIELD_TYPE_IMAGE", "f-images"),
  field("上样状态", "FIELD_TYPE_SINGLE_SELECT", "f-sampling", select(["已上样", "未上样"])),
  field("保存状态", "FIELD_TYPE_SINGLE_SELECT", "f-save", select(["已提交"])),
  field("提交轮次", "FIELD_TYPE_NUMBER", "f-round"),
  field("审批状态", "FIELD_TYPE_SINGLE_SELECT", "f-approval", select(["待审批", "无需审批", "已通过", "已退回"])),
  field("不合格原因", "FIELD_TYPE_TEXT", "f-reason"),
  field("结果唯一键", "FIELD_TYPE_TEXT", "f-key"),
];
const snapshot = (count = 3) => ({
  groups: [{ ruleRecordId: "rule-1", name: "必上", minRequired: count, products: Array.from({ length: count }, (_, index) => ({ productRecordId: `product-${index + 1}`, name: `产品${index + 1}`, minPhotos: 1 })) }],
});
const v2Snapshot = () => ({
  schemaVersion: 2,
  productRule: { ruleRecordId: "product-rule-1", ruleCode: "RULE-001", ruleName: "夏季规则" },
  groups: [{ groupRecordId: "group-1", groupCode: "GROUP-001", displayName: "必上 / 系列一", minRequired: 1, products: [{ productRecordId: "product-1", name: "产品1", minPhotos: 1, maxPhotos: null }] }],
});
const values = (count = 3) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`product-${index + 1}`, [`cloud://photo-${index + 1}`]]));
const imageCache = (count = 3) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`cloud://photo-${index + 1}`, { image_url: `https://doc/${index + 1}`, id: `img-${index + 1}` }]));

function client({ existing = [], failBatch = -1, loseReply = false } = {}) {
  let rows = existing.slice();
  let batch = 0;
  const calls = [];
  const mock = {
    configured: true,
    calls,
    readCount: 0,
    getSheets: async () => sheets(),
    getFields: async (sheetId) => sheetId === "s24" ? fields() : [field("主字段", "FIELD_TYPE_TEXT", `${sheetId}-primary`)],
    getRecords: async () => {
      mock.readCount += 1;
      return rows.map((row) => ({ record_id: row.record_id, values: { "结果唯一键": [{ type: "text", text: row.key }] } }));
    },
    addRecords: async (sheetId, records, options) => {
      calls.push({ sheetId, records, options });
      const current = batch++;
      if (current === failBatch && !loseReply) throw new Error("模拟批次失败");
      for (const record of records) rows.push({ record_id: `row-${rows.length + 1}`, key: record.values["f-key"][0].text });
      if (current === failBatch && loseReply) throw new Error("模拟响应丢失");
      return { records: records.map((_, index) => ({ record_id: `created-${index}` })) };
    },
    updateRecordsBatched: async (sheetId, records, options) => { calls.push({ sheetId, records, options, update: true }); return { batches: [{ size: records.length }] }; },
  };
  return mock;
}

async function testContractAndDesiredRows() {
  const contract = await loadSamplingResultContract(client());
  assert.strictEqual(contract.sheetId, "s24");
  const desired = desiredSamplingResults({ snapshot: snapshot(2), values: { "product-1": ["cloud://photo-1"], "product-2": [] }, imageCache: imageCache(1), itemExecutionRecordId: "item-exec", round: 1, requiresApproval: true });
  assert.strictEqual(desired.length, 1);
  assert.strictEqual(desired[0].samplingStatus, "已上样");
  assert.strictEqual(desired[0].resultKey, "RESULT:item-exec:1:product-1");
  assert.strictEqual(desired[0].approvalStatus, "待审批");
}

async function testFirstAndDuplicateSubmission() {
  const mock = client();
  const input = { client: mock, snapshot: snapshot(), values: values(), imageCache: imageCache(), itemExecutionRecordId: "item-exec", round: 1, requiresApproval: true };
  const first = await writeSamplingResults(input);
  const second = await writeSamplingResults(input);
  assert.deepStrictEqual({ created: first.createdCount, reused: first.reusedCount }, { created: 3, reused: 0 });
  assert.deepStrictEqual({ created: second.createdCount, reused: second.reusedCount }, { created: 0, reused: 3 });
  assert.strictEqual(mock.calls.length, 1);
  assert.strictEqual(mock.readCount, 2, "正常新增应直接使用返回记录ID，每次提交只做一次提交前对账");
  assert.strictEqual(mock.calls[0].options.keyType, "CELL_VALUE_KEY_TYPE_FIELD_ID");
  assert.strictEqual(mock.calls[0].records[0].values["f-round"], 1);
}

async function testV2WritesProductRuleAndRuleGroupSeparately() {
  const mock = client();
  const desired = desiredSamplingResults({ snapshot: v2Snapshot(), values: { "product-1": ["cloud://photo-1"] }, imageCache: imageCache(1), itemExecutionRecordId: "item-exec", round: 1, requiresApproval: true });
  assert.strictEqual(desired[0].ruleRecordId, "product-rule-1");
  assert.strictEqual(desired[0].groupRecordId, "group-1");
  await writeSamplingResults({ client: mock, snapshot: v2Snapshot(), values: { "product-1": ["cloud://photo-1"] }, imageCache: imageCache(1), itemExecutionRecordId: "item-exec", round: 1, requiresApproval: true });
  assert.deepStrictEqual(mock.calls[0].records[0].values["f-rule"], ["product-rule-1"]);
  assert.deepStrictEqual(mock.calls[0].records[0].values["f-group"], ["group-1"]);
}

async function testLegacyNestedImageCacheCanStillBeSubmitted() {
  const fileId = "cloud://cloudbase-env.bucket/sampling/task/product/photo.jpg";
  const legacyCache = {
    "cloud://cloudbase-env": {
      "bucket/sampling/task/product/photo": {
        jpg: { id: "legacy-image", image_url: "https://doc/legacy" },
      },
    },
  };
  const desired = desiredSamplingResults({
    snapshot: snapshot(1),
    values: { "product-1": [fileId] },
    imageCache: legacyCache,
    itemExecutionRecordId: "item-exec",
    round: 1,
    requiresApproval: true,
  });
  assert.strictEqual(desired[0].images[0].id, "legacy-image");
}

async function testBatchesAndLostReplyRecovery() {
  const mock = client({ failBatch: 0, loseReply: true });
  const result = await writeSamplingResults({ client: mock, snapshot: snapshot(501), values: values(501), imageCache: imageCache(501), itemExecutionRecordId: "item-exec", round: 1, requiresApproval: false });
  assert.deepStrictEqual(mock.calls.map((call) => call.records.length), [500, 1]);
  assert.strictEqual(result.resultCount, 501);
  assert.strictEqual(result.createdCount, 501);
}

async function testFailedBatchStopsAndNewRoundDoesNotOverwrite() {
  const mock = client({ failBatch: 1 });
  await assert.rejects(
    () => writeSamplingResults({ client: mock, snapshot: snapshot(501), values: values(501), imageCache: imageCache(501), itemExecutionRecordId: "item-exec", round: 1, requiresApproval: true }),
    /模拟批次失败/,
  );
  assert.strictEqual(mock.calls.length, 2);
  assert.notStrictEqual(samplingResultKey("item-exec", 1, "product-1"), samplingResultKey("item-exec", 2, "product-1"));
}

async function testDuplicateKeyAndRelationErrors() {
  const duplicate = client({ existing: [{ record_id: "a", key: "RESULT:item-exec:1:product-1" }, { record_id: "b", key: "RESULT:item-exec:1:product-1" }] });
  await assert.rejects(
    () => writeSamplingResults({ client: duplicate, snapshot: snapshot(1), values: values(1), imageCache: imageCache(1), itemExecutionRecordId: "item-exec", round: 1, requiresApproval: true }),
    (error) => error.code === "SAMPLING_RESULT_KEY_CONFLICT",
  );
  const wrong = client();
  wrong.getFields = async (sheetId) => sheetId === "s24" ? fields().map((entry) => entry.field_title === "上样产品" ? { ...entry, property_reference: { sub_id: "wrong" } } : entry) : [field("主字段", "FIELD_TYPE_TEXT", `${sheetId}-primary`)];
  await assert.rejects(() => loadSamplingResultContract(wrong), (error) => error.code === "SAMPLING_RESULT_RELATION_MISMATCH");
}

async function testApprovalSubmissionRequiresReasonField() {
  const mock = client();
  mock.getFields = async (sheetId) => sheetId === "s24" ? fields().filter((entry) => entry.field_title !== "不合格原因") : [field("主字段", "FIELD_TYPE_TEXT", `${sheetId}-primary`)];
  await assert.rejects(
    () => writeSamplingResults({ client: mock, snapshot: snapshot(1), values: values(1), imageCache: imageCache(1), itemExecutionRecordId: "item-exec", round: 1, requiresApproval: true }),
    (error) => error.code === "SAMPLING_RESULT_FIELD_MISSING" && error.details.fieldTitle === "不合格原因",
  );
}

async function testApprovalStatusUpdate() {
  const mock = client();
  const result = await updateSamplingResultApprovalStatus({ client: mock, resultRecordIds: [{ recordId: "r1" }, { recordId: "r2" }], approvalStatus: "已通过" });
  assert.strictEqual(result.updatedCount, 2);
  assert.deepStrictEqual(mock.calls[0].records[0], { record_id: "r1", values: { "f-approval": [{ text: "已通过" }] } });
}

async function testRectificationUpdatesExistingResultAndSkipsQualified() {
  const mock = client({ existing: [{ record_id: "old-2", key: "RESULT:item-exec:1:product-2" }] });
  const result = await writeSamplingResults({
    client: mock,
    snapshot: snapshot(3),
    values: { "product-1": ["cloud://photo-1"], "product-2": ["cloud://photo-2"], "product-3": ["cloud://photo-3"] },
    imageCache: imageCache(3),
    itemExecutionRecordId: "item-exec",
    round: 2,
    requiresApproval: true,
    samplingReview: {
      qualifiedProductIds: ["product-1"],
      rejectedProducts: { "product-2": { reason: "重拍", previousFileIds: ["cloud://old"] } },
      currentResultByProduct: { "product-2": { recordId: "old-2", resultKey: "RESULT:item-exec:1:product-2" } },
    },
  });
  assert.deepStrictEqual({ created: result.createdCount, updated: result.updatedCount, total: result.resultCount }, { created: 1, updated: 1, total: 2 });
  const update = mock.calls.find((call) => call.update);
  assert.strictEqual(update.records[0].record_id, "old-2");
  assert.strictEqual(update.records[0].values["f-round"], 2);
  assert.strictEqual(update.records[0].values["f-reason"][0].text, "");
}

async function testPerProductDecisionWriteback() {
  const mock = client();
  const result = await updateSamplingProductDecisions({
    client: mock,
    resultRecordIds: [{ productRecordId: "product-1", recordId: "r1" }, { productRecordId: "product-2", recordId: "r2" }],
    productDecisions: [{ productRecordId: "product-1", decision: "qualified", reason: "" }, { productRecordId: "product-2", decision: "unqualified", reason: "照片模糊" }],
  });
  assert.strictEqual(result.updatedCount, 2);
  assert.deepStrictEqual(mock.calls[0].records[0].values["f-approval"], [{ text: "已通过" }]);
  assert.strictEqual(mock.calls[0].records[1].values["f-reason"][0].text, "照片模糊");
}

async function main() {
  await testContractAndDesiredRows();
  await testFirstAndDuplicateSubmission();
  await testV2WritesProductRuleAndRuleGroupSeparately();
  await testLegacyNestedImageCacheCanStillBeSubmitted();
  await testBatchesAndLostReplyRecovery();
  await testFailedBatchStopsAndNewRoundDoesNotOverwrite();
  await testDuplicateKeyAndRelationErrors();
  await testApprovalSubmissionRequiresReasonField();
  await testApprovalStatusUpdate();
  await testRectificationUpdatesExistingResultAndSkipsQualified();
  await testPerProductDecisionWriteback();
  process.stdout.write("sampling writeback tests passed\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
