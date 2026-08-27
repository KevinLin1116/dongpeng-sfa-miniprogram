const {
  CELL_VALUE_KEY_TYPE_FIELD_ID,
  CELL_VALUE_KEY_TYPE_FIELD_TITLE,
  buildFieldContract,
  resolveFieldKey,
  sheetId,
  sheetTitle,
  cellText,
  textCell,
} = require("./wecom");
const { referenceTargetSheetId, optionTexts } = require("./item-execution-writeback");

const APPROVAL_HISTORY_SHEET = "07_审核记录";
const APPROVAL_HISTORY_SYSTEM_FIELDS_CONFIRMATION = "CONFIRM_APPROVAL_HISTORY_SYSTEM_FIELDS_V1";
const REQUIRED_ACTION_OPTIONS = Object.freeze(["提交审批", "整改重提", "审核通过", "审核退回"]);
const HISTORY_ALIASES = Object.freeze({
  auditKey: ["操作唯一键"],
  itemExecution: ["任务项执行"],
  template: ["审批模板"],
  region: ["命中大区"],
  round: ["提交轮次"],
  action: ["审核动作", "审核结果"],
  operator: ["操作人", "审核人"],
  opinion: ["审核意见", "意见", "退回原因"],
});

function historyError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function systemFieldDefinitions(regionSheetId) {
  return [
    { field_title: "操作唯一键", field_type: "FIELD_TYPE_TEXT" },
    {
      field_title: "命中大区",
      field_type: "FIELD_TYPE_REFERENCE",
      property_reference: { sub_id: regionSheetId, field_id: "", is_multiple: false },
    },
    {
      field_title: "提交轮次",
      field_type: "FIELD_TYPE_NUMBER",
      property_number: { decimal_places: 0, use_separate: false },
    },
  ];
}

function verifySystemFields(fields, regionSheetId) {
  const byTitle = new Map((fields || []).map((field) => [field.field_title, field]));
  const expected = systemFieldDefinitions(regionSheetId);
  const verified = [];
  for (const definition of expected) {
    const current = byTitle.get(definition.field_title);
    if (!current || current.field_type !== definition.field_type) {
      throw historyError("APPROVAL_HISTORY_SYSTEM_FIELD_INVALID", `${APPROVAL_HISTORY_SHEET}字段“${definition.field_title}”类型不正确`, {
        fieldTitle: definition.field_title,
        expectedType: definition.field_type,
        actualType: current?.field_type || "",
      });
    }
    if (definition.field_type === "FIELD_TYPE_REFERENCE" && referenceTargetSheetId(current) !== regionSheetId) {
      throw historyError("APPROVAL_HISTORY_SYSTEM_FIELD_INVALID", `${APPROVAL_HISTORY_SHEET}字段“${definition.field_title}”关联目标不正确`, {
        fieldTitle: definition.field_title,
        expectedSheetId: regionSheetId,
        actualSheetId: referenceTargetSheetId(current),
      });
    }
    verified.push({ title: definition.field_title, type: definition.field_type, fieldId: current.field_id || "" });
  }
  return verified;
}

function actionField(fields) {
  return (fields || []).find((field) => HISTORY_ALIASES.action.includes(field.field_title));
}

function missingActionOptions(field) {
  if (!field || String(field.field_type || "").toUpperCase() !== "FIELD_TYPE_SINGLE_SELECT") {
    throw historyError("APPROVAL_HISTORY_ACTION_FIELD_INVALID", `${APPROVAL_HISTORY_SHEET}字段“审核动作”缺失或类型不正确`);
  }
  const existing = new Set(optionTexts(field));
  return REQUIRED_ACTION_OPTIONS.filter((text) => !existing.has(text));
}

function actionFieldDefinition(field, missing) {
  const property = field.property_single_select || {};
  const options = Array.isArray(property.options) ? property.options.map((option) => ({ ...option })) : [];
  const additions = missing.map((text, index) => ({ text, style: 1 + ((options.length + index) % 10) }));
  return {
    field_id: field.field_id,
    field_title: field.field_title,
    field_type: field.field_type,
    property_single_select: { ...property, is_multiple: false, is_quick_add: false, options: options.concat(additions) },
  };
}

