const assert = require("assert");
const {
  loadItemExecutionContract,
  executionStatusLabel,
  itemExecutionIdentity,
  itemExecutionCreateValues,
  itemExecutionUpdateValues,
  applyItemExecutionLink,
  syncTaskItemExecutionRecord,
} = require("../item-execution-writeback");

const text = (value) => [{ type: "text", text: String(value) }];

function field(title, type, property = {}) {
  return { field_title: title, field_type: type, ...property };
}

function sheets() {
  return [
    { title: "05_任务项设置", sheet_id: "sheet-05" },
    { title: "06_任务执行", sheet_id: "sheet-06" },
    { title: "16_任务项执行", sheet_id: "sheet-16" },
  ];
}

function fields(overrides = {}) {
  const statusOptions = overrides.statusOptions || ["待执行", "进行中", "已完成", "待整改"];
  return [
    field("任务项执行编号", "FIELD_TYPE_TEXT"),
    field("所属执行记录", "FIELD_TYPE_REFERENCE", { property_reference: { sub_id: overrides.parentTarget || "sheet-06", field_id: overrides.parentTargetField ?? "", is_multiple: false } }),
    field("来源任务项", "FIELD_TYPE_REFERENCE", { property_reference: { sub_id: overrides.itemTarget || "sheet-05", field_id: overrides.itemTargetField ?? "", is_multiple: false } }),
    field("执行状态", "FIELD_TYPE_SINGLE_SELECT", { property_single_select: { is_quick_add: false, options: statusOptions.map((value) => ({ text: value })) } }),
    field("草稿内容", "FIELD_TYPE_TEXT"),
    field("结果表名称（自动）", "FIELD_TYPE_TEXT"),
    field("结果记录编号（自动）", "FIELD_TYPE_TEXT"),
    field("最后保存人", "FIELD_TYPE_USER"),
    field("最后保存时间", "FIELD_TYPE_DATE_TIME"),
    field("提交时间", "FIELD_TYPE_DATE_TIME"),
    field("审批状态", "FIELD_TYPE_SINGLE_SELECT", { property_single_select: { is_quick_add: false, options: ["无需审批", "待审批", "已通过", "已退回"].map((value) => ({ text: value })) } }),
    field("最新退回原因", "FIELD_TYPE_TEXT"),
    field("允许修改", "FIELD_TYPE_CHECKBOX"),
  ];
}

function client(tableFields = fields(), records = []) {
  return {
    configured: true,
    getSheets: async () => sheets(),
    getFields: async (sheetId) => {
      if (sheetId === "sheet-05") return [field("任务项名称", "FIELD_TYPE_TEXT", { field_id: "field-05-primary" })];
      if (sheetId === "sheet-06") return [field("执行记录编号", "FIELD_TYPE_TEXT", { field_id: "field-06-primary" })];
      return tableFields;
    },
    getRecords: async () => records,
  };
}

async function testContractVerifiesReferenceTargets() {
  const contract = await loadItemExecutionContract(client());
  assert.strictEqual(contract.sheetId, "sheet-16");
  assert.strictEqual(contract.executionSheetId, "sheet-06");
  assert.strictEqual(contract.taskItemSheetId, "sheet-05");
  assert.strictEqual(contract.parentTargetField, "", "企业微信关联主字段返回空field_id时仍应通过sub_id核验");
  assert.strictEqual(contract.itemTargetField, "", "企业微信关联主字段返回空field_id时仍应通过sub_id核验");
  assert.strictEqual(executionStatusLabel(contract, "active"), "进行中", "兼容当前线上选项“进行中”");
  assert.strictEqual(executionStatusLabel(contract, "review"), "已完成", "旧表缺少待复核时由审批状态单独表达");

  await assert.rejects(
    () => loadItemExecutionContract(client(fields({ parentTarget: "wrong-sheet" }))),
    (error) => error.code === "ITEM_EXECUTION_RELATION_MISMATCH",
  );
  await assert.rejects(
    () => loadItemExecutionContract(client(fields({ parentTargetField: "unknown-field" }))),
    (error) => error.code === "ITEM_EXECUTION_RELATION_MISMATCH",
  );
  const explicitPrimaryFields = fields({ parentTargetField: "field-06-primary", itemTargetField: "field-05-primary" });
  const explicitContract = await loadItemExecutionContract(client(explicitPrimaryFields));
  assert.strictEqual(explicitContract.parentTargetField, "field-06-primary");
  assert.strictEqual(explicitContract.itemTargetField, "field-05-primary");
  const withoutProperties = fields().map((entry) => entry.field_type === "FIELD_TYPE_REFERENCE" ? { field_title: entry.field_title, field_type: entry.field_type } : entry);
  await assert.rejects(
    () => loadItemExecutionContract(client(withoutProperties)),
    (error) => error.code === "ITEM_EXECUTION_RELATION_UNVERIFIED",
  );
}

