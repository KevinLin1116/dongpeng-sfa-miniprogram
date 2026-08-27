const assert = require("assert");
const Module = require("module");
const path = require("path");
const actualWecom = require("../wecom");

const INDEX_PATH = path.resolve(__dirname, "../index.js");
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const matches = (record, where) => Object.entries(where || {}).every(([key, value]) => record[key] === value);

function memoryDatabase(seed) {
  const tables = new Map(Object.entries(seed).map(([name, rows]) => [name, clone(rows)]));
  let sequence = 0;
  const rows = (name) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name); };
  function collection(name) {
    const state = { where: {}, limit: Infinity, skip: 0 };
    const query = {
      where(value) { state.where = value || {}; return query; }, limit(value) { state.limit = value; return query; }, skip(value) { state.skip = value; return query; },
      async get() { return { data: clone(rows(name).filter((row) => matches(row, state.where)).slice(state.skip, state.skip + state.limit)) }; },
      async add({ data }) { const row = { ...clone(data), _id: data._id || `${name}-${++sequence}` }; if (rows(name).some((entry) => entry._id === row._id)) throw new Error("document already exists"); rows(name).push(row); return { _id: row._id }; },
      async update({ data }) { let count = 0; rows(name).forEach((row, index) => { if (matches(row, state.where)) { rows(name)[index] = { ...row, ...clone(data) }; count += 1; } }); return { stats: { updated: count } }; },
      async remove() { const keep = rows(name).filter((row) => !matches(row, state.where)); const removed = rows(name).length - keep.length; tables.set(name, keep); return { stats: { removed } }; },
      doc(id) { return {
        async get() { const row = rows(name).find((entry) => entry._id === id); if (!row) throw new Error("document not found"); return { data: clone(row) }; },
        async update({ data }) { const index = rows(name).findIndex((entry) => entry._id === id); if (index < 0) throw new Error("document not found"); rows(name)[index] = { ...rows(name)[index], ...clone(data) }; return { stats: { updated: 1 } }; },
        async set({ data }) { const index = rows(name).findIndex((entry) => entry._id === id); const row = { ...clone(data), _id: id }; if (index < 0) rows(name).push(row); else rows(name)[index] = row; return { _id: id }; },
        async remove() { const index = rows(name).findIndex((entry) => entry._id === id); if (index >= 0) rows(name).splice(index, 1); return { stats: { removed: index >= 0 ? 1 : 0 } }; },
      }; },
    };
    return query;
  }
  return { collection, async createCollection(name) { rows(name); }, snapshot: (name) => clone(rows(name)) };
}

const text = (value) => [{ type: "text", text: String(value) }];
const option = (value) => [{ text: value }];
const field = (title, type, id, extra = {}) => ({ field_title: title, field_type: type, field_id: id, ...extra });
const ref = (subId) => ({ property_reference: { sub_id: subId, field_id: "" } });
const select = (values) => ({ property_single_select: { is_quick_add: false, options: values.map((text) => ({ text })) } });

