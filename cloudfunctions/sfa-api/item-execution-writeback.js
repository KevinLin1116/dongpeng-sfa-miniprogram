const crypto = require("crypto");
const { sheetId, sheetTitle, cellReferences, textCell } = require("./wecom");
const { ITEM_EXECUTION_SHEET, itemExecutionKey, normalizeItemExecutionStatus } = require("./task-item-execution");

const ITEM_EXECUTION_FIELDS = Object.freeze({
  number: "任务项执行编号",
  parent: "所属执行记录",
  item: "来源任务项",
  status: "执行状态",
  draft: "草稿内容",
  resultSheet: "结果表名称（自动）",
  resultRecord: "结果记录编号（自动）",
  savedBy: "最后保存人",
  savedAt: "最后保存时间",
  submittedAt: "提交时间",
  approvalStatus: "审批状态",
  rejectionReason: "最新退回原因",
  editable: "允许修改",
});

const REQUIRED_FIELD_TYPES = Object.freeze({
  [ITEM_EXECUTION_FIELDS.number]: ["FIELD_TYPE_TEXT"],
  [ITEM_EXECUTION_FIELDS.parent]: ["FIELD_TYPE_REFERENCE"],
  [ITEM_EXECUTION_FIELDS.item]: ["FIELD_TYPE_REFERENCE"],
  [ITEM_EXECUTION_FIELDS.status]: ["FIELD_TYPE_SINGLE_SELECT"],
});

const OPTIONAL_FIELD_TYPES = Object.freeze({
  [ITEM_EXECUTION_FIELDS.draft]: ["FIELD_TYPE_TEXT"],
  [ITEM_EXECUTION_FIELDS.resultSheet]: ["FIELD_TYPE_TEXT"],
  [ITEM_EXECUTION_FIELDS.resultRecord]: ["FIELD_TYPE_TEXT"],
  [ITEM_EXECUTION_FIELDS.savedBy]: ["FIELD_TYPE_USER"],
  [ITEM_EXECUTION_FIELDS.savedAt]: ["FIELD_TYPE_DATE_TIME"],
  [ITEM_EXECUTION_FIELDS.submittedAt]: ["FIELD_TYPE_DATE_TIME"],
  [ITEM_EXECUTION_FIELDS.approvalStatus]: ["FIELD_TYPE_SINGLE_SELECT"],
  [ITEM_EXECUTION_FIELDS.rejectionReason]: ["FIELD_TYPE_TEXT"],
  [ITEM_EXECUTION_FIELDS.editable]: ["FIELD_TYPE_CHECKBOX"],
});

function contractError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function fieldType(field) {
  return String(field?.field_type || field?.type || "").toUpperCase();
}

function referenceTargetSheetId(field) {
  const property = field?.property_reference || field?.propertyReference || {};
  return String(
    property.sub_id || property.subId || property.target_sheet_id || property.targetSheetId || property.sheet_id || property.sheetId || "",
  );
}

function referenceTargetFieldId(field) {
  const property = field?.property_reference || field?.propertyReference || {};
  return String(
    property.filed_id || property.field_id || property.filedId || property.fieldId || property.target_field_id || property.targetFieldId || "",
  );
}

function fieldTitle(field) {
  return field?.field_title || field?.title || "";
}

function optionTexts(field) {
  const property = field?.property_single_select || field?.propertySingleSelect || {};
  return (property.options || []).map((option) => String(option?.text || option?.name || "").trim()).filter(Boolean);
}

function optionCell(text) {
  return [{ text: String(text) }];
}

function itemExecutionNumber(parentExecutionRecordId, taskItemRecordId) {
  const key = itemExecutionKey(parentExecutionRecordId, taskItemRecordId);
  return `ZXITEM-${crypto.createHash("sha1").update(key).digest("hex").slice(0, 20).toUpperCase()}`;
}

function assertFieldTypes(fieldsByTitle) {
  for (const [title, allowed] of Object.entries(REQUIRED_FIELD_TYPES)) {
    const field = fieldsByTitle.get(title);
    if (!field) throw contractError("ITEM_EXECUTION_CONTRACT_INVALID", `16_任务项执行缺少字段“${title}”`, { title });
    if (!allowed.includes(fieldType(field))) {
      throw contractError("ITEM_EXECUTION_CONTRACT_INVALID", `16_任务项执行字段“${title}”类型不正确`, { title, expected: allowed, actual: fieldType(field) });
    }
  }
  for (const [title, allowed] of Object.entries(OPTIONAL_FIELD_TYPES)) {
    const field = fieldsByTitle.get(title);
    if (field && !allowed.includes(fieldType(field))) {
      throw contractError("ITEM_EXECUTION_CONTRACT_INVALID", `16_任务项执行字段“${title}”类型不正确`, { title, expected: allowed, actual: fieldType(field) });
    }
  }
}