async function repairApprovalHistorySystemFields(client, confirmation) {
  if (confirmation !== APPROVAL_HISTORY_SYSTEM_FIELDS_CONFIRMATION) {
    throw historyError("APPROVAL_HISTORY_REPAIR_CONFIRMATION_REQUIRED", "审核记录系统字段修复缺少明确确认口令");
  }
  const sheets = await client.getSheets();
  const byTitle = new Map(sheets.map((sheet) => [sheetTitle(sheet), sheet]));
  const historySheet = byTitle.get(APPROVAL_HISTORY_SHEET);
  const regionSheet = byTitle.get("20_大区主档");
  const missingSheets = [!historySheet && APPROVAL_HISTORY_SHEET, !regionSheet && "20_大区主档"].filter(Boolean);
  if (missingSheets.length) throw historyError("APPROVAL_HISTORY_SHEET_MISSING", `智能表格缺少子表：${missingSheets.join("、")}`);
  const historySheetId = sheetId(historySheet);
  const regionSheetId = sheetId(regionSheet);
  const fields = await client.getFields(historySheetId);
  const existingTitles = new Set(fields.map((field) => field.field_title));
  const missingDefinitions = systemFieldDefinitions(regionSheetId).filter((definition) => !existingTitles.has(definition.field_title));
  if (missingDefinitions.length) await client.addFields(historySheetId, missingDefinitions);
  const currentActionField = actionField(fields);
  const missingOptions = missingActionOptions(currentActionField);
  if (missingOptions.length) await client.updateFields(historySheetId, [actionFieldDefinition(currentActionField, missingOptions)]);
  // The fixed-IP proxy caches get_fields and does not invalidate that cache for
  // update_fields yet. A different page limit gives verification a fresh key.
  const finalFields = await client.getFields(historySheetId, { limit: 97 });
  const verified = verifySystemFields(finalFields, regionSheetId);
  const finalMissingOptions = missingActionOptions(actionField(finalFields));
  if (finalMissingOptions.length) throw historyError("APPROVAL_HISTORY_ACTION_OPTIONS_VERIFY_FAILED", `${APPROVAL_HISTORY_SHEET}字段“审核动作”选项修复后回读失败`, { missingOptions: finalMissingOptions });
  return { sheet: APPROVAL_HISTORY_SHEET, added: missingDefinitions.map((field) => field.field_title), optionsAdded: missingOptions, verified, maintainedBy: "system" };
}

function resolveTitles(contract) {
  const titles = {};
  const missing = [];
  for (const [key, aliases] of Object.entries(HISTORY_ALIASES)) {
    const title = aliases.find((candidate) => contract.byTitle[candidate]);
    if (title) titles[key] = title;
    else if (!["opinion"].includes(key)) missing.push(aliases[0]);
  }
  if (missing.length) throw historyError("APPROVAL_HISTORY_FIELDS_MISSING", `${APPROVAL_HISTORY_SHEET}缺少字段：${missing.join("、")}`, { fields: missing });
  return titles;
}

function assertReference(contract, title, expectedSheetId) {
  const actual = referenceTargetSheetId(contract.byTitle[title]);
  if (!actual) throw historyError("APPROVAL_HISTORY_RELATION_UNVERIFIED", `${APPROVAL_HISTORY_SHEET}字段“${title}”无法确认关联目标，已停止写入`);
  if (actual !== expectedSheetId) throw historyError("APPROVAL_HISTORY_RELATION_MISMATCH", `${APPROVAL_HISTORY_SHEET}字段“${title}”关联目标不正确`, { fieldTitle: title, actual, expectedSheetId });
}

async function loadApprovalHistoryContract(client, knownSheets) {
  const sheets = knownSheets || await client.getSheets();
  const byTitle = new Map(sheets.map((sheet) => [sheetTitle(sheet), sheet]));
  for (const title of [APPROVAL_HISTORY_SHEET, "16_任务项执行", "17_审批模板", "20_大区主档"]) if (!byTitle.has(title)) throw historyError("APPROVAL_HISTORY_SHEET_MISSING", `智能表格缺少子表：${title}`);
  const historySheetId = sheetId(byTitle.get(APPROVAL_HISTORY_SHEET));
  // Keep the submission contract on the same post-migration cache key used by
  // repair verification so a repaired option is immediately visible.
  const contract = buildFieldContract(await client.getFields(historySheetId, { limit: 97 }));
  const titles = resolveTitles(contract);
  assertReference(contract, titles.itemExecution, sheetId(byTitle.get("16_任务项执行")));
  assertReference(contract, titles.template, sheetId(byTitle.get("17_审批模板")));
  assertReference(contract, titles.region, sheetId(byTitle.get("20_大区主档")));
  return { sheetId: historySheetId, contract, titles };
}