function fakeSmartSheet() {
  const sheets = ["05_任务项设置", "06_任务执行", "07_审核记录", "08_人员主档", "09_门店主档", "16_任务项执行", "17_审批模板", "18_审批节点设置", "19_审批路由规则", "20_大区主档", "21_产品主档", "22_上样组合规则", "24_产品上样结果"].map((title) => ({ title, sheet_id: `s${title.slice(0, 2)}` }));
  const byTitle = Object.fromEntries(sheets.map((sheet) => [sheet.title, sheet.sheet_id]));
  const definitions = {
    [byTitle["05_任务项设置"]]: [field("任务项名称", "FIELD_TYPE_TEXT", "f05-main")],
    [byTitle["06_任务执行"]]: [field("执行记录编号", "FIELD_TYPE_TEXT", "f06-main"), field("当前状态", "FIELD_TYPE_SINGLE_SELECT", "f06-status"), field("已完成项数", "FIELD_TYPE_NUMBER", "f06-done"), field("必做项总数", "FIELD_TYPE_NUMBER", "f06-total"), field("提交人", "FIELD_TYPE_USER", "f06-user"), field("提交时间", "FIELD_TYPE_DATE_TIME", "f06-time"), field("审核状态", "FIELD_TYPE_SINGLE_SELECT", "f06-approval")],
    [byTitle["07_审核记录"]]: [field("操作唯一键", "FIELD_TYPE_TEXT", "f07-key"), field("任务项执行", "FIELD_TYPE_REFERENCE", "f07-item", ref(byTitle["16_任务项执行"])), field("审批模板", "FIELD_TYPE_REFERENCE", "f07-template", ref(byTitle["17_审批模板"])), field("命中大区", "FIELD_TYPE_REFERENCE", "f07-region", ref(byTitle["20_大区主档"])), field("提交轮次", "FIELD_TYPE_NUMBER", "f07-round"), field("审核动作", "FIELD_TYPE_SINGLE_SELECT", "f07-action", select(["提交审批", "整改重提", "审核通过", "审核退回"])), field("操作人", "FIELD_TYPE_USER", "f07-user"), field("审核意见", "FIELD_TYPE_TEXT", "f07-opinion")],
    [byTitle["08_人员主档"]]: [field("企微人员ID", "FIELD_TYPE_TEXT", "f08-id"), field("姓名", "FIELD_TYPE_TEXT", "f08-name")],
    [byTitle["09_门店主档"]]: [field("所属大区", "FIELD_TYPE_REFERENCE", "f09-region", ref(byTitle["20_大区主档"]))],
    [byTitle["16_任务项执行"]]: [field("任务项执行编号", "FIELD_TYPE_TEXT", "f16-main"), field("所属执行记录", "FIELD_TYPE_REFERENCE", "f16-parent", ref(byTitle["06_任务执行"])), field("来源任务项", "FIELD_TYPE_REFERENCE", "f16-item", ref(byTitle["05_任务项设置"])), field("执行状态", "FIELD_TYPE_SINGLE_SELECT", "f16-status", select(["待执行", "进行中", "待复核", "已完成", "待整改"])), field("结果表名称（自动）", "FIELD_TYPE_TEXT", "f16-sheet"), field("结果记录编号（自动）", "FIELD_TYPE_TEXT", "f16-result"), field("提交时间", "FIELD_TYPE_DATE_TIME", "f16-time"), field("审批状态", "FIELD_TYPE_SINGLE_SELECT", "f16-approval", select(["无需审批", "待审批", "已通过", "已退回"])), field("最新退回原因", "FIELD_TYPE_TEXT", "f16-reason"), field("允许修改", "FIELD_TYPE_CHECKBOX", "f16-edit")],
    [byTitle["17_审批模板"]]: [field("审批模板名称", "FIELD_TYPE_TEXT", "f17-name"), field("审批模板编码", "FIELD_TYPE_TEXT", "f17-code"), field("状态", "FIELD_TYPE_SINGLE_SELECT", "f17-status")],
    [byTitle["18_审批节点设置"]]: [field("所属审批模板", "FIELD_TYPE_REFERENCE", "f18-template", ref(byTitle["17_审批模板"])), field("节点编码", "FIELD_TYPE_TEXT", "f18-code"), field("节点名称", "FIELD_TYPE_TEXT", "f18-name"), field("节点顺序", "FIELD_TYPE_NUMBER", "f18-order"), field("审核职责", "FIELD_TYPE_SINGLE_SELECT", "f18-duty"), field("状态", "FIELD_TYPE_SINGLE_SELECT", "f18-status")],
    [byTitle["19_审批路由规则"]]: [field("所属审批模板", "FIELD_TYPE_REFERENCE", "f19-template", ref(byTitle["17_审批模板"])), field("所属审批节点", "FIELD_TYPE_REFERENCE", "f19-node", ref(byTitle["18_审批节点设置"])), field("适用大区", "FIELD_TYPE_REFERENCE", "f19-region", ref(byTitle["20_大区主档"])), field("审核职责", "FIELD_TYPE_SINGLE_SELECT", "f19-duty"), field("当前审核人", "FIELD_TYPE_REFERENCE", "f19-user", ref(byTitle["08_人员主档"])), field("状态", "FIELD_TYPE_SINGLE_SELECT", "f19-status")],
    [byTitle["20_大区主档"]]: [field("大区编码", "FIELD_TYPE_TEXT", "f20-code"), field("大区名称", "FIELD_TYPE_TEXT", "f20-name"), field("产品经理", "FIELD_TYPE_REFERENCE", "f20-manager", ref(byTitle["08_人员主档"])), field("状态", "FIELD_TYPE_SINGLE_SELECT", "f20-status")],
    [byTitle["21_产品主档"]]: [field("产品编码", "FIELD_TYPE_TEXT", "f21-main")],
    [byTitle["22_上样组合规则"]]: [field("规则编码", "FIELD_TYPE_TEXT", "f22-main")],
    [byTitle["24_产品上样结果"]]: [field("任务项执行", "FIELD_TYPE_REFERENCE", "f24-item", ref(byTitle["16_任务项执行"])), field("上样规则", "FIELD_TYPE_REFERENCE", "f24-rule", ref(byTitle["22_上样组合规则"])), field("上样产品", "FIELD_TYPE_REFERENCE", "f24-product", ref(byTitle["21_产品主档"])), field("上样图片", "FIELD_TYPE_IMAGE", "f24-images"), field("上样状态", "FIELD_TYPE_SINGLE_SELECT", "f24-status", select(["已上样", "未上样"])), field("保存状态", "FIELD_TYPE_SINGLE_SELECT", "f24-save", select(["已提交"])), field("提交轮次", "FIELD_TYPE_NUMBER", "f24-round"), field("审批状态", "FIELD_TYPE_SINGLE_SELECT", "f24-approval", select(["待审批", "无需审批", "已通过", "已退回"])), field("不合格原因", "FIELD_TYPE_TEXT", "f24-reason"), field("结果唯一键", "FIELD_TYPE_TEXT", "f24-key")],
  };
  const records = {
    [byTitle["08_人员主档"]]: [{ record_id: "person-manager", values: { "企微人员ID": text("ManagerA"), "姓名": text("产品经理甲") } }],
    [byTitle["09_门店主档"]]: [{ record_id: "store-1", values: { "所属大区": ["region-1"] } }],
    [byTitle["17_审批模板"]]: [{ record_id: "template-1", values: { "审批模板名称": text("产品上样审批"), "审批模板编码": text("SAMPLING"), "状态": option("启用") } }],
    [byTitle["18_审批节点设置"]]: [{ record_id: "node-1", values: { "所属审批模板": ["template-1"], "节点编码": text("PM"), "节点名称": text("产品经理审批"), "节点顺序": 1, "审核职责": option("产品经理"), "状态": option("启用") } }],
    [byTitle["19_审批路由规则"]]: [{ record_id: "route-1", values: { "所属审批模板": ["template-1"], "所属审批节点": ["node-1"], "适用大区": ["region-1"], "审核职责": option("产品经理"), "状态": option("启用") } }],
    [byTitle["20_大区主档"]]: [{ record_id: "region-1", values: { "大区编码": text("SOUTH"), "大区名称": text("华南"), "产品经理": ["person-manager"], "状态": option("启用") } }],
    [byTitle["24_产品上样结果"]]: [], [byTitle["07_审核记录"]]: [],
  };
  function titleValues(sheetId, values) {
    const map = Object.fromEntries((definitions[sheetId] || []).map((entry) => [entry.field_id, entry.field_title]));
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [map[key] || key, clone(value)]));
  }
  let sequence = 0;
  let imageUploadCount = 0;
  const writes = [];
  let failNextAddTitle = "";
  return {
    configured: true, docId: "test-doc", writes, byTitle,
    async getSheets() { return sheets; }, async getFields(id) { return definitions[id] || []; },
    async getRecords(id, options = {}) { let rows = records[id] || []; if (options.recordIds?.length) rows = rows.filter((row) => options.recordIds.includes(row.record_id)); return clone(rows); },
    async addRecords(id, input) { if (failNextAddTitle && byTitle[failNextAddTitle] === id) { failNextAddTitle = ""; throw new Error("模拟智能表格新增失败"); } const added = input.map((entry) => { const row = { record_id: `${id}-row-${++sequence}`, values: titleValues(id, entry.values) }; if (!records[id]) records[id] = []; records[id].push(row); return { record_id: row.record_id }; }); writes.push({ action: "add", id, input: clone(input) }); return { records: added }; },
    async uploadImage() { imageUploadCount += 1; return { id: `image-${++sequence}`, image_url: `https://doc/upload-${sequence}` }; },
    async updateRecords(id, input) { for (const entry of input) { const row = (records[id] || []).find((candidate) => candidate.record_id === entry.record_id); if (row) row.values = { ...row.values, ...titleValues(id, entry.values) }; } writes.push({ action: "update", id, input: clone(input) }); return { errcode: 0 }; },
    async updateRecordsBatched(id, input, options) { await this.updateRecords(id, input, options); return { batches: [{ size: input.length }] }; },
    invalidateFieldContract() {}, get imageUploadCount() { return imageUploadCount; }, snapshot(title) { return clone(records[byTitle[title]] || []); }, addRawRecord(title, row) { records[byTitle[title]].push(clone(row)); }, updateRawRecord(title, recordId, values) { const row = records[byTitle[title]].find((entry) => entry.record_id === recordId); row.values = { ...row.values, ...clone(values) }; }, failNextAdd(title) { failNextAddTitle = title; },
  };
}

