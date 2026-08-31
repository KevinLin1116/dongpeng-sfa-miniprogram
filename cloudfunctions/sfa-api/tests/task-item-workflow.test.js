const assert = require("assert");
const {
  buildPublicationPlan,
  executionRecordMap,
  executionRecordValues,
  isConfirmedPublication,
} = require("../task-publisher");
const { buildDesiredTaskItemExecutions } = require("../task-item-execution");
const { syncExecutionRecord, syncTaskItemResult } = require("../smart-sheet-writeback");

const text = (value) => [{ type: "text", text: String(value) }];
const select = (value) => [{ text: String(value) }];
const field = (title, type) => ({ field_title: title, field_type: type });

function publicationFixture() {
  return {
    record_id: "publication-1",
    values: {
      "任务名称": text("三店双任务项测试"),
      "任务类型": ["type-store"],
      "任务门店": ["store-a", "store-b", "store-c"],
      "执行人员": ["person-a"],
      "任务项": ["item-a", "item-b"],
      "开始时间": String(Date.parse("2026-08-12T09:00:00+08:00")),
      "截止时间": String(Date.parse("2026-08-13T18:00:00+08:00")),
      "确认发布": true,
      "发布状态": select("草稿"),
      "需要定位": false,
      "超范围处理": select("允许并提示"),
    },
  };
}

function store(recordId, code, name) {
  return { record_id: recordId, values: { "门店编码": text(code), "门店名称": text(name) } };
}

function samplingConfiguration() {
  return {
    rules: [{
      ruleRecordId: "rule-a", ruleCode: "RULE-001", ruleName: "夏季产品规则", groupRecordIds: ["group-a"], sourceUpdatedAt: "2026-08-12T00:00:00.000Z",
      groups: [{
        groupRecordId: "group-a", groupCode: "GROUP-001", level1Name: "必上", level2Name: "系列一", displayName: "必上 / 系列一", productRecordIds: ["product-a"], minRequired: 1,
        sourceUpdatedAt: "2026-08-12T00:00:00.000Z", products: [{ recordId: "product-a", code: "DP-A", name: "产品A", specification: "600×1200mm", order: 1 }],
      }],
    }],
  };
}

function approvalConfiguration() {
  return {
    templates: [{ recordId: "approval-template-1", code: "APPROVAL", name: "任务项审批" }],
    nodes: [{ recordId: "approval-node-1", templateRecordId: "approval-template-1", code: "REVIEW", name: "负责人审核", order: 1, duty: "固定人员" }],
  };
}

function buildPlan(executionRecords = []) {
  return buildPublicationPlan({
    publication: publicationFixture(),
    stores: [store("store-a", "A001", "甲店"), store("store-b", "B001", "乙店"), store("store-c", "C001", "丙店")],
    people: [{ record_id: "person-a", values: { "企业微信账号ID（自动）": text("SalesA"), "姓名（自动）": text("业务员甲") } }],
    taskTypes: [{ id: "type-store", code: "STORE", name: "门店任务" }],
    schemas: [
      { itemId: "item-a", itemName: "无审批任务项", status: "ready", required: true, order: 1, resultSheetTitle: "12_物料打卡结果", resultRelationField: "任务项执行", requiresApproval: false, fields: [] },
      { itemId: "item-b", itemName: "需审批任务项", status: "ready", required: true, order: 2, resultSheetTitle: "12_物料打卡结果", resultRelationField: "任务项执行", requiresApproval: true, approvalTemplateIds: ["approval-template-1"], fields: [] },
    ],
    executionRecords,
    approvalConfiguration: approvalConfiguration(),
  });
}

