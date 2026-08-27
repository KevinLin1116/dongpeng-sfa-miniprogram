const assert = require("assert");
const Module = require("module");
const path = require("path");

const INDEX_PATH = path.resolve(__dirname, "../index.js");
const actualWecom = require("../wecom");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function matches(record, where) {
  return Object.entries(where || {}).every(([key, value]) => record[key] === value);
}

function memoryDatabase(seed = {}) {
  const tables = new Map(Object.entries(seed).map(([name, records]) => [name, clone(records)]));
  let sequence = 0;

  function rows(name) {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  }

  function collection(name) {
    const state = { where: {}, skip: 0, limit: Infinity };
    const query = {
      where(where) { state.where = where || {}; return query; },
      skip(value) { state.skip = Number(value) || 0; return query; },
      limit(value) { state.limit = Number(value) || Infinity; return query; },
      async get() { return { data: clone(rows(name).filter((record) => matches(record, state.where)).slice(state.skip, state.skip + state.limit)) }; },
      async add({ data }) {
        const record = { ...clone(data) };
        record._id = record._id || `${name}-${++sequence}`;
        if (rows(name).some((item) => item._id === record._id)) throw new Error("document already exists");
        rows(name).push(record);
        return { _id: record._id };
      },
      async remove() {
        const kept = rows(name).filter((record) => !matches(record, state.where));
        const removed = rows(name).length - kept.length;
        tables.set(name, kept);
        return { stats: { removed } };
      },
      async update({ data }) {
        let updated = 0;
        rows(name).forEach((record, index) => {
          if (!matches(record, state.where)) return;
          rows(name)[index] = { ...record, ...clone(data) };
          updated += 1;
        });
        return { stats: { updated } };
      },
      doc(id) {
        return {
          async get() {
            const record = rows(name).find((item) => item._id === id);
            if (!record) throw new Error("document not found");
            return { data: clone(record) };
          },
          async update({ data }) {
            const index = rows(name).findIndex((item) => item._id === id);
            if (index < 0) throw new Error("document not found");
            rows(name)[index] = { ...rows(name)[index], ...clone(data) };
            return { stats: { updated: 1 } };
          },
          async set({ data }) {
            const index = rows(name).findIndex((item) => item._id === id);
            const record = { ...clone(data), _id: id };
            if (index < 0) rows(name).push(record);
            else rows(name)[index] = record;
            return { _id: id };
          },
          async remove() {
            const index = rows(name).findIndex((item) => item._id === id);
            if (index >= 0) rows(name).splice(index, 1);
            return { stats: { removed: index >= 0 ? 1 : 0 } };
          },
        };
      },
    };
    return query;
  }

  return {
    collection,
    async createCollection(name) { rows(name); return {}; },
    snapshot(name) { return clone(rows(name)); },
  };
}

const field = (title, type, extra = {}) => ({ field_title: title, field_type: type, ...extra });