function seed() {
  const snapshot = { version: "snapshot-v1", businessRegionSnapshot: { regionRecordId: "region-1", regionCode: "SOUTH", regionName: "华南" }, groups: [{ ruleRecordId: "rule-1", ruleCode: "MUST", name: "必上", required: true, minRequired: 1, products: [{ productRecordId: "product-1", code: "DP1", name: "产品1", specification: "600x1200", minPhotos: 1, maxPhotos: 3 }] }] };
  return {
    sfa_account_bindings: [{ _id: "sales", openId: "openid-sales", wecomUserId: "SalesA", name: "业务员甲", roles: ["业务员"], dataScope: "self", status: "active" }, { _id: "manager", openId: "openid-manager", wecomUserId: "ManagerA", name: "产品经理甲", roles: ["任务审核者"], dataScope: "self", status: "active" }, { _id: "fixed", openId: "openid-fixed", wecomUserId: "FixedUser", name: "总部审核人", roles: ["任务审核者"], dataScope: "self", status: "active" }, { _id: "admin", openId: "openid-admin", wecomUserId: "AdminA", name: "管理员甲", roles: ["管理员"], dataScope: "all", status: "active" }],
    sfa_task_instances: [{ _id: "task-1", id: "task-1", sourceTaskRecordId: "publication-1", smartSheetExecutionRecordId: "execution-1", name: "产品上样任务", storeRecordId: "store-1", storeName: "绿岛湖店", executorUserIds: ["SalesA"], status: "active", progress: 100, completedItemCount: 1, requiredItemCount: 1, items: [{ id: "item-1", configItemId: "item-record-1", name: "产品上样", renderer: "sampling", required: true, status: "completed", requiresApproval: true, approvalTemplateCode: "template-1", approvalTemplateIds: ["template-1"], smartSheetItemExecutionRecordId: "item-execution-1", samplingSnapshot: snapshot, approvalStructureSnapshot: { templateRecordId: "template-1", templateCode: "SAMPLING", templateName: "产品上样审批", nodes: [{ nodeRecordId: "node-1", nodeCode: "PM", nodeName: "产品经理审批", order: 1, duty: "产品经理" }] }, schemaSnapshot: { resultSheetTitle: "24_产品上样结果", requiresApproval: true } }] }],
    sfa_task_drafts: [{ _id: "draft-1", taskId: "task-1", itemId: "item-1", completed: true, pendingCompleteOperationId: "", updatedAt: "2026-08-19T08:00:00.000Z", values: { "product-1": ["cloud://photo-1"] }, smartSheetImageCache: { "cloud://photo-1": { id: "image-1", image_url: "https://doc/photo-1" } } }],
    sfa_approvals: [], sfa_runtime_logs: [], sfa_idempotency_records: [], sfa_cache: [], sfa_location_records: [],
  };
}