async function testPublisherPlanFeedsExactNByMChildPlan() {
  assert.strictEqual(isConfirmedPublication(publicationFixture()), true);
  const notConfirmed = publicationFixture();
  notConfirmed.values["确认发布"] = false;
  notConfirmed.values["发布状态"] = select("已发布");
  assert.strictEqual(isConfirmedPublication(notConfirmed), false, "发布状态不能替代人工确认");
  const confirmedWithSystemFailure = publicationFixture();
  confirmedWithSystemFailure.values["发布状态"] = select("发布失败");
  assert.strictEqual(isConfirmedPublication(confirmedWithSystemFailure), true, "确认发布后应允许修正内容并再次触发校验");
  const plan = buildPlan();
  assert.strictEqual(plan.instances.length, 3, "三个门店应产生三个06父执行计划");
  assert(plan.instances.every((instance) => instance.items.length === 2), "每个06计划都应冻结两个任务项");
  assert.notStrictEqual(plan.instances[0].items, plan.instances[1].items, "不同门店必须拥有独立的任务项数组");
  plan.instances[0].items[0].smartSheetItemExecutionRecordId = "child-of-store-a";
  assert.strictEqual(plan.instances[1].items[0].smartSheetItemExecutionRecordId, "", "回填某门店的16记录ID不能污染其他门店");

  plan.instances.forEach((instance, index) => {
    instance.smartSheetExecutionRecordId = `execution-${index + 1}`;
  });
  const children = buildDesiredTaskItemExecutions(plan.instances);
  assert.strictEqual(children.length, 6, "三个执行对象乘两个任务项应得到六条16计划");
  assert.strictEqual(new Set(children.map((child) => child.key)).size, 6, "16唯一键不得碰撞");
  assert.deepStrictEqual(children.slice(0, 2).map((child) => ({
    taskItemRecordId: child.taskItemRecordId,
    status: child.status,
    requiresApproval: child.requiresApproval,
  })), [
    { taskItemRecordId: "item-a", status: "pending", requiresApproval: false },
    { taskItemRecordId: "item-b", status: "pending", requiresApproval: true },
  ]);
}

async function testSamplingSnapshotIsFrozenPerStore() {
  const publication = publicationFixture();
  publication.values["任务门店"] = ["store-a"];
  publication.values["任务项"] = ["item-sampling"];
  publication.values["产品规则"] = ["rule-a"];
  const plan = buildPublicationPlan({
    publication,
    stores: [{ ...store("store-a", "A001", "甲店"), values: { ...store("store-a", "A001", "甲店").values, "所属大区": ["region-south"] } }],
    people: [{ record_id: "person-a", values: { "企业微信账号ID（自动）": text("SalesA"), "姓名（自动）": text("业务员甲") } }],
    taskTypes: [{ id: "type-store", code: "STORE", name: "门店任务" }],
    schemas: [{ itemId: "item-sampling", itemName: "产品上样", renderer: "产品上样", status: "ready", required: true, order: 1, requiresApproval: true, approvalTemplateIds: ["approval-template-1"] }],
    samplingConfiguration: samplingConfiguration(),
    approvalConfiguration: approvalConfiguration(),
  });
  const item = plan.instances[0].items[0];
  assert.strictEqual(item.renderer, "sampling");
  assert.strictEqual(item.samplingSnapshot.productRule.ruleRecordId, "rule-a");
  assert.strictEqual(item.samplingSnapshot.businessRegionSnapshot.regionRecordId, "region-south");
  assert.strictEqual(item.samplingSnapshot.groups[0].products[0].productRecordId, "product-a");
  assert.strictEqual(item.samplingSnapshot.version.length, 64);
  assert.strictEqual(item.approvalStructureSnapshot.nodes[0].nodeRecordId, "approval-node-1");
}

async function testSamplingPublicationRequiresExactlyOneProductRule() {
  const publication = publicationFixture();
  publication.values["任务门店"] = ["store-a"];
  publication.values["任务项"] = ["item-sampling"];
  const input = {
    publication,
    stores: [{ ...store("store-a", "A001", "甲店"), values: { ...store("store-a", "A001", "甲店").values, "所属大区": ["region-south"] } }],
    people: [{ record_id: "person-a", values: { "企业微信账号ID（自动）": text("SalesA"), "姓名（自动）": text("业务员甲") } }],
    taskTypes: [{ id: "type-store", code: "STORE", name: "门店任务" }],
    schemas: [{ itemId: "item-sampling", itemName: "产品上样", renderer: "产品上样", status: "ready", required: true, order: 1, requiresApproval: false }],
    samplingConfiguration: samplingConfiguration(),
  };
  assert.throws(() => buildPublicationPlan(input), (error) => error.code === "PUBLISH_VALIDATION_FAILED" && /必须且只能选择一个产品规则/.test(error.message));
  publication.values["产品规则"] = ["rule-a", "rule-b"];
  assert.throws(() => buildPublicationPlan(input), (error) => error.code === "PUBLISH_VALIDATION_FAILED" && /必须且只能选择一个产品规则/.test(error.message));
}