function fakeSmartSheet() {
  const writes = [];
  let failNextItemExecutionWrite = false;
  const sheets = [
    { title: "05_任务项设置", sheet_id: "sheet-05" },
    { title: "06_任务执行", sheet_id: "sheet-06" },
    { title: "16_任务项执行", sheet_id: "sheet-16" },
    { title: "12_物料打卡结果", sheet_id: "sheet-12" },
  ];
  const itemExecutionFields = [
    field("任务项执行编号", "FIELD_TYPE_TEXT"),
    field("所属执行记录", "FIELD_TYPE_REFERENCE", { property_reference: { sub_id: "sheet-06", filed_id: "field-06-primary" } }),
    field("来源任务项", "FIELD_TYPE_REFERENCE", { property_reference: { sub_id: "sheet-05", filed_id: "field-05-primary" } }),
    field("执行状态", "FIELD_TYPE_SINGLE_SELECT", { property_single_select: { is_quick_add: false, options: ["待执行", "进行中", "已完成", "待整改"].map((text) => ({ text })) } }),
    field("审批状态", "FIELD_TYPE_SINGLE_SELECT", { property_single_select: { is_quick_add: false, options: ["无需审批", "待审批", "已通过", "已退回"].map((text) => ({ text })) } }),
    field("最新退回原因", "FIELD_TYPE_TEXT"),
    field("允许修改", "FIELD_TYPE_CHECKBOX"),
  ];
  const parentFields = [
    field("执行记录编号", "FIELD_TYPE_TEXT", { field_id: "field-06-primary" }),
    field("当前状态", "FIELD_TYPE_SINGLE_SELECT"),
    field("已完成项数", "FIELD_TYPE_NUMBER"),
    field("必做项总数", "FIELD_TYPE_NUMBER"),
    field("审核状态", "FIELD_TYPE_SINGLE_SELECT"),
  ];
  return {
    configured: true,
    docId: "test-doc",
    writes,
    failOneItemExecutionWrite() { failNextItemExecutionWrite = true; },
    get failurePending() { return failNextItemExecutionWrite; },
    async getSheets() { return sheets; },
    async getFields(sheetId) {
      if (sheetId === "sheet-05") return [field("任务项名称", "FIELD_TYPE_TEXT", { field_id: "field-05-primary" })];
      if (sheetId === "sheet-06") return parentFields;
      if (sheetId === "sheet-12") return [
        field("任务项执行", "FIELD_TYPE_REFERENCE"),
        field("任务项", "FIELD_TYPE_REFERENCE"),
        field("说明", "FIELD_TYPE_TEXT"),
        field("保存状态", "FIELD_TYPE_SINGLE_SELECT"),
      ];
      if (sheetId === "sheet-16") return itemExecutionFields;
      return [];
    },
    async getRecords(sheetId) {
      if (sheetId === "sheet-12") return [{ record_id: "result-1", values: { "任务项执行": ["item-execution-1"] } }];
      return [];
    },
    async updateRecords(sheetId, records) {
      if (sheetId === "sheet-16" && failNextItemExecutionWrite) {
        failNextItemExecutionWrite = false;
        const error = new Error("模拟16外部写入失败");
        error.code = "FAKE_EXTERNAL_WRITE_FAILED";
        throw error;
      }
      writes.push({ sheetId, records: clone(records) });
      return { errcode: 0 };
    },
    async addRecords(sheetId) {
      if (sheetId === "sheet-12") return { records: [{ record_id: "result-1" }] };
      throw new Error("测试数据应复用已有16记录");
    },
  };
}

function baseSeed({ includeTasks = true, includeApprovals = true, accountOverrides = {} } = {}) {
  return {
    sfa_account_bindings: [{
      _id: "account-reviewer",
      openId: "openid-reviewer",
      wecomUserId: "ReviewerA",
      name: "审核人甲",
      roles: ["任务审核者"],
      dataScope: "self",
      status: "active",
      ...accountOverrides,
    }],
    sfa_task_instances: includeTasks ? [{
      _id: "task-1",
      id: "task-1",
      sourceTaskRecordId: "publication-1",
      smartSheetExecutionRecordId: "execution-1",
      name: "待审核门店任务",
      storeName: "测试门店",
      executorUserIds: ["SalesA"],
      status: "review",
      progress: 100,
      completedItemCount: 1,
      requiredItemCount: 1,
      items: [{
        id: "item-1",
        configItemId: "item-record-1",
        name: "待审核任务项",
        required: true,
        status: "review",
        requiresApproval: true,
        smartSheetItemExecutionRecordId: "item-execution-1",
      }],
    }] : [],
    sfa_task_drafts: includeTasks ? [{ _id: "draft-1", taskId: "task-1", itemId: "item-1", completed: true, values: { note: "已完成" } }] : [],
    sfa_approvals: includeApprovals ? [{
      _id: "approval-1",
      taskId: "task-1",
      taskName: "待审核门店任务",
      itemId: "item-1",
      itemName: "待审核任务项",
      status: "pending",
      statusLabel: "待审核",
      currentReviewerUserId: "ReviewerA",
      submitterUserId: "SalesA",
      submitterName: "业务员甲",
    }] : [],
    sfa_runtime_logs: [],
    sfa_idempotency_records: [],
    sfa_cache: [],
  };
}