function loadHarness() {
  const database = memoryDatabase(seed());
  const smartSheet = fakeSmartSheet();
  let openId = "openid-sales";
  const cloud = { DYNAMIC_CURRENT_ENV: "test", init() {}, database: () => database, getWXContext: () => ({ OPENID: openId }), downloadFile: async ({ fileID }) => ({ fileContent: Buffer.from(fileID) }), deleteFile: async ({ fileList }) => ({ fileList: fileList.map((fileID) => ({ fileID, status: 0 })) }) };
  class Client { constructor() { return smartSheet; } }
  const original = Module._load;
  process.env.SFA_WECOM_CORP_ID = "corp"; process.env.SFA_WECOM_SECRET = "secret"; process.env.SFA_SMART_SHEET_DOC_ID = "test-doc";
  Module._load = function patched(request, parent, isMain) { if (request === "wx-server-sdk") return cloud; if (request === "./wecom" && parent?.filename === INDEX_PATH) return { ...actualWecom, SmartSheetClient: Client }; return original.call(this, request, parent, isMain); };
  delete require.cache[INDEX_PATH];
  let api;
  try { api = require(INDEX_PATH); } finally { Module._load = original; }
  return { api, database, smartSheet, asManager() { openId = "openid-manager"; }, asSales() { openId = "openid-sales"; }, asFixed() { openId = "openid-fixed"; }, asAdmin() { openId = "openid-admin"; }, restore() { delete require.cache[INDEX_PATH]; } };
}

