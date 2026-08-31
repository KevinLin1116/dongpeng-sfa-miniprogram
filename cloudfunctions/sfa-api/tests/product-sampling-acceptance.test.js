const assert = require("assert");
const { CONFIRMATION, TITLES, prepareProductSamplingAcceptance } = require("../product-sampling-acceptance");

const text = (value) => [{ type: "text", text: value }];
const sheetEntries = Object.entries(TITLES).map(([key, title], index) => [key, { title, sheet_id: `s${index + 1}` }]);

function fakeClient() {
  const sheetsByKey = Object.fromEntries(sheetEntries);
  const sheets = Object.values(sheetsByKey);
  const fields = Object.fromEntries(sheets.map((sheet) => [sheet.sheet_id, []]));
  const records = Object.fromEntries(sheets.map((sheet) => [sheet.sheet_id, []]));
  const addFields = (key, titles) => { fields[sheetsByKey[key].sheet_id] = titles.map((title, index) => ({ field_id: `${key}-${index}`, field_title: title })); };
  for (const [key] of sheetEntries) addFields(key, ["占位"]);
  addFields("taskItems", ["任务项名称", "写入结果表", "是否必做", "展示顺序", "是否启用", "需要审批", "审批模板", "适用任务类型"]);
  addFields("routes", ["路由规则名称", "所属审批模板", "适用大区", "审核职责", "是否生效", "所属审批节点"]);
  addFields("publications", ["任务名称", "任务类型", "执行要求", "开始时间", "截止时间", "任务门店", "执行人员", "任务项", "产品规则", "需要定位", "允许距离（米）", "超范围处理", "发布状态", "确认发布"]);
  const add = (key, record) => records[sheetsByKey[key].sheet_id].push(record);
  add("taskTypes", { record_id: "type-store", values: { 类型编码: text("STORE") } });
  add("resultDirectory", { record_id: "result-sampling", values: { 结果表名称: text("产品上样结果") } });
  add("taskItems", { record_id: "item-sampling", values: { 任务项名称: text("产品上样") } });
  add("stores", { record_id: "store-md002", values: { 门店编码: text("MD002"), 所属大区: ["region-south"] } });
  add("templates", { record_id: "template-sampling", values: { 审批模板编码: text("PRODUCT_SAMPLING"), 审批模板名称: text("产品上样审批") } });
  add("nodes", { record_id: "node-manager", values: { 审批节点名称: text("产品经理审批"), 所属审批模板: ["template-sampling"] } });
  add("regions", { record_id: "region-south", values: { 大区名称: text("华南运营中心") } });
  add("rules", { record_id: "rule-august", values: { 规则名称: text("8月新品上样") } });
  let sequence = 0;
  const merge = (id, input) => {
    const row = records[id].find((record) => record.record_id === input.record_id);
    row.values = { ...row.values, ...input.values };
  };
  return {
    getSheets: async () => sheets,
    getFields: async (id) => fields[id],
    getRecords: async (id, options = {}) => options.recordIds?.length ? records[id].filter((record) => options.recordIds.includes(record.record_id)) : records[id],
    updateRecords: async (id, updates) => { updates.forEach((update) => merge(id, update)); return { records: updates }; },
    addRecords: async (id, additions) => {
      const added = additions.map((entry) => ({ record_id: `new-${++sequence}`, values: entry.values }));
      records[id].push(...added);
      return { records: added };
    },
    records,
    sheetsByKey,
  };
}

async function testSetupIsVerifiedAndIdempotent() {
  const client = fakeClient();
  const first = await prepareProductSamplingAcceptance(client, { confirmation: CONFIRMATION, nowMs: Date.UTC(2026, 7, 19) });
  assert.strictEqual(first.verified, true);
  assert.strictEqual(first.publicationRecordId, "new-2");
  assert.strictEqual(client.records[client.sheetsByKey.routes.sheet_id].length, 1);
  assert.strictEqual(client.records[client.sheetsByKey.publications.sheet_id].length, 1);
  assert.deepStrictEqual(client.records[client.sheetsByKey.publications.sheet_id][0].values["执行人员"], [{ user_id: "LinWenKai" }]);
  const second = await prepareProductSamplingAcceptance(client, { confirmation: CONFIRMATION, nowMs: Date.UTC(2026, 7, 19) });
  assert.strictEqual(second.publicationRecordId, first.publicationRecordId);
  assert.strictEqual(client.records[client.sheetsByKey.routes.sheet_id].length, 1);
  assert.strictEqual(client.records[client.sheetsByKey.publications.sheet_id].length, 1);
}

async function testConfirmationRequired() {
  await assert.rejects(() => prepareProductSamplingAcceptance(fakeClient(), {}), (error) => error.code === "ACCEPTANCE_SETUP_CONFIRMATION_REQUIRED");
}

Promise.resolve().then(testSetupIsVerifiedAndIdempotent).then(testConfirmationRequired).then(() => process.stdout.write("product sampling acceptance setup tests passed\n")).catch((error) => { console.error(error); process.exitCode = 1; });