function auditKey(approvalId, nodeRecordId, action) {
  return `AUDIT:${approvalId}:${nodeRecordId}:${action}`;
}

function selectCell(field, value, title) {
  const options = optionTexts(field);
  const property = field?.property_single_select || field?.propertySingleSelect || {};
  if (options.length && !options.includes(value) && property.is_quick_add === false) throw historyError("APPROVAL_HISTORY_OPTION_INVALID", `${APPROVAL_HISTORY_SHEET}字段“${title}”缺少选项“${value}”`, { fieldTitle: title, value, options });
  return [{ text: value }];
}

function encodeHistory(history, context) {
  const { contract, titles } = context;
  const key = (title) => resolveFieldKey(contract, title, CELL_VALUE_KEY_TYPE_FIELD_ID);
  const values = {
    [key(titles.auditKey)]: textCell(history.auditKey),
    [key(titles.itemExecution)]: [history.itemExecutionRecordId],
    [key(titles.template)]: [history.templateRecordId],
    [key(titles.region)]: [history.regionRecordId],
    [key(titles.round)]: history.round,
    [key(titles.action)]: selectCell(contract.byTitle[titles.action], history.action, titles.action),
  };
  const operatorField = contract.byTitle[titles.operator];
  const operatorType = String(operatorField?.field_type || "").toUpperCase();
  values[key(titles.operator)] = operatorType.includes("USER") ? [{ user_id: history.operatorUserId }] : textCell(history.operatorName || history.operatorUserId);
  if (titles.opinion && history.opinion) values[key(titles.opinion)] = textCell(history.opinion);
  return { values };
}

async function appendApprovalHistory({ client, approvalId, nodeRecordId, action, itemExecutionRecordId, templateRecordId, regionRecordId, round, operatorUserId, operatorName, opinion = "", knownSheets }) {
  if (!approvalId || !nodeRecordId || !itemExecutionRecordId || !templateRecordId || !regionRecordId || !operatorUserId || !Number.isInteger(round) || round < 1) {
    throw historyError("APPROVAL_HISTORY_INPUT_INVALID", "审核历史缺少任务项、模板、大区、轮次或操作人，已停止写入");
  }
  const context = await loadApprovalHistoryContract(client, knownSheets);
  const key = auditKey(approvalId, nodeRecordId, action);
  const read = async () => {
    const records = await client.getRecords(context.sheetId, { keyType: CELL_VALUE_KEY_TYPE_FIELD_TITLE, fieldTitles: [context.titles.auditKey] });
    const matches = records.filter((record) => cellText(record, context.titles.auditKey).trim() === key);
    if (matches.length > 1) throw historyError("APPROVAL_HISTORY_KEY_CONFLICT", `审核历史唯一键“${key}”存在重复记录，请先对账`, { auditKey: key, recordIds: matches.map((record) => record.record_id) });
    return matches[0];
  };
  let existing = await read();
  if (existing) return { recordId: existing.record_id, auditKey: key, reused: true, sheetId: context.sheetId };
  const history = { auditKey: key, action, itemExecutionRecordId, templateRecordId, regionRecordId, round, operatorUserId, operatorName, opinion };
  let response;
  try { response = await client.addRecords(context.sheetId, [encodeHistory(history, context)], { keyType: CELL_VALUE_KEY_TYPE_FIELD_ID }); }
  catch (error) {
    existing = await read();
    if (!existing) throw error;
  }
  const returnedRecordId = String(response?.records?.[0]?.record_id || "").trim();
  if (returnedRecordId) return { recordId: returnedRecordId, auditKey: key, reused: false, sheetId: context.sheetId };
  existing = existing || await read();
  if (!existing) throw historyError("APPROVAL_HISTORY_WRITE_UNCONFIRMED", "审核历史写入后未能回查确认，请重试");
  return { recordId: existing.record_id, auditKey: key, reused: false, sheetId: context.sheetId };
}

module.exports = {
  APPROVAL_HISTORY_SHEET,
  APPROVAL_HISTORY_SYSTEM_FIELDS_CONFIRMATION,
  REQUIRED_ACTION_OPTIONS,
  HISTORY_ALIASES,
  systemFieldDefinitions,
  verifySystemFields,
  repairApprovalHistorySystemFields,
  loadApprovalHistoryContract,
  auditKey,
  encodeHistory,
  appendApprovalHistory,
  historyError,
};