async function testCreateAndUpdatePayloads() {
  const contract = await loadItemExecutionContract(client());
  const created = itemExecutionCreateValues({
    key: "execution-a:item-a",
    parentExecutionRecordId: "execution-a",
    taskItemRecordId: "item-a",
    status: "pending",
    resultSheetTitle: "12_物料打卡结果",
    requiresApproval: false,
  }, contract);
  assert.deepStrictEqual(created.values["所属执行记录"], ["execution-a"]);
  assert.deepStrictEqual(created.values["来源任务项"], ["item-a"]);
  assert.deepStrictEqual(created.values["执行状态"], [{ text: "待执行" }]);
  assert.deepStrictEqual(created.values["审批状态"], [{ text: "无需审批" }]);
  assert(/^ZXITEM-[A-F0-9]{20}$/.test(created.values["任务项执行编号"][0].text));

  const updated = itemExecutionUpdateValues({
    contract,
    status: "rectify",
    approvalStatus: "rejected",
    latestRejectionReason: "照片不清晰",
    allowEdit: true,
    touchSavedBy: false,
  });
  assert.deepStrictEqual(updated["执行状态"], [{ text: "待整改" }]);
  assert.deepStrictEqual(updated["审批状态"], [{ text: "已退回" }]);
  assert.deepStrictEqual(updated["最新退回原因"], text("照片不清晰"));
  assert.strictEqual(updated["允许修改"], true);
  assert.strictEqual(updated["最后保存人"], undefined, "审核动作不能覆盖业务员最后保存人");
}

async function testSyncReusesExistingPairAndWritesLifecycle() {
  const records = [{ record_id: "item-execution-a", values: { "所属执行记录": ["execution-a"], "来源任务项": ["item-a"] } }];
  const updates = [];
  const mock = {
    ...client(fields(), records),
    addRecords: async () => { throw new Error("不应重复新增"); },
    updateRecords: async (sheetId, rows) => { updates.push({ sheetId, rows }); return { errcode: 0 }; },
  };
  const item = { id: "item-a", configItemId: "item-a", requiresApproval: true, schemaSnapshot: { resultSheetTitle: "12_物料打卡结果" } };
  const result = await syncTaskItemExecutionRecord({
    client: mock,
    task: { smartSheetExecutionRecordId: "execution-a" },
    item,
    draft: { values: { 单页: ["cloud://photo"] } },
    account: { wecomUserId: "SalesA" },
    status: "review",
    submittedAt: "2026-08-12T12:00:00.000Z",
    approvalStatus: "pending",
    allowEdit: false,
    resultRecordId: "result-a",
    resultSheetTitle: "12_物料打卡结果",
  });
  assert.strictEqual(result.recordId, "item-execution-a");
  assert.strictEqual(item.smartSheetItemExecutionRecordId, "item-execution-a");
  assert.deepStrictEqual(updates[0].rows[0].values["执行状态"], [{ text: "已完成" }]);
  assert.deepStrictEqual(updates[0].rows[0].values["审批状态"], [{ text: "待审批" }]);
  assert.deepStrictEqual(updates[0].rows[0].values["结果记录编号（自动）"], text("result-a"));
  assert.deepStrictEqual(itemExecutionIdentity(records[0]), { parentExecutionRecordId: "execution-a", taskItemRecordId: "item-a" });
}

async function testLifecycleLinkTransitionsAreIsolated() {
  const task = {
    smartSheetExecutionRecordId: "execution-a",
    items: [
      { id: "item-a", configItemId: "item-a", status: "pending" },
      { id: "item-b", configItemId: "item-b", status: "completed", smartSheetItemExecutionRecordId: "child-b" },
    ],
  };
  const item = task.items[0];
  const active = applyItemExecutionLink(task, item, { recordId: "child-a" }, "active");
  assert.strictEqual(active[0].status, "active");
  assert.strictEqual(active[0].smartSheetItemExecutionRecordId, "child-a");
  assert.strictEqual(active[1].status, "completed");
  task.items = active;
  assert.strictEqual(applyItemExecutionLink(task, active[0], { recordId: "child-a" }, "review")[0].status, "review");
  assert.strictEqual(applyItemExecutionLink(task, active[0], { recordId: "child-a" }, "rectify")[0].status, "rectify");
  assert.strictEqual(applyItemExecutionLink(task, active[0], { recordId: "child-a" }, "completed")[0].status, "completed");

  const legacyTask = { smartSheetExecutionRecordId: "execution-legacy", items: [{ id: "legacy-a" }, { id: "legacy-b" }] };
  const legacyLinked = applyItemExecutionLink(legacyTask, legacyTask.items[0], { recordId: "legacy-child-a" }, "active");
  assert.strictEqual(legacyLinked[0].smartSheetItemExecutionRecordId, "legacy-child-a");
  assert.strictEqual(legacyLinked[1].smartSheetItemExecutionRecordId, undefined, "缺少configItemId的旧任务不能误更新其他任务项");
}

async function main() {
  await testContractVerifiesReferenceTargets();
  await testCreateAndUpdatePayloads();
  await testSyncReusesExistingPairAndWritesLifecycle();
  await testLifecycleLinkTransitionsAreIsolated();
  process.stdout.write("item execution writeback tests passed\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