async function loadItemExecutionContract(client, knownSheets) {
  const sheets = knownSheets || await client.getSheets();
  const byTitle = new Map(sheets.map((sheet) => [sheetTitle(sheet), sheet]));
  const taskItemSheet = byTitle.get("05_任务项设置");
  const executionSheet = byTitle.get("06_任务执行");
  const itemExecutionSheet = byTitle.get(ITEM_EXECUTION_SHEET);
  if (!taskItemSheet || !executionSheet || !itemExecutionSheet) {
    throw contractError("ITEM_EXECUTION_CONTRACT_INVALID", "智能表格缺少05、06或16子表");
  }

  const taskItemSheetId = sheetId(taskItemSheet);
  const executionSheetId = sheetId(executionSheet);
  const itemExecutionSheetId = sheetId(itemExecutionSheet);
  const [fields, taskItemFields, executionFields] = await Promise.all([
    client.getFields(itemExecutionSheetId),
    client.getFields(taskItemSheetId),
    client.getFields(executionSheetId),
  ]);
  const fieldsByTitle = new Map(fields.map((field) => [fieldTitle(field), field]));
  assertFieldTypes(fieldsByTitle);

  const parentTarget = referenceTargetSheetId(fieldsByTitle.get(ITEM_EXECUTION_FIELDS.parent));
  const itemTarget = referenceTargetSheetId(fieldsByTitle.get(ITEM_EXECUTION_FIELDS.item));
  const parentTargetField = referenceTargetFieldId(fieldsByTitle.get(ITEM_EXECUTION_FIELDS.parent));
  const itemTargetField = referenceTargetFieldId(fieldsByTitle.get(ITEM_EXECUTION_FIELDS.item));
  if (!parentTarget || !itemTarget) {
    throw contractError(
      "ITEM_EXECUTION_RELATION_UNVERIFIED",
      "16_任务项执行的关联目标无法从企业微信字段属性中确认，已停止写入",
      { parentTarget, itemTarget, parentTargetField, itemTargetField },
    );
  }
  if (parentTarget !== executionSheetId || itemTarget !== taskItemSheetId) {
    throw contractError(
      "ITEM_EXECUTION_RELATION_MISMATCH",
      "16_任务项执行关联目标不正确：所属执行记录必须关联06，来源任务项必须关联05",
      { parentTarget, executionSheetId, itemTarget, taskItemSheetId },
    );
  }
  const executionFieldIds = new Set(executionFields.map((field) => String(field.field_id || field.id || "")).filter(Boolean));
  const taskItemFieldIds = new Set(taskItemFields.map((field) => String(field.field_id || field.id || "")).filter(Boolean));
  // 企业微信当前对关联主字段返回 field_id: ""。sub_id 已能唯一确认
  // 目标子表；只有接口明确返回了目标字段 ID 时才继续校验该字段存在。
  if ((parentTargetField && !executionFieldIds.has(parentTargetField)) || (itemTargetField && !taskItemFieldIds.has(itemTargetField))) {
    throw contractError(
      "ITEM_EXECUTION_RELATION_MISMATCH",
      "16_任务项执行关联的目标字段不存在，已停止写入",
      { parentTargetField, itemTargetField },
    );
  }

  return {
    version: "SFA_ITEM_EXECUTION_CONTRACT_V1",
    sheetId: itemExecutionSheetId,
    executionSheetId,
    taskItemSheetId,
    parentTargetField,
    itemTargetField,
    fields,
    fieldsByTitle,
  };
}

function chooseOption(field, candidates, title) {
  const available = optionTexts(field);
  const selected = candidates.find((candidate) => available.includes(candidate));
  if (selected) return selected;
  const property = field?.property_single_select || field?.propertySingleSelect || {};
  if (!available.length && property.is_quick_add !== false) return candidates[0];
  throw contractError("ITEM_EXECUTION_OPTION_INVALID", `16_任务项执行字段“${title}”缺少可用选项`, { title, candidates, available });
}

