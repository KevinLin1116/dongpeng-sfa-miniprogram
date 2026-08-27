const assert = require("assert");
const {
  APPROVAL_HISTORY_SYSTEM_FIELDS_CONFIRMATION,
  auditKey,
  appendApprovalHistory,
  repairApprovalHistorySystemFields,
} = require("../approval-history-writeback");

const field = (title, type, id, extra = {}) => ({ field_title: title, field_type: type, field_id: id, ...extra });
const ref = (subId) => ({ property_reference: { sub_id: subId, field_id: "" } });
const select = (values) => ({ property_single_select: { is_quick_add: false, options: values.map((text) => ({ text })) } });

function client({ lostReply = false, duplicate = false } = {}) {
  const rows = duplicate ? [{ record_id: "a", key: "AUDIT:approval-1:node-1:提交审批" }, { record_id: "b", key: "AUDIT:approval-1:node-1:提交审批" }] : [];
  const calls = [];
  const mock = {
    calls,
    readCount: 0,
    getSheets: async () => [
      { title: "07_审核记录", sheet_id: "s07" }, { title: "16_任务项执行", sheet_id: "s16" },
      { title: "17_审批模板", sheet_id: "s17" }, { title: "20_大区主档", sheet_id: "s20" },
    ],
    getFields: async () => [
      field("操作唯一键", "FIELD_TYPE_TEXT", "f-key"),
      field("任务项执行", "FIELD_TYPE_REFERENCE", "f-item", ref("s16")),
      field("审批模板", "FIELD_TYPE_REFERENCE", "f-template", ref("s17")),
      field("命中大区", "FIELD_TYPE_REFERENCE", "f-region", ref("s20")),
      field("提交轮次", "FIELD_TYPE_NUMBER", "f-round"),
      field("审核动作", "FIELD_TYPE_SINGLE_SELECT", "f-action", select(["提交审批", "整改重提", "审核通过", "审核退回"])),
      field("操作人", "FIELD_TYPE_USER", "f-user"),
      field("审核意见", "FIELD_TYPE_TEXT", "f-opinion"),
    ],
    getRecords: async () => {
      mock.readCount += 1;
      return rows.map((row) => ({ record_id: row.record_id, values: { "操作唯一键": [{ type: "text", text: row.key }] } }));
    },
    addRecords: async (sheetId, records, options) => {
      calls.push({ sheetId, records, options });
      rows.push({ record_id: "history-1", key: records[0].values["f-key"][0].text });
      if (lostReply) throw new Error("模拟响应丢失");
      return { records: [{ record_id: "history-1" }] };
    },
  };
  return mock;
}

const input = (mock) => ({ client: mock, approvalId: "approval-1", nodeRecordId: "node-1", action: "提交审批", itemExecutionRecordId: "item-exec", templateRecordId: "template-1", regionRecordId: "region-1", round: 1, operatorUserId: "SalesA", operatorName: "业务员甲" });

async function testAppendAndReuse() {
  const mock = client();
  const first = await appendApprovalHistory(input(mock));
  const second = await appendApprovalHistory(input(mock));
  assert.strictEqual(first.recordId, "history-1");
  assert.strictEqual(second.reused, true);
  assert.strictEqual(mock.calls.length, 1);
  assert.strictEqual(mock.readCount, 2, "新增成功后应直接使用接口返回ID，不应额外回读");
  assert.deepStrictEqual(mock.calls[0].records[0].values["f-user"], [{ user_id: "SalesA" }]);
  assert.strictEqual(auditKey("approval-1", "node-1", "提交审批"), "AUDIT:approval-1:node-1:提交审批");
}

async function testLostReplyAndDuplicate() {
  assert.strictEqual((await appendApprovalHistory(input(client({ lostReply: true })))).recordId, "history-1");
  await assert.rejects(() => appendApprovalHistory(input(client({ duplicate: true }))), (error) => error.code === "APPROVAL_HISTORY_KEY_CONFLICT");
}

async function testRepairSystemFields() {
  const fields = [
    field("任务项执行", "FIELD_TYPE_REFERENCE", "f-item", ref("s16")),
    field("审批模板", "FIELD_TYPE_REFERENCE", "f-template", ref("s17")),
    field("审核动作", "FIELD_TYPE_SINGLE_SELECT", "f-action", select(["提交审批"])),
    field("操作人", "FIELD_TYPE_USER", "f-user"),
  ];
  const added = [];
  const updated = [];
  const mock = {
    getSheets: async () => [{ title: "07_审核记录", sheet_id: "s07" }, { title: "20_大区主档", sheet_id: "s20" }],
    getFields: async () => fields,
    addFields: async (sheetId, definitions) => {
      assert.strictEqual(sheetId, "s07");
      added.push(...definitions);
      definitions.forEach((definition, index) => fields.push({ ...definition, field_id: `new-${index}` }));
    },
    updateFields: async (sheetId, definitions) => {
      assert.strictEqual(sheetId, "s07");
      updated.push(...definitions);
      definitions.forEach((definition) => {
        const index = fields.findIndex((entry) => entry.field_id === definition.field_id);
        fields[index] = { ...fields[index], ...definition };
      });
    },
  };
  const result = await repairApprovalHistorySystemFields(mock, APPROVAL_HISTORY_SYSTEM_FIELDS_CONFIRMATION);
  assert.deepStrictEqual(result.added, ["操作唯一键", "命中大区", "提交轮次"]);
  assert.strictEqual(result.maintainedBy, "system");
  assert.strictEqual(added[1].property_reference.sub_id, "s20");
  assert.deepStrictEqual(result.optionsAdded, ["整改重提", "审核通过", "审核退回"]);
  assert.strictEqual(updated.length, 1);
  assert.deepStrictEqual(updated[0].property_single_select.options.map((option) => option.text), ["提交审批", "整改重提", "审核通过", "审核退回"]);
  const replay = await repairApprovalHistorySystemFields(mock, APPROVAL_HISTORY_SYSTEM_FIELDS_CONFIRMATION);
  assert.deepStrictEqual(replay.added, []);
  assert.deepStrictEqual(replay.optionsAdded, []);
  await assert.rejects(() => repairApprovalHistorySystemFields(mock, ""), (error) => error.code === "APPROVAL_HISTORY_REPAIR_CONFIRMATION_REQUIRED");
}

async function main() {
  await testAppendAndReuse();
  await testLostReplyAndDuplicate();
  await testRepairSystemFields();
  process.stdout.write("approval history writeback tests passed\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
