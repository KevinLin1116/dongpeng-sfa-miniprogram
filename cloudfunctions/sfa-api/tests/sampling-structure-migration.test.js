const assert = require("assert");
const { CONFIRMATION, CLEANUP_CONFIRMATION, LINK_REPAIR_CONFIRMATION, autoNumberField, migrateSamplingRuleStructure, cleanupSamplingRuleStructure, repairSamplingGroupRuleLinks, migrationPlan, inspect } = require("../sampling-structure-migration");

const field = (title, type, id, property = {}) => ({ field_title: title, field_type: type, field_id: id, ...property });

function fakeClient() {
  const sheets = [
    { title: "04_任务发布", sheet_id: "s04" },
    { title: "21_产品主档", sheet_id: "s21" },
    { title: "22_上样组合规则", sheet_id: "s22" },
    { title: "23_上样规则明细", sheet_id: "s23" },
    { title: "24_产品上样结果", sheet_id: "s24" },
  ];
  const fields = {
    s04: [field("任务名称", "FIELD_TYPE_TEXT", "f04-main")],
    s21: [field("产品编码", "FIELD_TYPE_TEXT", "f21-main")],
    s22: [field("上样规则名称", "FIELD_TYPE_TEXT", "f22-main")],
    s23: [field("规则明细编号", "FIELD_TYPE_TEXT", "f23-main")],
    s24: [field("上样结果编号", "FIELD_TYPE_TEXT", "f24-main")],
  };
  const records = { s22: [], s23: [] };
  let sequence = 0;
  return {
    calls: [],
    getSheets: async () => sheets,
    getFields: async (id) => fields[id],
    getRecords: async (id) => records[id] || [],
    updateRecordsBatched: async (id, updates) => { for (const update of updates) { const row = records[id].find((item) => item.record_id === update.record_id); row.values = { ...row.values, ...update.values }; } },
    updateSheet: async (id, title) => { const sheet = sheets.find((item) => item.sheet_id === id); sheet.title = title; },
    updateFields: async (id, updates) => { for (const update of updates) { const index = fields[id].findIndex((item) => item.field_id === update.field_id); fields[id][index] = { ...fields[id][index], ...update }; } },
    addFields: async (id, additions) => { additions.forEach((definition) => fields[id].push({ ...definition, field_id: `new-${++sequence}` })); },
    deleteFields: async (id, fieldIds) => { fields[id] = fields[id].filter((item) => !fieldIds.includes(item.field_id)); },
    fields,
    records,
  };
}

async function testNativeAutoNumberDefinition() {
  const definition = autoNumberField("产品规则编号");
  assert.strictEqual(definition.field_type, "FIELD_TYPE_AUTONUMBER");
  assert.deepStrictEqual(definition.property_auto_number, { type: "NUMBER_TYPE_INCR", rules: [{ type: "NUMBER_RULE_TYPE_INCR", value: "3" }], reformat_existing_record: true });
}

async function testPlanAndApplyAreAdditiveAndIdempotent() {
  const client = fakeClient();
  const baseline = await inspect(client);
  const plan = migrationPlan(baseline);
  assert.strictEqual(plan.renameRuleSheet, true);
  assert.strictEqual(plan.renameRuleName.fields[0].field_id, "f22-main");
  assert.deepStrictEqual(plan.addOperations.find((item) => item.section === "publications").fields.map((item) => item.field_title), ["产品规则"]);

  const first = await migrateSamplingRuleStructure(client, CONFIRMATION);
  assert(first.applied.some((item) => item.action === "rename_sheet"));
  assert.strictEqual(first.verified.fields.ruleNumber.type, "FIELD_TYPE_AUTONUMBER");
  assert.strictEqual(first.verified.fields.groupRule.property.property_reference.is_multiple, false);
  assert.strictEqual(first.verified.fields.groupProducts.property.property_reference.sub_id, "s21");
  assert.strictEqual(first.verified.fields.resultGroup.property.property_reference.sub_id, "s23");

  const second = await migrateSamplingRuleStructure(client, CONFIRMATION);
  assert.deepStrictEqual(second.applied, []);
}

