const { cellText, cellBoolean, cellNumber, cellReferences, cellUsers, cellLocation } = require("./wecom");
const { createSamplingSnapshot } = require("./sampling-snapshot");
const { freezeApprovalStructure } = require("./reviewer-router");
const { allowedDistanceMeters } = require("./task-runtime-policy");

const SHEETS = Object.freeze({
  taskTypes: "01_任务类型",
  publications: "04_任务发布",
  taskItems: "05_任务项设置",
  executions: "06_任务执行",
  people: "08_人员主档",
  stores: "09_门店主档",
  itemExecutions: "16_任务项执行",
});

function safeId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function taskInstanceId(sourceTaskRecordId, storeRecordId) {
  return `task_${safeId(sourceTaskRecordId)}_${safeId(storeRecordId)}`;
}

function toIso(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "";
  return new Date(milliseconds).toISOString();
}

function selectedText(record, title) {
  return cellText(record, title).trim();
}

function isConfirmedPublication(record) {
  return cellBoolean(record, "确认发布") && selectedText(record, "发布状态") === "已发布";
}

function executionRecordMap(records) {
  const result = new Map();
  for (const record of records || []) {
    const sourceTaskRecordId = cellReferences(record, "来源任务")[0];
    const storeRecordId = cellReferences(record, "执行门店")[0];
    if (sourceTaskRecordId && storeRecordId) {
      const key = `${sourceTaskRecordId}:${storeRecordId}`;
      if (result.has(key)) {
        const error = new Error(`06_任务执行存在重复记录：${key}`);
        error.code = "EXECUTION_RECORD_DUPLICATE_EXISTING";
        throw error;
      }
      result.set(key, record.record_id);
    }
  }
  return result;
}

function executionRecordValues(instance) {
  return {
    "执行记录编号": [{ type: "text", text: instance.taskNumber }],
    "来源任务": [instance.sourceTaskRecordId],
    "执行门店": [instance.storeRecordId],
    "执行人员": instance.executorRecordIds,
    "开始时间": String(Date.parse(instance.startAt)),
    "截止时间": String(Date.parse(instance.deadlineAt)),
    "当前状态": [{ text: "待执行" }],
  };
}

function personSnapshot(record) {
  const user = cellUsers(record, "企业微信人员")[0];
  return {
    recordId: record.record_id,
    userId: selectedText(record, "企业微信账号ID（自动）") || user?.userId || "",
    name: selectedText(record, "姓名（自动）") || user?.name || "",
  };
}

function storeSnapshot(record) {
  return {
    recordId: record.record_id,
    code: selectedText(record, "门店编码"),
    name: selectedText(record, "门店名称"),
    operationCenter: selectedText(record, "运营中心"),
    salesRegion: selectedText(record, "销售区域"),
    regionRecordIds: cellReferences(record, "所属大区"),
    location: cellLocation(record, "门店位置"),
  };
}

function taskItemSnapshot(schema, samplingSnapshot, approvalConfiguration) {
  const approvalStructureSnapshot = schema.requiresApproval
    ? freezeApprovalStructure(approvalConfiguration, schema.approvalTemplateIds || [], schema.itemName)
    : undefined;
  return {
    id: schema.itemId,
    configItemId: schema.itemId,
    name: schema.itemName,
    renderer: schema.renderer === "产品上样" ? "sampling" : "dynamic",
    required: schema.required !== false,
    order: schema.order || 0,
    instructions: schema.instructions || "",
    status: "pending",
    requiresApproval: Boolean(schema.requiresApproval),
    approvalTemplateIds: schema.approvalTemplateIds || [],
    approvalTemplateCode: schema.requiresApproval ? ((schema.approvalTemplateIds || [])[0] || "CONFIGURED_APPROVAL") : "",
    smartSheetItemExecutionRecordId: "",
    itemExecutionKey: "",
    schemaSnapshot: schema,
    ...(samplingSnapshot ? { samplingSnapshot } : {}),
    ...(approvalStructureSnapshot ? { approvalStructureSnapshot } : {}),
  };
}

function publicationError(message, details = {}) {
  const error = new Error(message);
  error.code = "PUBLISH_VALIDATION_FAILED";
  error.details = details;
  return error;
}

