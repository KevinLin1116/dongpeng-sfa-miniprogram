const ITEM_EXECUTION_SHEET = "16_任务项执行";
const MAX_BATCH_SIZE = 500;

const ITEM_EXECUTION_STATUS_LABELS = Object.freeze({
  pending: "待执行",
  active: "执行中",
  review: "待复核",
  rectify: "待整改",
  completed: "已完成",
});

const STATUS_ALIASES = Object.freeze({
  pending: "pending",
  "待执行": "pending",
  active: "active",
  in_progress: "active",
  "执行中": "active",
  "进行中": "active",
  review: "review",
  pending_review: "review",
  "待复核": "review",
  rectify: "rectify",
  rejected: "rectify",
  "待整改": "rectify",
  completed: "completed",
  complete: "completed",
  done: "completed",
  "已完成": "completed",
});

function taskItemExecutionError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function requiredText(value, label, details = {}) {
  const text = String(value || "").trim();
  if (!text) throw taskItemExecutionError("TASK_ITEM_EXECUTION_INVALID", `${label}不能为空`, details);
  return text;
}

function normalizeItemExecutionStatus(value) {
  const input = String(value || "pending").trim();
  const status = STATUS_ALIASES[input];
  if (!status) {
    throw taskItemExecutionError(
      "TASK_ITEM_EXECUTION_STATUS_INVALID",
      `不支持的任务项执行状态：${input || "（空）"}`,
      { status: input, supported: Object.keys(ITEM_EXECUTION_STATUS_LABELS) },
    );
  }
  return status;
}

function itemExecutionStatusLabel(value) {
  return ITEM_EXECUTION_STATUS_LABELS[normalizeItemExecutionStatus(value)];
}

function itemExecutionKey(parentExecutionRecordId, taskItemRecordId) {
  return `${requiredText(parentExecutionRecordId, "父执行记录ID")}:${requiredText(taskItemRecordId, "任务项记录ID")}`;
}

function parentRecordId(parent) {
  return parent && (parent.smartSheetExecutionRecordId || parent.executionRecordId || parent.recordId);
}

function taskItemRecordId(item) {
  return item && (item.configItemId || item.taskItemRecordId || item.itemId || item.id);
}

function buildTaskItemExecution(parent, item) {
  const executionRecordId = requiredText(parentRecordId(parent), "父执行记录ID", { parent });
  const itemRecordId = requiredText(taskItemRecordId(item), "任务项记录ID", { executionRecordId, item });
  const schema = item.schemaSnapshot || {};
  const status = normalizeItemExecutionStatus(item.status || "pending");
  const approvalTemplateRecordIds = Array.from(new Set(
    (item.approvalTemplateIds || schema.approvalTemplateIds || []).map((value) => String(value || "").trim()).filter(Boolean),
  ));

  return {
    key: itemExecutionKey(executionRecordId, itemRecordId),
    parentExecutionRecordId: executionRecordId,
    taskItemRecordId: itemRecordId,
    taskItemName: String(item.name || schema.itemName || "").trim(),
    status,
    statusLabel: ITEM_EXECUTION_STATUS_LABELS[status],
    required: item.required !== false,
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : 0,
    resultSheetTitle: String(item.resultSheetTitle || schema.resultSheetTitle || "").trim(),
    requiresApproval: Boolean(item.requiresApproval || schema.requiresApproval),
    approvalTemplateRecordIds,
  };
}

function buildDesiredTaskItemExecutions(parentExecutions) {
  if (!Array.isArray(parentExecutions)) {
    throw taskItemExecutionError("TASK_ITEM_EXECUTION_INVALID", "父执行实例必须是数组");
  }
  const desired = [];
  const seen = new Set();
  for (const parent of parentExecutions) {
    const items = parent && parent.items;
    if (!Array.isArray(items)) {
      throw taskItemExecutionError("TASK_ITEM_EXECUTION_INVALID", "父执行实例缺少任务项数组", { parent });
    }
    const orderedItems = items.map((item, index) => ({ item, index })).sort((left, right) => {
      const orderDifference = Number(left.item.order || 0) - Number(right.item.order || 0);
      return orderDifference || left.index - right.index;
    });
    for (const { item } of orderedItems) {
      const execution = buildTaskItemExecution(parent, item);
      if (seen.has(execution.key)) continue;
      seen.add(execution.key);
      desired.push(execution);
    }
  }
  return desired;
}