function productionItem() {
  return {
    id: "item-1",
    configItemId: "item-record-1",
    name: "动态检查",
    renderer: "dynamic",
    required: true,
    status: "pending",
    smartSheetItemExecutionRecordId: "item-execution-1",
    schemaSnapshot: {
      itemId: "item-record-1",
      itemName: "动态检查",
      status: "ready",
      renderer: "信息填写",
      resultSheetTitle: "12_物料打卡结果",
      resultRelationField: "任务项执行",
      fields: [{ key: "note", label: "说明", inputType: "text", required: true }],
    },
  };
}

function loadApi({ seed, smartSheet = fakeSmartSheet() }) {
  const database = memoryDatabase(seed);
  const originalLoad = Module._load;
  const previousEnvironment = {
    corpId: process.env.SFA_WECOM_CORP_ID,
    secret: process.env.SFA_WECOM_SECRET,
    docId: process.env.SFA_SMART_SHEET_DOC_ID,
    fixtureFlag: process.env.SFA_ALLOW_DEV_FIXTURES,
  };
  process.env.SFA_WECOM_CORP_ID = "test-corp";
  process.env.SFA_WECOM_SECRET = "test-secret";
  process.env.SFA_SMART_SHEET_DOC_ID = "test-doc";
  delete process.env.SFA_ALLOW_DEV_FIXTURES;

  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database: () => database,
    getWXContext: () => ({ OPENID: "openid-reviewer" }),
  };
  class FakeSmartSheetClient { constructor() { return smartSheet; } }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "wx-server-sdk") return cloud;
    if (request === "./wecom" && parent?.filename === INDEX_PATH) return { ...actualWecom, SmartSheetClient: FakeSmartSheetClient };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[INDEX_PATH];
  let api;
  try { api = require(INDEX_PATH); }
  finally { Module._load = originalLoad; }

  function restore() {
    delete require.cache[INDEX_PATH];
    const restoreOne = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
    restoreOne("SFA_WECOM_CORP_ID", previousEnvironment.corpId);
    restoreOne("SFA_WECOM_SECRET", previousEnvironment.secret);
    restoreOne("SFA_SMART_SHEET_DOC_ID", previousEnvironment.docId);
    restoreOne("SFA_ALLOW_DEV_FIXTURES", previousEnvironment.fixtureFlag);
  }
  return { api, database, smartSheet, restore };
}

async function testReviewerCanReadOwnPendingApproval() {
  const harness = loadApi({ seed: baseSeed() });
  try {
    const result = await harness.api.main({ action: "listApprovals", status: "pending" });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.data.map((approval) => approval._id), ["approval-1"]);

    const detail = await harness.api.main({ action: "getApproval", approvalId: "approval-1" });
    assert.strictEqual(detail.ok, true);
    assert.strictEqual(detail.data.canDecide, true);
  } finally { harness.restore(); }
}

async function testProductionNeverFallsBackToFixtures() {
  const harness = loadApi({ seed: baseSeed({
    includeTasks: false,
    includeApprovals: false,
    accountOverrides: { wecomUserId: "LinWenKai", roles: ["管理员"], dataScope: "all" },
  }) });
  try {
    const tasks = await harness.api.main({ action: "listTasks" });
    const approvals = await harness.api.main({ action: "listApprovals", status: "pending" });
    assert.strictEqual(tasks.ok, true);
    assert.strictEqual(approvals.ok, true);
    assert.deepStrictEqual(
      { taskIds: tasks.data.map((task) => task.id), approvalIds: approvals.data.map((approval) => approval._id || approval.id) },
      { taskIds: [], approvalIds: [] },
      "生产空集合必须返回空，不得显示 fixtures.tasks 或 fixtures.approvals",
    );
  } finally { harness.restore(); }
}