async function testSamplingRuleIsFrozenForEverySelectedStore() {
  const publication = publicationFixture();
  publication.values["任务门店"] = ["store-a", "store-b"];
  publication.values["任务项"] = ["item-sampling"];
  publication.values["产品规则"] = ["rule-a"];
  const stores = [store("store-a", "A001", "甲店"), store("store-b", "B001", "乙店")].map((entry, index) => ({ ...entry, values: { ...entry.values, "所属大区": [`region-${index + 1}`] } }));
  const plan = buildPublicationPlan({
    publication,
    stores,
    people: [{ record_id: "person-a", values: { "企业微信账号ID（自动）": text("SalesA"), "姓名（自动）": text("业务员甲") } }],
    taskTypes: [{ id: "type-store", code: "STORE", name: "门店任务" }],
    schemas: [{ itemId: "item-sampling", itemName: "产品上样", renderer: "产品上样", status: "ready", required: true, order: 1, requiresApproval: false }],
    samplingConfiguration: samplingConfiguration(),
  });
  assert.strictEqual(plan.instances.length, 2);
  assert(plan.instances.every((instance) => instance.items[0].samplingSnapshot.productRule.ruleRecordId === "rule-a"));
  assert.deepStrictEqual(plan.instances.map((instance) => instance.items[0].samplingSnapshot.businessRegionSnapshot.regionRecordId), ["region-1", "region-2"]);
}

async function testExisting06RecordIsReusedWithoutChangingItsContract() {
  const executionRecords = [{ record_id: "execution-a", values: { "来源任务": ["publication-1"], "执行门店": ["store-a"] } }];
  assert.strictEqual(executionRecordMap(executionRecords).get("publication-1:store-a"), "execution-a");

  const plan = buildPlan(executionRecords);
  assert.strictEqual(plan.instances[0].smartSheetExecutionRecordId, "execution-a");
  assert.strictEqual(plan.instances[1].smartSheetExecutionRecordId, "");

  const values = executionRecordValues(plan.instances[0]);
  assert.deepStrictEqual(Object.keys(values), ["执行记录编号", "来源任务", "执行门店", "执行人员", "开始时间", "截止时间", "当前状态"]);
  assert.strictEqual(values["任务类型"], undefined, "任务类型是引用字段，应由来源任务自动带出");
  assert.strictEqual(plan.instances[0].taskTypeRecordId, "type-store", "内部快照仍应保留任务类型记录ID");
  assert.deepStrictEqual(values["当前状态"], select("待执行"));
  assert.strictEqual(values["任务项执行"], undefined, "新增16不能改变06新增记录的既有字段契约");
}

async function testDuplicate06CombinationFailsClosed() {
  assert.throws(
    () => executionRecordMap([
      { record_id: "execution-a", values: { "来源任务": ["publication-1"], "执行门店": ["store-a"] } },
      { record_id: "execution-b", values: { "来源任务": ["publication-1"], "执行门店": ["store-a"] } },
    ]),
    (error) => error.code === "EXECUTION_RECORD_DUPLICATE_EXISTING",
  );
}