async function testFullSamplingApprovalLoop() {
  const harness = loadHarness();
  try {
    const submitted = await harness.api.main({ action: "submitTask", taskId: "task-1", requestId: "submit-1" });
    assert.deepStrictEqual(submitted, { ok: true, data: { status: "review", approvalCount: 1 } });
    assert.strictEqual(harness.smartSheet.snapshot("24_产品上样结果").length, 1);
    assert.strictEqual(actualWecom.cellText(harness.smartSheet.snapshot("24_产品上样结果")[0], "审批状态"), "待审批");
    assert.strictEqual(harness.smartSheet.snapshot("07_审核记录").length, 1);
    assert.strictEqual(harness.database.snapshot("sfa_approvals")[0].currentReviewerUserId, "ManagerA");
    assert.strictEqual(harness.database.snapshot("sfa_task_instances")[0].status, "review");

    const replay = await harness.api.main({ action: "submitTask", taskId: "task-1", requestId: "submit-1" });
    assert.deepStrictEqual(replay, submitted, "同一请求重放必须返回首次结果");
    assert.strictEqual(harness.smartSheet.snapshot("24_产品上样结果").length, 1);

    harness.asManager();
    const approvalId = harness.database.snapshot("sfa_approvals")[0]._id;
    const decided = await harness.api.main({ action: "decideApproval", approvalId, productDecisions: [{ productRecordId: "product-1", decision: "qualified" }], requestId: "approve-1" });
    assert.deepStrictEqual(decided, { ok: true, data: { status: "approved" } });
    assert.strictEqual(actualWecom.cellText(harness.smartSheet.snapshot("24_产品上样结果")[0], "审批状态"), "已通过");
    assert.strictEqual(harness.smartSheet.snapshot("07_审核记录").length, 2);
    assert.strictEqual(harness.database.snapshot("sfa_task_instances")[0].status, "completed");
    assert.strictEqual(harness.database.snapshot("sfa_approvals")[0].status, "approved");
  } finally { harness.restore(); }
}

async function testRejectRectifyResubmitOverwritesCurrentResult() {
  const harness = loadHarness();
  try {
    await harness.api.main({ action: "submitTask", taskId: "task-1", requestId: "submit-round-1" });
    harness.asManager();
    const firstApproval = harness.database.snapshot("sfa_approvals")[0];
    const rejected = await harness.api.main({ action: "decideApproval", approvalId: firstApproval._id, productDecisions: [{ productRecordId: "product-1", decision: "unqualified", reason: "照片角度不完整" }], requestId: "reject-round-1" });
    assert.strictEqual(rejected.ok, true);
    assert.strictEqual(harness.database.snapshot("sfa_task_instances")[0].status, "rectify");
    assert.strictEqual(actualWecom.cellText(harness.smartSheet.snapshot("24_产品上样结果")[0], "审批状态"), "已退回");
    assert.deepStrictEqual(harness.database.snapshot("sfa_task_drafts")[0].values["product-1"], [], "退回后旧照片不再展示");
    assert.deepStrictEqual(harness.database.snapshot("sfa_approvals")[0].evidenceGroups[0].products[0].images, [], "审核记录不得保留被退回产品的旧照片");

    harness.asSales();
    const completed = await harness.api.main({ action: "completeTaskItem", taskId: "task-1", itemId: "item-1", values: { "product-1": ["cloud://photo-2"] }, requestId: "complete-round-2" });
    assert.strictEqual(completed.ok, true);
    assert.deepStrictEqual(harness.database.snapshot("sfa_task_drafts")[0].samplingReview.pendingDeleteFileIds, [], "新证据保存后应清理旧云存储照片");
    const resubmitted = await harness.api.main({ action: "submitTask", taskId: "task-1", requestId: "submit-round-2" });
    assert.strictEqual(resubmitted.ok, true);
    const resultRows = harness.smartSheet.snapshot("24_产品上样结果");
    assert.strictEqual(resultRows.length, 1, "整改重提必须覆盖同一产品的当前结果");
    assert.deepStrictEqual(resultRows.map((row) => actualWecom.cellText(row, "结果唯一键")), ["RESULT:item-execution-1:1:product-1"]);
    assert.deepStrictEqual(resultRows.map((row) => actualWecom.cellText(row, "审批状态")), ["待审批"]);
    assert.strictEqual(harness.smartSheet.snapshot("07_审核记录").length, 3, "应保留提交、退回和整改重提三条历史");

    harness.asManager();
    const secondApproval = harness.database.snapshot("sfa_approvals").find((approval) => approval.itemSubmissionRound === 2);
    const approved = await harness.api.main({ action: "decideApproval", approvalId: secondApproval._id, productDecisions: [{ productRecordId: "product-1", decision: "qualified" }], requestId: "approve-round-2" });
    assert.strictEqual(approved.ok, true);
    assert.deepStrictEqual(harness.smartSheet.snapshot("24_产品上样结果").map((row) => actualWecom.cellText(row, "审批状态")), ["已通过"]);
    assert.strictEqual(harness.smartSheet.snapshot("07_审核记录").length, 4);
    assert.strictEqual(harness.database.snapshot("sfa_task_instances")[0].status, "completed");
  } finally { harness.restore(); }
}