async function testRejectedApprovalRemainsRetryableAfterExternalWriteFailure() {
  const smartSheet = fakeSmartSheet();
  smartSheet.failOneItemExecutionWrite();
  const harness = loadApi({ seed: baseSeed(), smartSheet });
  try {
    const first = await harness.api.main({ action: "decideApproval", approvalId: "approval-1", decision: "rejected", reason: "照片不清晰", requestId: "reject-1" });
    assert.strictEqual(first.ok, false);
    assert.strictEqual(first.code, "FAKE_EXTERNAL_WRITE_FAILED", "审核人必须能读到非本人执行的待审任务，并到达外部写入步骤");
    assert.strictEqual(smartSheet.failurePending, false, "首次调用应真实触发一次外部写失败");
    assert.strictEqual(harness.database.snapshot("sfa_approvals")[0].status, "pending", "外部写失败后审批必须保持待处理，以便重试");
    assert.strictEqual(harness.database.snapshot("sfa_task_instances")[0].status, "review");
    assert.strictEqual(harness.database.snapshot("sfa_task_drafts")[0].completed, true);

    const retried = await harness.api.main({ action: "decideApproval", approvalId: "approval-1", decision: "rejected", reason: "照片不清晰", requestId: "reject-1" });
    assert.strictEqual(retried.ok, false);
    assert.strictEqual(retried.code, "OPERATION_IN_PROGRESS", "外部结果未知时不得自动重放审批，必须进入人工对账");
    assert.strictEqual(harness.database.snapshot("sfa_approvals")[0].status, "pending");
    assert.strictEqual(harness.database.snapshot("sfa_task_instances")[0].status, "review");
    assert.strictEqual(harness.database.snapshot("sfa_task_drafts")[0].completed, true);
  } finally { harness.restore(); }
}

async function testValidationFailureDoesNotLeaveCompleteLock() {
  const seed = baseSeed({ includeApprovals: false });
  seed.sfa_task_instances[0].status = "pending";
  seed.sfa_task_instances[0].executorUserIds = ["ReviewerA"];
  seed.sfa_task_instances[0].items = [productionItem()];
  seed.sfa_task_drafts = [];
  const harness = loadApi({ seed });
  try {
    const failed = await harness.api.main({ action: "completeTaskItem", taskId: "task-1", itemId: "item-1", values: {}, requestId: "complete-invalid" });
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.code, "VALIDATION_FAILED");
    assert.deepStrictEqual(harness.database.snapshot("sfa_idempotency_records"), [], "纯校验失败不得遗留processing锁");
  } finally { harness.restore(); }
}

async function testAutosaveCanOverwriteCompletedDraftBeforeTaskSubmission() {
  const seed = baseSeed({ includeApprovals: false });
  seed.sfa_task_instances[0].status = "active";
  seed.sfa_task_instances[0].executorUserIds = ["ReviewerA"];
  seed.sfa_task_instances[0].items = [productionItem()];
  seed.sfa_task_drafts = [{ _id: "draft-1", taskId: "task-1", itemId: "item-1", completed: true, completionRound: 1, pendingCompleteOperationId: "", updatedAt: "2026-08-19T08:00:00.000Z", values: { note: "最终值" } }];
  const harness = loadApi({ seed });
  try {
    const result = await harness.api.main({ action: "saveItemDraft", taskId: "task-1", itemId: "item-1", values: { note: "覆盖后的值" } });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(harness.database.snapshot("sfa_task_drafts")[0].completed, false);
    assert.deepStrictEqual(harness.database.snapshot("sfa_task_drafts")[0].values, { note: "覆盖后的值" });
    assert.strictEqual(harness.database.snapshot("sfa_task_instances")[0].completedItemCount, 0);
    assert.strictEqual(harness.smartSheet.writes.length, 0, "自动保存不应同步等待企业微信智能表格写入");
    const task = await harness.api.main({ action: "getTask", taskId: "task-1" });
    assert.strictEqual(task.data.items[0].status, "active");
    assert.strictEqual(task.data.canSubmit, false);
  } finally { harness.restore(); }
}