function buildPublicationPlan({ publication, stores, people, taskTypes, schemas, executionRecords = [], samplingConfiguration, approvalConfiguration }) {
  const sourceTaskRecordId = publication.record_id;
  const name = selectedText(publication, "任务名称");
  const taskTypeRecordId = cellReferences(publication, "任务类型")[0];
  const storeRecordIds = cellReferences(publication, "任务门店");
  const personRecordIds = cellReferences(publication, "执行人员");
  const itemRecordIds = cellReferences(publication, "任务项");
  const productRuleRecordIds = cellReferences(publication, "产品规则");
  const startAt = toIso(selectedText(publication, "开始时间"));
  const deadlineAt = toIso(selectedText(publication, "截止时间"));
  const taskType = (taskTypes || []).find((item) => item.id === taskTypeRecordId);
  const storeById = new Map((stores || []).map((record) => [record.record_id, storeSnapshot(record)]));
  const personById = new Map((people || []).map((record) => [record.record_id, personSnapshot(record)]));
  const schemaById = new Map((schemas || []).filter((schema) => schema.status === "ready").map((schema) => [schema.itemId, schema]));
  const problems = [];

  if (!name) problems.push("任务名称不能为空");
  if (!taskType) problems.push("任务类型无效或尚未同步");
  if (!storeRecordIds.length) problems.push("至少选择一家任务门店");
  if (!personRecordIds.length) problems.push("至少选择一名执行人员");
  if (!itemRecordIds.length) problems.push("至少选择一个任务项");
  if (!startAt || !deadlineAt || Date.parse(deadlineAt) <= Date.parse(startAt)) problems.push("开始时间和截止时间无效");
  for (const storeId of storeRecordIds) {
    const store = storeById.get(storeId);
    if (!store?.name || !store?.code) problems.push(`门店主档不完整：${storeId}`);
    if (cellBoolean(publication, "需要定位") && !store?.location) problems.push(`门店缺少位置：${store?.name || storeId}`);
  }
  for (const personId of personRecordIds) {
    const person = personById.get(personId);
    if (!person?.userId) problems.push(`执行人员缺少企业微信账号ID：${personId}`);
  }
  for (const itemId of itemRecordIds) if (!schemaById.has(itemId)) problems.push(`任务项配置尚未就绪：${itemId}`);
  if (problems.length) throw publicationError(problems.join("；"), { problems });

  const executors = personRecordIds.map((id) => personById.get(id));
  const itemSchemas = itemRecordIds.map((id) => schemaById.get(id)).sort((a, b) => (a.order || 0) - (b.order || 0));
  const hasSamplingItem = itemSchemas.some((schema) => schema.renderer === "产品上样");
  const hasApprovalItem = itemSchemas.some((schema) => schema.requiresApproval);
  if (hasSamplingItem && !samplingConfiguration) throw publicationError("产品上样正式配置尚未读取，不能发布产品上样任务");
  if (hasSamplingItem && productRuleRecordIds.length !== 1) throw publicationError("包含产品上样任务项时，必须且只能选择一个产品规则", { productRuleRecordIds });
  if (hasApprovalItem && !approvalConfiguration) throw publicationError("审批模板和节点配置尚未读取，不能发布需要审批的任务");
  const requiredItemCount = itemSchemas.filter((schema) => schema.required !== false).length;
  const executionBySourceAndStore = executionRecordMap(executionRecords);
  const policyLabel = selectedText(publication, "超范围处理");
  const publishedAt = toIso(selectedText(publication, "发布时间")) || new Date().toISOString();

  return {
    sourceTaskRecordId,
    sourceUpdatedAt: toIso(publication.update_time),
    taskNumber: `RW-${safeId(sourceTaskRecordId)}`,
    taskTypeRecordId,
    taskTypeCode: taskType.code,
    taskTypeName: taskType.name,
    storeRecordIds,
    personRecordIds,
    itemRecordIds,
    instances: storeRecordIds.map((storeRecordId) => {
      const store = storeById.get(storeRecordId);
      const id = taskInstanceId(sourceTaskRecordId, storeRecordId);
      const samplingSnapshot = hasSamplingItem ? createSamplingSnapshot({ store, configuration: samplingConfiguration, productRuleRecordId: productRuleRecordIds[0], createdAt: publishedAt }) : undefined;
      return {
        id,
        sourceTaskRecordId,
        smartSheetExecutionRecordId: executionBySourceAndStore.get(`${sourceTaskRecordId}:${storeRecordId}`) || "",
        taskNumber: `ZX-${safeId(sourceTaskRecordId)}-${safeId(store.code)}`,
        taskType: taskType.code,
        taskTypeName: taskType.name,
        taskTypeRecordId,
        name,
        executionRequirement: selectedText(publication, "执行要求"),
        storeRecordId,
        storeName: store.name,
        storeCode: store.code,
        storeLocation: store.location,
        storeSnapshot: store,
        executorRecordIds: personRecordIds,
        executorUserIds: executors.map((person) => person.userId),
        executorNames: executors.map((person) => person.name || person.userId).join("、"),
        executorSnapshot: executors,
        startAt,
        deadlineAt,
        status: "pending",
        progress: 0,
        completedItemCount: 0,
        requiredItemCount,
        requiresLocation: cellBoolean(publication, "需要定位"),
        allowedDistanceMeters: allowedDistanceMeters(cellNumber(publication, "允许距离（米）")),
        outOfRangePolicy: policyLabel === "强制拦截" ? "block" : "warn",
        // Each store owns an independent item snapshot because 16_任务项执行
        // record IDs differ by parent execution record.
        items: itemSchemas.map((schema) => taskItemSnapshot(schema, schema.renderer === "产品上样" ? samplingSnapshot : undefined, approvalConfiguration)),
        publishedAt,
        createdAt: new Date().toISOString(),
      };
    }),
  };
}

module.exports = { SHEETS, safeId, taskInstanceId, isConfirmedPublication, executionRecordMap, executionRecordValues, personSnapshot, storeSnapshot, taskItemSnapshot, buildPublicationPlan };