async function testNextNodeResolvesReviewerWhenNodeStarts() {
  const harness = loadHarness();
  try {
    harness.smartSheet.addRawRecord("08_人员主档", { record_id: "person-fixed", values: { "企微人员ID": text("FixedUser"), "姓名": text("总部审核人") } });
    harness.smartSheet.addRawRecord("18_审批节点设置", { record_id: "node-2", values: { "所属审批模板": ["template-1"], "节点编码": text("HQ"), "节点名称": text("总部复核"), "节点顺序": 2, "审核职责": option("固定人员"), "状态": option("启用") } });
    harness.smartSheet.addRawRecord("19_审批路由规则", { record_id: "route-2", values: { "所属审批模板": ["template-1"], "所属审批节点": ["node-2"], "适用大区": ["region-1"], "审核职责": option("固定人员"), "当前审核人": ["person-fixed"], "状态": option("启用") } });
    const task = harness.database.snapshot("sfa_task_instances")[0];
    const nodes = task.items[0].approvalStructureSnapshot.nodes.concat([{ nodeRecordId: "node-2", nodeCode: "HQ", nodeName: "总部复核", order: 2, duty: "固定人员" }]);
    task.items[0].approvalStructureSnapshot.nodes = nodes;
    await harness.database.collection("sfa_task_instances").doc("task-1").set({ data: task });

    await harness.api.main({ action: "submitTask", taskId: "task-1", requestId: "submit-multi" });
    harness.asManager();
    const approvalId = harness.database.snapshot("sfa_approvals")[0]._id;
    const first = await harness.api.main({ action: "decideApproval", approvalId, productDecisions: [{ productRecordId: "product-1", decision: "qualified" }], requestId: "approve-node-1" });
    assert.deepStrictEqual(first, { ok: true, data: { status: "pending", nextNodeName: "总部复核" } });
    const pending = harness.database.snapshot("sfa_approvals")[0];
    assert.strictEqual(pending.currentReviewerUserId, "FixedUser");
    assert.strictEqual(pending.currentNodeRecordId, "node-2");
    assert.strictEqual(actualWecom.cellText(harness.smartSheet.snapshot("24_产品上样结果")[0], "审批状态"), "待审批");

    harness.asFixed();
    const final = await harness.api.main({ action: "decideApproval", approvalId, productDecisions: [{ productRecordId: "product-1", decision: "qualified" }], requestId: "approve-node-2" });
    assert.deepStrictEqual(final, { ok: true, data: { status: "approved" } });
    assert.strictEqual(harness.database.snapshot("sfa_task_instances")[0].status, "completed");
    assert.strictEqual(actualWecom.cellText(harness.smartSheet.snapshot("24_产品上样结果")[0], "审批状态"), "已通过");
    assert.strictEqual(harness.smartSheet.snapshot("07_审核记录").length, 3);
  } finally { harness.restore(); }
}