async function testCompletedItemCanBeSavedAgainBeforeTaskSubmission() {
  const seed = baseSeed({ includeApprovals: false });
  seed.sfa_task_instances[0].status = "active";
  seed.sfa_task_instances[0].executorUserIds = ["ReviewerA"];
  seed.sfa_task_instances[0].items = [productionItem()];
  seed.sfa_task_drafts = [{ _id: "draft-1", taskId: "task-1", itemId: "item-1", completed: true, completionRound: 1, values: { note: "第一次保存" } }];
  const harness = loadApi({ seed });
  try {
    const result = await harness.api.main({ action: "completeTaskItem", taskId: "task-1", itemId: "item-1", values: { note: "第二次保存" }, requestId: "complete-round-2" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.completionRound, 2);
    assert.deepStrictEqual(harness.database.snapshot("sfa_task_drafts")[0].values, { note: "第二次保存" });
    assert(harness.database.snapshot("sfa_idempotency_records").some((entry) => entry._id === "complete_task-1_item-1_2" && entry.status === "completed"));
  } finally { harness.restore(); }
}

async function testAutosaveCannotOverwriteAfterTaskSubmission() {
  const seed = baseSeed({ includeApprovals: false });
  seed.sfa_task_instances[0].status = "review";
  seed.sfa_task_instances[0].executorUserIds = ["ReviewerA"];
  seed.sfa_task_instances[0].items = [productionItem()];
  seed.sfa_task_drafts = [{ _id: "draft-1", taskId: "task-1", itemId: "item-1", completed: true, completionRound: 1, values: { note: "已提交值" } }];
  const harness = loadApi({ seed });
  try {
    const result = await harness.api.main({ action: "saveItemDraft", taskId: "task-1", itemId: "item-1", values: { note: "不允许覆盖" } });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "TASK_LOCKED");
    assert.deepStrictEqual(harness.database.snapshot("sfa_task_drafts")[0].values, { note: "已提交值" });
  } finally { harness.restore(); }
}