function executionStatusLabel(contract, status) {
  const normalized = normalizeItemExecutionStatus(status);
  const candidates = {
    pending: ["待执行"],
    active: ["执行中", "进行中"],
    // 审批状态由独立字段表达；旧表未配置“待复核”时，执行动作本身已完成。
    review: ["待复核", "已完成"],
    rectify: ["待整改"],
    completed: ["已完成"],
  }[normalized];
  return chooseOption(contract.fieldsByTitle.get(ITEM_EXECUTION_FIELDS.status), candidates, ITEM_EXECUTION_FIELDS.status);
}

function approvalStatusLabel(contract, status) {
  if (!status) return "";
  const input = String(status).trim();
  const candidates = {
    none: ["无需审批"],
    "无需审批": ["无需审批"],
    pending: ["待审批"],
    "待审批": ["待审批"],
    approved: ["已通过"],
    "已通过": ["已通过"],
    rejected: ["已退回", "已驳回"],
    "已退回": ["已退回", "已驳回"],
    "已驳回": ["已退回", "已驳回"],
  }[input];
  if (!candidates) throw contractError("ITEM_EXECUTION_APPROVAL_STATUS_INVALID", `不支持的任务项审批状态：${input}`);
  const field = contract.fieldsByTitle.get(ITEM_EXECUTION_FIELDS.approvalStatus);
  if (!field) return "";
  return chooseOption(field, candidates, ITEM_EXECUTION_FIELDS.approvalStatus);
}

function setIfPresent(contract, values, title, value) {
  if (contract.fieldsByTitle.has(title) && value !== undefined) values[title] = value;
}

function serializeDraft(draft) {
  if (!draft) return undefined;
  const text = JSON.stringify(draft.values || {});
  if (text.length <= 10_000) return text;
  return `${text.slice(0, 9_950)}…（完整草稿保存在云数据库）`;
}

function itemExecutionIdentity(record) {
  return {
    parentExecutionRecordId: cellReferences(record, ITEM_EXECUTION_FIELDS.parent)[0],
    taskItemRecordId: cellReferences(record, ITEM_EXECUTION_FIELDS.item)[0],
  };
}

function itemExecutionCreateValues(record, contract) {
  const values = {
    [ITEM_EXECUTION_FIELDS.number]: textCell(itemExecutionNumber(record.parentExecutionRecordId, record.taskItemRecordId)),
    [ITEM_EXECUTION_FIELDS.parent]: [record.parentExecutionRecordId],
    [ITEM_EXECUTION_FIELDS.item]: [record.taskItemRecordId],
    [ITEM_EXECUTION_FIELDS.status]: optionCell(executionStatusLabel(contract, record.status)),
  };
  setIfPresent(contract, values, ITEM_EXECUTION_FIELDS.resultSheet, textCell(record.resultSheetTitle || ""));
  if (!record.requiresApproval) {
    const label = approvalStatusLabel(contract, "none");
    if (label) setIfPresent(contract, values, ITEM_EXECUTION_FIELDS.approvalStatus, optionCell(label));
  }
  setIfPresent(contract, values, ITEM_EXECUTION_FIELDS.editable, true);
  return { values };
}

function itemExecutionCreateEntry(record, contract) {
  return { key: record.key || itemExecutionKey(record.parentExecutionRecordId, record.taskItemRecordId), record: itemExecutionCreateValues(record, contract) };
}

function itemExecutionUpdateValues({ contract, status, draft, account, touchSavedBy = true, submittedAt, approvalStatus, latestRejectionReason, allowEdit, resultRecordId, resultSheetTitle }) {
  const values = {};
  if (status) setIfPresent(contract, values, ITEM_EXECUTION_FIELDS.status, optionCell(executionStatusLabel(contract, status)));
  const draftText = serializeDraft(draft);
  if (draftText !== undefined) setIfPresent(contract, values, ITEM_EXECUTION_FIELDS.draft, textCell(draftText));
  if (resultSheetTitle !== undefined) setIfPresent(contract, values, ITEM_EXECUTION_FIELDS.resultSheet, textCell(resultSheetTitle));
  if (resultRecordId !== undefined) setIfPresent(contract, values, ITEM_EXECUTION_FIELDS.resultRecord, textCell(resultRecordId));
  if (touchSavedBy && account) {
    setIfPresent(contract, values, ITEM_EXECUTION_FIELDS.savedBy, [{ user_id: account.wecomUserId }]);
    setIfPresent(contract, values, ITEM_EXECUTION_FIELDS.savedAt, String(Date.now()));
  }
  if (submittedAt) setIfPresent(contract, values, ITEM_EXECUTION_FIELDS.submittedAt, String(Date.parse(submittedAt)));
  if (approvalStatus) {
    const label = approvalStatusLabel(contract, approvalStatus);
    if (label) setIfPresent(contract, values, ITEM_EXECUTION_FIELDS.approvalStatus, optionCell(label));
  }
  if (latestRejectionReason !== undefined) setIfPresent(contract, values, ITEM_EXECUTION_FIELDS.rejectionReason, textCell(latestRejectionReason));
  if (allowEdit !== undefined) setIfPresent(contract, values, ITEM_EXECUTION_FIELDS.editable, Boolean(allowEdit));
  return values;
}