async function testPartialRejectLocksQualifiedAndAllowsNewProduct() {
  const harness = loadHarness();
  try {
    const task = harness.database.snapshot("sfa_task_instances")[0];
    task.items[0].samplingSnapshot.groups[0].minRequired = 2;
    task.items[0].samplingSnapshot.groups[0].products = [
      { productRecordId: "product-1", code: "DP1", name: "产品1", minPhotos: 1, maxPhotos: 3 },
      { productRecordId: "product-2", code: "DP2", name: "产品2", minPhotos: 1, maxPhotos: 3 },
      { productRecordId: "product-3", code: "DP3", name: "产品3", minPhotos: 1, maxPhotos: 3 },
    ];
    await harness.database.collection("sfa_task_instances").doc("task-1").set({ data: task });
    const draft = harness.database.snapshot("sfa_task_drafts")[0];
    draft.values = { "product-1": ["cloud://photo-1"], "product-2": ["cloud://photo-2"] };
    draft.smartSheetImageCache["cloud://photo-2"] = { id: "image-2", image_url: "https://doc/photo-2" };
    await harness.database.collection("sfa_task_drafts").doc("draft-1").set({ data: draft });

    await harness.api.main({ action: "submitTask", taskId: "task-1", requestId: "submit-partial-1" });
    harness.asManager();
    const firstApproval = harness.database.snapshot("sfa_approvals")[0];
    const rejected = await harness.api.main({ action: "decideApproval", approvalId: firstApproval._id, productDecisions: [
      { productRecordId: "product-1", decision: "qualified" },
      { productRecordId: "product-2", decision: "unqualified", reason: "请重拍正面" },
    ], requestId: "partial-reject" });
    assert.strictEqual(rejected.ok, true);
    const rejectedDraft = harness.database.snapshot("sfa_task_drafts")[0];
    assert.deepStrictEqual(rejectedDraft.samplingReview.qualifiedProductIds, ["product-1"]);
    assert.deepStrictEqual(rejectedDraft.values["product-1"], ["cloud://photo-1"]);
    assert.deepStrictEqual(rejectedDraft.values["product-2"], []);

    harness.asSales();
    const locked = await harness.api.main({ action: "saveItemDraft", taskId: "task-1", itemId: "item-1", values: { "product-1": ["cloud://tampered"], "product-2": ["cloud://photo-2-new"] } });
    assert.strictEqual(locked.code, "SAMPLING_QUALIFIED_PRODUCT_LOCKED");
    const completed = await harness.api.main({ action: "completeTaskItem", taskId: "task-1", itemId: "item-1", values: {
      "product-1": ["cloud://photo-1"], "product-2": ["cloud://photo-2-new"], "product-3": ["cloud://photo-3-new"],
    }, requestId: "complete-partial-2" });
    assert.strictEqual(completed.ok, true);
    await harness.api.main({ action: "submitTask", taskId: "task-1", requestId: "submit-partial-2" });
    const rows = harness.smartSheet.snapshot("24_产品上样结果");
    assert.strictEqual(rows.length, 3, "历史合格不重复写，整改产品覆盖，新产品新增");
    const secondApproval = harness.database.snapshot("sfa_approvals").find((entry) => entry.itemSubmissionRound === 2);
    assert.deepStrictEqual(secondApproval.reviewProductIds.sort(), ["product-2", "product-3"]);
    assert.deepStrictEqual(secondApproval.inheritedQualifiedProductIds, ["product-1"]);

    harness.asManager();
    const approved = await harness.api.main({ action: "decideApproval", approvalId: secondApproval._id, productDecisions: [
      { productRecordId: "product-2", decision: "qualified" }, { productRecordId: "product-3", decision: "qualified" },
    ], requestId: "partial-final" });
    assert.strictEqual(approved.ok, true);
    assert.strictEqual(harness.database.snapshot("sfa_task_instances")[0].status, "completed");
  } finally { harness.restore(); }
}

async function testAdminCanResumeFailedSubmissionWithoutDuplicateResults() {
  const harness = loadHarness();
  try {
    harness.smartSheet.failNextAdd("24_产品上样结果");
    const failed = await harness.api.main({ action: "submitTask", taskId: "task-1", requestId: "submit-recover" });
    assert.strictEqual(failed.ok, false);
    assert.match(failed.message, /模拟智能表格新增失败/);
    assert.strictEqual(harness.smartSheet.snapshot("24_产品上样结果").length, 0);
    const ledger = harness.database.snapshot("sfa_idempotency_records")[0];
    assert.strictEqual(ledger.status, "processing");
    assert.strictEqual(ledger.phase, "images_ready");

    const spoofed = await harness.api.main({ action: "submitTask", taskId: "task-1", requestId: "submit-recover", _adminRetryOperationId: ledger._id });
    assert.strictEqual(spoofed.code, "OPERATION_IN_PROGRESS", "客户端伪造内部续跑字段不得取得操作所有权");

    harness.smartSheet.addRawRecord("08_人员主档", { record_id: "person-manager-b", values: { "企微人员ID": text("ManagerB"), "姓名": text("产品经理乙") } });
    harness.smartSheet.updateRawRecord("20_大区主档", "region-1", { "产品经理": ["person-manager-b"] });

    harness.asAdmin();
    const recovered = await harness.api.main({ action: "retrySamplingSubmission", taskId: "task-1", requestId: "submit-recover" });
    assert.deepStrictEqual(recovered, { ok: true, data: { status: "review", approvalCount: 1 } });
    assert.strictEqual(harness.smartSheet.snapshot("24_产品上样结果").length, 1, "管理员续跑不得生成重复结果");
    assert.strictEqual(harness.smartSheet.snapshot("07_审核记录").length, 1);
    assert.strictEqual(harness.database.snapshot("sfa_approvals")[0].currentReviewerUserId, "ManagerA", "续跑必须复用首次提交已解析的审核人");
    const completedLedger = harness.database.snapshot("sfa_idempotency_records")[0];
    assert.strictEqual(completedLedger.status, "completed");
    assert.strictEqual(completedLedger.retryCount, 1);
  } finally { harness.restore(); }
}