async function testRectificationCompletionUsesNextRound() {
  const seed = baseSeed({ includeApprovals: false });
  seed.sfa_task_instances[0].status = "rectify";
  seed.sfa_task_instances[0].executorUserIds = ["ReviewerA"];
  seed.sfa_task_instances[0].items = [productionItem()];
  seed.sfa_task_drafts = [{ _id: "draft-1", taskId: "task-1", itemId: "item-1", completed: false, completionRound: 1, rectificationPending: true, rejectionReason: "请整改", values: { note: "旧值" } }];
  seed.sfa_idempotency_records = [{ _id: "complete_task-1_item-1_1", action: "completeTaskItem", status: "completed", response: { completionRound: 1 } }];
  const harness = loadApi({ seed });
  try {
    const result = await harness.api.main({ action: "completeTaskItem", taskId: "task-1", itemId: "item-1", values: { note: "整改后" }, requestId: "complete-round-2" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.completionRound, 2);
    assert(harness.database.snapshot("sfa_idempotency_records").some((entry) => entry._id === "complete_task-1_item-1_2" && entry.status === "completed"));
  } finally { harness.restore(); }
}

async function testConcurrentCreateOnlyClaimHasSingleWinner() {
  const seed = baseSeed({ includeApprovals: false });
  seed.sfa_task_instances[0].status = "active";
  seed.sfa_task_instances[0].executorUserIds = ["ReviewerA"];
  seed.sfa_task_instances[0].items = [productionItem()];
  seed.sfa_task_drafts = [];
  const harness = loadApi({ seed });
  try {
    const event = { action: "completeTaskItem", taskId: "task-1", itemId: "item-1", values: { note: "并发完成" }, requestId: "complete-concurrent" };
    const results = await Promise.all([harness.api.main(event), harness.api.main(event)]);
    assert.strictEqual(results.filter((result) => result.ok).length, 1, "同一轮并发只能一个调用取得执行权");
    assert.strictEqual(results.filter((result) => result.code === "OPERATION_IN_PROGRESS").length, 1);
    assert.strictEqual(harness.database.snapshot("sfa_idempotency_records").filter((entry) => entry._id === "complete_task-1_item-1_1").length, 1);
  } finally { harness.restore(); }
}

async function testCompletedRectificationItemCanBeSubmittedAgain() {
  const seed = baseSeed({ includeApprovals: false });
  seed.sfa_task_instances[0].status = "rectify";
  seed.sfa_task_instances[0].executorUserIds = ["ReviewerA"];
  seed.sfa_task_instances[0].items = [productionItem()];
  seed.sfa_task_drafts = [{ _id: "draft-1", taskId: "task-1", itemId: "item-1", completed: true, completionRound: 2, rectificationPending: true, rejectionReason: "请整改", values: { note: "整改后" } }];
  const harness = loadApi({ seed });
  try {
    const task = await harness.api.main({ action: "getTask", taskId: "task-1" });
    assert.strictEqual(task.ok, true);
    assert.strictEqual(task.data.items[0].status, "completed");
    assert.strictEqual(task.data.canSubmit, true, "整改项再次完成后必须允许重提");
  } finally { harness.restore(); }
}

async function testCompletedTaskFormsAreReadOnly() {
  const seed = baseSeed({ includeApprovals: false });
  seed.sfa_task_instances[0].status = "completed";
  seed.sfa_task_instances[0].executorUserIds = ["ReviewerA"];
  seed.sfa_task_instances[0].items = [{ ...productionItem(), status: "completed" }];
  seed.sfa_task_drafts = [{ _id: "draft-1", taskId: "task-1", itemId: "item-1", completed: true, completionRound: 1, values: { note: "最终结果" } }];
  const harness = loadApi({ seed });
  try {
    const task = await harness.api.main({ action: "getTask", taskId: "task-1" });
    assert.strictEqual(task.ok, true);
    assert.strictEqual(task.data.readOnly, true);
    assert.strictEqual(task.data.items[0].editable, false);

    const form = await harness.api.main({ action: "getTaskItemForm", taskId: "task-1", itemId: "item-1" });
    assert.strictEqual(form.ok, true);
    assert.strictEqual(form.data.readOnly, true);
    assert.strictEqual(form.data.item.editable, false);
    assert.deepStrictEqual(form.data.values, { note: "最终结果" });
  } finally { harness.restore(); }
}

async function testMissingApprovalItemCannotCompleteParentTask() {
  const seed = baseSeed();
  seed.sfa_task_instances[0].items.push({ ...productionItem(), id: "item-2", configItemId: "item-record-2", name: "第二个审批项", status: "review", requiresApproval: true });
  const harness = loadApi({ seed });
  try {
    const result = await harness.api.main({ action: "decideApproval", approvalId: "approval-1", decision: "approved", requestId: "approve-one-of-two" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(harness.database.snapshot("sfa_task_instances")[0].status, "review", "缺少另一任务项审批记录时父任务不能完成");
  } finally { harness.restore(); }
}

async function main() {
  const tests = [
    testReviewerCanReadOwnPendingApproval,
    testProductionNeverFallsBackToFixtures,
    testRejectedApprovalRemainsRetryableAfterExternalWriteFailure,
    testValidationFailureDoesNotLeaveCompleteLock,
    testAutosaveCanOverwriteCompletedDraftBeforeTaskSubmission,
    testCompletedItemCanBeSavedAgainBeforeTaskSubmission,
    testAutosaveCannotOverwriteAfterTaskSubmission,
    testRectificationCompletionUsesNextRound,
    testConcurrentCreateOnlyClaimHasSingleWinner,
    testCompletedRectificationItemCanBeSubmittedAgain,
    testCompletedTaskFormsAreReadOnly,
    testMissingApprovalItemCannotCompleteParentTask,
  ];
  const failures = [];
  for (const test of tests) {
    try {
      await test();
      process.stdout.write(`PASS ${test.name}\n`);
    } catch (error) {
      failures.push({ test: test.name, error });
      process.stderr.write(`FAIL ${test.name}: ${error.message}\n`);
    }
  }
  if (failures.length) {
    const error = new Error(`${failures.length} approval resilience test(s) failed`);
    error.failures = failures;
    throw error;
  }
  process.stdout.write("approval resilience tests passed\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