function defaultExistingIdentity(record) {
  return {
    parentExecutionRecordId: record && record.parentExecutionRecordId,
    taskItemRecordId: record && record.taskItemRecordId,
  };
}

function existingExecutionIndex(records, identityOfExisting = defaultExistingIdentity) {
  if (!Array.isArray(records)) throw taskItemExecutionError("TASK_ITEM_EXECUTION_INVALID", "现有任务项执行记录必须是数组");
  if (typeof identityOfExisting !== "function") throw taskItemExecutionError("TASK_ITEM_EXECUTION_INVALID", "缺少现有记录身份解析函数");
  const index = new Map();
  for (const record of records) {
    const identity = identityOfExisting(record) || {};
    const parentId = String(identity.parentExecutionRecordId || "").trim();
    const itemId = String(identity.taskItemRecordId || "").trim();
    if (!parentId || !itemId) continue;
    const key = itemExecutionKey(parentId, itemId);
    if (index.has(key)) {
      throw taskItemExecutionError(
        "TASK_ITEM_EXECUTION_DUPLICATE_EXISTING",
        `任务项执行表存在重复记录：${key}`,
        { key, records: [index.get(key), record] },
      );
    }
    index.set(key, record);
  }
  return index;
}

function chunk(records, batchSize) {
  const batches = [];
  for (let offset = 0; offset < records.length; offset += batchSize) batches.push(records.slice(offset, offset + batchSize));
  return batches;
}

function planTaskItemExecutionBatches({
  parentExecutions,
  existingRecords = [],
  identityOfExisting = defaultExistingIdentity,
  serializeRecord = (record) => record,
  batchSize = MAX_BATCH_SIZE,
}) {
  const size = Number(batchSize);
  if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH_SIZE) {
    throw taskItemExecutionError(
      "TASK_ITEM_EXECUTION_BATCH_SIZE_INVALID",
      `任务项执行单批数量必须为1至${MAX_BATCH_SIZE}`,
      { batchSize },
    );
  }
  if (typeof serializeRecord !== "function") throw taskItemExecutionError("TASK_ITEM_EXECUTION_INVALID", "缺少任务项执行记录序列化函数");

  const desired = buildDesiredTaskItemExecutions(parentExecutions);
  const existing = existingExecutionIndex(existingRecords, identityOfExisting);
  const toCreate = desired.filter((record) => !existing.has(record.key));
  const serialized = toCreate.map((record) => serializeRecord(record));
  if (serialized.some((record) => record === undefined || record === null)) {
    throw taskItemExecutionError("TASK_ITEM_EXECUTION_SERIALIZE_FAILED", "任务项执行记录序列化结果不能为空");
  }

  return {
    desired,
    toCreate,
    batches: chunk(serialized, size),
    stats: {
      desired: desired.length,
      existing: existing.size,
      skipped: desired.length - toCreate.length,
      toCreate: toCreate.length,
      batchCount: Math.ceil(toCreate.length / size),
    },
  };
}

async function ensureTaskItemExecutions({
  parentExecutions,
  loadExisting,
  addBatch,
  identityOfExisting = defaultExistingIdentity,
  serializeRecord = (record) => record,
  batchSize = MAX_BATCH_SIZE,
}) {
  if (typeof loadExisting !== "function") throw taskItemExecutionError("TASK_ITEM_EXECUTION_INVALID", "缺少读取现有任务项执行记录的函数");
  if (typeof addBatch !== "function") throw taskItemExecutionError("TASK_ITEM_EXECUTION_INVALID", "缺少分批新增任务项执行记录的函数");

  const existingRecords = await loadExisting();
  const plan = planTaskItemExecutionBatches({ parentExecutions, existingRecords, identityOfExisting, serializeRecord, batchSize });
  const responses = [];
  for (let index = 0; index < plan.batches.length; index += 1) {
    responses.push(await addBatch(plan.batches[index], {
      batchIndex: index,
      batchCount: plan.batches.length,
      sheetTitle: ITEM_EXECUTION_SHEET,
    }));
  }
  return { ...plan, responses };
}

module.exports = {
  ITEM_EXECUTION_SHEET,
  MAX_BATCH_SIZE,
  ITEM_EXECUTION_STATUS_LABELS,
  normalizeItemExecutionStatus,
  itemExecutionStatusLabel,
  itemExecutionKey,
  buildTaskItemExecution,
  buildDesiredTaskItemExecutions,
  existingExecutionIndex,
  planTaskItemExecutionBatches,
  ensureTaskItemExecutions,
};