async function testAdminCanFinalizeLedgerAfterBusinessStateCompleted() {
  const harness = loadHarness();
  try {
    await harness.api.main({ action: "submitTask", taskId: "task-1", requestId: "submit-finalize-ledger" });
    const ledger = harness.database.snapshot("sfa_idempotency_records")[0];
    await harness.database.collection("sfa_idempotency_records").doc(ledger._id).update({ data: { status: "processing", phase: "parent_state_ready", response: null } });
    const writeCount = harness.smartSheet.writes.length;

    harness.asAdmin();
    const recovered = await harness.api.main({ action: "retrySamplingSubmission", taskId: "task-1", requestId: "submit-finalize-ledger" });
    assert.deepStrictEqual(recovered, { ok: true, data: { status: "review", approvalCount: 1, recoveredFromPhase: "parent_state_ready" } });
    assert.strictEqual(harness.smartSheet.writes.length, writeCount, "业务状态已完成时只补齐账本，不应重写智能表格");
    assert.strictEqual(harness.database.snapshot("sfa_idempotency_records")[0].status, "completed");
  } finally { harness.restore(); }
}

async function testCompletedSamplingItemCanBeOverwrittenBeforeParentSubmission() {
  const harness = loadHarness();
  try {
    const form = await harness.api.main({ action: "getSamplingForm", taskId: "task-1", itemId: "item-1" });
    assert.strictEqual(form.ok, true);
    assert.strictEqual(form.data.readOnly, false, "父任务提交前已完成的产品上样仍应可编辑");

    const draft = await harness.api.main({ action: "saveItemDraft", taskId: "task-1", itemId: "item-1", values: { "product-1": ["cloud://photo-presynced"] }, preSyncImages: true });
    assert.strictEqual(draft.ok, true);
    assert.strictEqual(draft.data.completed, false);
    assert.strictEqual(draft.data.imagePreSync.status, "ready");
    assert.strictEqual(harness.smartSheet.imageUploadCount, 1);
    const editingTask = await harness.api.main({ action: "getTask", taskId: "task-1" });
    assert.strictEqual(editingTask.data.canSubmit, false);

    const saved = await harness.api.main({ action: "completeTaskItem", taskId: "task-1", itemId: "item-1", values: { "product-1": ["cloud://photo-presynced"] }, requestId: "overwrite-sampling" });
    assert.strictEqual(saved.ok, true);
    assert.strictEqual(harness.smartSheet.imageUploadCount, 1, "正式保存应复用自动保存阶段的企业微信图片缓存");
    const completedTask = await harness.api.main({ action: "getTask", taskId: "task-1" });
    assert.strictEqual(completedTask.data.canSubmit, true);
    assert.strictEqual(completedTask.data.items[0].editable, true);
  } finally { harness.restore(); }
}

Promise.resolve().then(testCompletedSamplingItemCanBeOverwrittenBeforeParentSubmission).then(testFullSamplingApprovalLoop).then(testRejectRectifyResubmitOverwritesCurrentResult).then(testNextNodeResolvesReviewerWhenNodeStarts).then(testPartialRejectLocksQualifiedAndAllowsNewProduct).then(testAdminCanResumeFailedSubmissionWithoutDuplicateResults).then(testAdminCanFinalizeLedgerAfterBusinessStateCompleted).then(() => process.stdout.write("product sampling e2e tests passed\n")).catch((error) => { console.error(error); process.exitCode = 1; });