async function testCleanupProducesOnlyOneWayMinimalFields() {
  const client = fakeClient();
  await migrateSamplingRuleStructure(client, CONFIRMATION);
  const groupRule = client.fields.s23.find((item) => item.field_title === "产品规则");
  groupRule.field_title = "所属上样规则";
  client.fields.s22.push(
    field("规则编码", "FIELD_TYPE_TEXT", "old-rule-code"),
    field("规则说明", "FIELD_TYPE_TEXT", "old-rule-note"),
    field("包含的规则分组", "FIELD_TYPE_REFERENCE", "old-rule-groups", { property_reference: { sub_id: "s23", field_id: "", is_multiple: true } }),
  );
  client.fields.s23.push(
    field("适用产品", "FIELD_TYPE_REFERENCE", "old-products", { property_reference: { sub_id: "s21", field_id: "", is_multiple: true } }),
    field("产品名称", "FIELD_TYPE_LOOKUP", "old-name"),
    field("是否启用", "FIELD_TYPE_CHECKBOX", "old-enabled"),
  );
  client.records.s22.push({ record_id: "rule-1", values: { "规则名称": [{ type: "text", text: "规则一" }], "规则编码": [{ type: "text", text: "OLD-1" }], "产品规则编号": [{ type: "text", text: "1" }] } });
  client.records.s23.push({ record_id: "group-1", values: { "规则明细编号": [], "一级分组名称": [{ type: "text", text: "必上" }], "所属上样规则": ["rule-1"], "适用产品": ["product-1"], "关联产品": ["product-1"], "必上样数量": 1 } });

  const result = await cleanupSamplingRuleStructure(client, CLEANUP_CONFIRMATION);
  assert.deepStrictEqual(new Set(result.fields.rules), new Set(["规则名称", "产品规则编号"]));
  assert.deepStrictEqual(new Set(result.fields.groups), new Set(["一级分组名称", "产品规则", "二级分组名称", "关联产品", "必上样数量", "规则分组编号"]));
  assert.strictEqual(client.records.s23[0].values["规则明细编号"][0].text, "必上");
  const relation = client.fields.s23.find((item) => item.field_title === "产品规则");
  assert.strictEqual(relation.property_reference.sub_id, "s22");
  assert.strictEqual(relation.property_reference.is_multiple, false);
}

async function testConfirmationRequired() {
  await assert.rejects(() => migrateSamplingRuleStructure(fakeClient(), ""), (error) => error.code === "SAMPLING_MIGRATION_CONFIRMATION_REQUIRED");
}

async function testNarrowRepairRestoresOnlyGroupToRuleLinks() {
  const client = fakeClient();
  await migrateSamplingRuleStructure(client, CONFIRMATION);
  client.records.s22.push({ record_id: "rule-1", values: { "规则名称": [{ type: "text", text: "规则一" }] } });
  client.records.s23.push(
    { record_id: "group-1", values: { "一级分组名称": [{ type: "text", text: "必上" }] } },
    { record_id: "group-2", values: { "一级分组名称": [{ type: "text", text: "任选" }] } },
  );
  client.fields.s23 = client.fields.s23.filter((item) => item.field_title !== "产品规则");
  const result = await repairSamplingGroupRuleLinks(client, LINK_REPAIR_CONFIRMATION, [
    { groupRecordId: "group-1", ruleRecordId: "rule-1" },
    { groupRecordId: "group-2", ruleRecordId: "rule-1" },
  ]);
  assert.strictEqual(result.restored.length, 2);
  assert.deepStrictEqual(client.records.s23.map((record) => record.values["产品规则"]), [["rule-1"], ["rule-1"]]);
  await assert.rejects(() => repairSamplingGroupRuleLinks(client, LINK_REPAIR_CONFIRMATION, [{ groupRecordId: "group-1", ruleRecordId: "rule-1" }]), (error) => error.code === "SAMPLING_LINK_REPAIR_INCOMPLETE");
}

Promise.resolve().then(testNativeAutoNumberDefinition).then(testPlanAndApplyAreAdditiveAndIdempotent).then(testCleanupProducesOnlyOneWayMinimalFields).then(testNarrowRepairRestoresOnlyGroupToRuleLinks).then(testConfirmationRequired).then(() => process.stdout.write("sampling structure migration tests passed\n")).catch((error) => { console.error(error); process.exitCode = 1; });