async function test06StatusWritebackRemainsBackwardCompatible() {
  const updates = [];
  const client = {
    configured: true,
    getSheets: async () => [{ title: "06_任务执行", sheet_id: "execution-sheet" }],
    getFields: async () => [
      field("当前状态", "FIELD_TYPE_SINGLE_SELECT"), field("已完成项数", "FIELD_TYPE_NUMBER"),
      field("必做项总数", "FIELD_TYPE_NUMBER"), field("最后保存人", "FIELD_TYPE_USER"),
      field("最后保存时间", "FIELD_TYPE_DATE_TIME"), field("提交人", "FIELD_TYPE_USER"),
      field("提交时间", "FIELD_TYPE_DATE_TIME"), field("审核状态", "FIELD_TYPE_SINGLE_SELECT"),
    ],
    updateRecords: async (sheetId, records) => { updates.push({ sheetId, records }); return { errcode: 0 }; },
  };
  const task = { smartSheetExecutionRecordId: "execution-a", executorSnapshot: [] };
  const account = { wecomUserId: "SalesA", name: "业务员甲" };
  const transitions = [
    ["active", "执行中", "待提交"], ["review", "待复核", "待审核"],
    ["rectify", "待整改", "已驳回"], ["completed", "已完成", "已通过"],
  ];

  for (const [status, statusLabel, approvalLabel] of transitions) {
    await syncExecutionRecord({ client, task, account, status, progress: { completedCount: status === "active" ? 1 : 2, requiredCount: 2 }, approvalStatus: approvalLabel, touchSavedBy: status === "active" });
    const values = updates.at(-1).records[0].values;
    assert.deepStrictEqual(values["当前状态"], select(statusLabel));
    assert.deepStrictEqual(values["审核状态"], select(approvalLabel));
    assert.strictEqual(values["任务项执行"], undefined);
    if (status !== "active") {
      assert.strictEqual(values["最后保存人"], undefined, "审批动作不应冒充业务员保存动作");
      assert.strictEqual(values["最后保存时间"], undefined, "审批动作不应覆盖最后保存时间");
    }
  }
}

async function testExistingResultRecordMovesFromSavedToSubmitted() {
  const adds = [];
  const updates = [];
  const fields = [
    field("任务项执行", "FIELD_TYPE_LINK"), field("任务项", "FIELD_TYPE_LINK"),
    field("说明", "FIELD_TYPE_TEXT"), field("保存状态", "FIELD_TYPE_SINGLE_SELECT"),
    field("提交时间", "FIELD_TYPE_DATE_TIME"),
  ];
  const client = {
    configured: true,
    getSheets: async () => [{ title: "12_物料打卡结果", sheet_id: "result-sheet" }],
    getFields: async () => fields,
    addFields: async () => ({ fields }),
    getRecords: async () => [],
    addRecords: async (sheetId, records) => { adds.push({ sheetId, records }); return { records: [{ record_id: "result-a" }] }; },
    updateRecords: async (sheetId, records) => { updates.push({ sheetId, records }); return { errcode: 0 }; },
  };
  const task = { smartSheetExecutionRecordId: "execution-06-a" };
  const item = { id: "item-a", configItemId: "item-a", smartSheetItemExecutionRecordId: "task-item-execution-a", name: "物料打卡", schemaSnapshot: { resultSheetTitle: "12_物料打卡结果", resultRelationField: "任务项执行", fields: [{ key: "note", label: "说明", inputType: "text" }] } };
  const account = { wecomUserId: "SalesA", name: "业务员甲" };

  const saved = await syncTaskItemResult({ client, cloud: {}, task, item, draft: { values: { note: "草稿" } }, account, final: false });
  assert.strictEqual(saved.recordId, "result-a");
  assert.deepStrictEqual(adds[0].records[0].values["任务项执行"], ["task-item-execution-a"]);
  assert.deepStrictEqual(adds[0].records[0].values["保存状态"], select("已保存"));

  await syncTaskItemResult({ client, cloud: {}, task, item, draft: { values: { note: "最终结果" }, smartSheetResultRecordId: "result-a" }, account, final: true });
  assert.strictEqual(updates[0].records[0].record_id, "result-a", "最终提交应更新已有结果而非重复新增");
  assert.deepStrictEqual(updates[0].records[0].values["保存状态"], select("已提交"));
  assert(Number.isFinite(Number(updates[0].records[0].values["提交时间"])));
}

async function main() {
  await testPublisherPlanFeedsExactNByMChildPlan();
  await testSamplingSnapshotIsFrozenPerStore();
  await testSamplingPublicationRequiresExactlyOneProductRule();
  await testSamplingRuleIsFrozenForEverySelectedStore();
  await testExisting06RecordIsReusedWithoutChangingItsContract();
  await testDuplicate06CombinationFailsClosed();
  await test06StatusWritebackRemainsBackwardCompatible();
  await testExistingResultRecordMovesFromSavedToSubmitted();
  process.stdout.write("task-item workflow contract tests passed\n");
  process.stdout.write("handler resilience and concurrency coverage runs in approval-resilience.test.js\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