function applyItemExecutionLink(task, item, synced, status) {
  if (!synced?.recordId) return task.items || [];
  const targetId = item.configItemId || item.id;
  return (task.items || []).map((entry) => (((entry.configItemId || entry.id) === targetId) ? {
    ...entry,
    status: status || entry.status,
    smartSheetItemExecutionRecordId: synced.recordId,
    itemExecutionKey: itemExecutionKey(task.smartSheetExecutionRecordId, item.configItemId || item.id),
  } : entry));
}

async function syncTaskItemExecutionRecord({ client, task, item, draft, account, status, submittedAt, approvalStatus, latestRejectionReason, allowEdit, resultRecordId, resultSheetTitle, touchSavedBy = true }) {
  const parentExecutionRecordId = task?.smartSheetExecutionRecordId;
  const taskItemRecordId = item?.configItemId || item?.id;
  if (!client.configured || !parentExecutionRecordId || !taskItemRecordId) return { skipped: true };
  const contract = await loadItemExecutionContract(client);
  let recordId = item.smartSheetItemExecutionRecordId || "";
  if (!recordId) {
    const records = await client.getRecords(contract.sheetId);
    const matches = records.filter((record) => {
      const identity = itemExecutionIdentity(record);
      return identity.parentExecutionRecordId === parentExecutionRecordId && identity.taskItemRecordId === taskItemRecordId;
    });
    if (matches.length > 1) {
      throw contractError("TASK_ITEM_EXECUTION_DUPLICATE_EXISTING", "16_任务项执行存在重复的父执行与任务项组合", { parentExecutionRecordId, taskItemRecordId });
    }
    recordId = matches[0]?.record_id || "";
    if (!recordId) {
      const domainRecord = {
        parentExecutionRecordId,
        taskItemRecordId,
        status: item.status || "pending",
        resultSheetTitle: resultSheetTitle || item.schemaSnapshot?.resultSheetTitle || "",
        requiresApproval: Boolean(item.requiresApproval || item.schemaSnapshot?.requiresApproval),
      };
      const response = await client.addRecords(contract.sheetId, [itemExecutionCreateValues(domainRecord, contract)]);
      recordId = response.records?.[0]?.record_id || "";
      if (!recordId) throw contractError("TASK_ITEM_EXECUTION_WRITE_FAILED", "16_任务项执行新增记录后未返回记录ID");
    }
  }

  const values = itemExecutionUpdateValues({ contract, status, draft, account, touchSavedBy, submittedAt, approvalStatus, latestRejectionReason, allowEdit, resultRecordId, resultSheetTitle });
  if (Object.keys(values).length) await client.updateRecords(contract.sheetId, [{ record_id: recordId, values }]);
  item.smartSheetItemExecutionRecordId = recordId;
  item.itemExecutionKey = itemExecutionKey(parentExecutionRecordId, taskItemRecordId);
  return { skipped: false, recordId, sheetId: contract.sheetId, syncedAt: new Date().toISOString() };
}

module.exports = {
  ITEM_EXECUTION_FIELDS,
  REQUIRED_FIELD_TYPES,
  OPTIONAL_FIELD_TYPES,
  referenceTargetSheetId,
  referenceTargetFieldId,
  optionTexts,
  itemExecutionNumber,
  loadItemExecutionContract,
  executionStatusLabel,
  approvalStatusLabel,
  itemExecutionIdentity,
  itemExecutionCreateValues,
  itemExecutionCreateEntry,
  itemExecutionUpdateValues,
  applyItemExecutionLink,
  syncTaskItemExecutionRecord,
};
