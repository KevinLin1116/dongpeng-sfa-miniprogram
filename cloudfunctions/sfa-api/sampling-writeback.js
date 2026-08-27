const {
  CELL_VALUE_KEY_TYPE_FIELD_ID,
  CELL_VALUE_KEY_TYPE_FIELD_TITLE,
  WRITE_BATCH_LIMIT,
  sheetId,
  sheetTitle,
  cellText,
  textCell,
  resolveFieldKey,
} = require("./wecom");
const { referenceTargetSheetId, referenceTargetFieldId, optionTexts } = require("./item-execution-writeback");
const { productsFromSnapshot, sanitizeSamplingValues, groupRecordId, imageFromCache } = require("./sampling-validation");
const { normalizeSamplingReview } = require("./product-review");

const SAMPLING_RESULT_SHEET = "24_产品上样结果";
const SAMPLING_RESULT_FIELDS = Object.freeze({
  itemExecution: "任务项执行",
  rule: "上样规则",
  group: "规则分组",
  product: "上样产品",
  images: "上样图片",
  samplingStatus: "上样状态",
  saveStatus: "保存状态",
  round: "提交轮次",
  approvalStatus: "审批状态",
  rejectionReason: "不合格原因",
  resultKey: "结果唯一键",
});

const REQUIRED_TYPES = Object.freeze({
  [SAMPLING_RESULT_FIELDS.itemExecution]: ["REFERENCE", "LINK", "RELATION", "RECORD"],
  [SAMPLING_RESULT_FIELDS.rule]: ["REFERENCE", "LINK", "RELATION", "RECORD"],
  [SAMPLING_RESULT_FIELDS.group]: ["REFERENCE", "LINK", "RELATION", "RECORD"],
  [SAMPLING_RESULT_FIELDS.product]: ["REFERENCE", "LINK", "RELATION", "RECORD"],
  [SAMPLING_RESULT_FIELDS.images]: ["IMAGE"],
  [SAMPLING_RESULT_FIELDS.samplingStatus]: ["SINGLE_SELECT", "SELECT"],
  [SAMPLING_RESULT_FIELDS.saveStatus]: ["SINGLE_SELECT", "SELECT"],
  [SAMPLING_RESULT_FIELDS.round]: ["NUMBER"],
  [SAMPLING_RESULT_FIELDS.approvalStatus]: ["SINGLE_SELECT", "SELECT"],
  [SAMPLING_RESULT_FIELDS.rejectionReason]: ["TEXT"],
  [SAMPLING_RESULT_FIELDS.resultKey]: ["TEXT"],
});

function resultError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function fieldType(field) {
  return String(field?.field_type || field?.type || "").toUpperCase();
}

function assertFieldType(field, title) {
  if (!field) throw resultError("SAMPLING_RESULT_FIELD_MISSING", `${SAMPLING_RESULT_SHEET}缺少字段“${title}”`, { fieldTitle: title });
  const actual = fieldType(field);
  if (!REQUIRED_TYPES[title].some((token) => actual.includes(token))) {
    throw resultError("SAMPLING_RESULT_FIELD_TYPE_INVALID", `${SAMPLING_RESULT_SHEET}字段“${title}”类型不正确`, { fieldTitle: title, actual, expected: REQUIRED_TYPES[title] });
  }
}

function assertReference(field, title, targetSheetId, targetFieldIds) {
  const actualSheetId = referenceTargetSheetId(field);
  const actualFieldId = referenceTargetFieldId(field);
  if (!actualSheetId) throw resultError("SAMPLING_RESULT_RELATION_UNVERIFIED", `${SAMPLING_RESULT_SHEET}字段“${title}”无法确认关联目标，已停止写入`, { fieldTitle: title });
  if (actualSheetId !== targetSheetId || (actualFieldId && !targetFieldIds.has(actualFieldId))) {
    throw resultError("SAMPLING_RESULT_RELATION_MISMATCH", `${SAMPLING_RESULT_SHEET}字段“${title}”关联目标不正确`, { fieldTitle: title, actualSheetId, targetSheetId, actualFieldId });
  }
}

function selectCell(field, value, title) {
  const options = optionTexts(field);
  const property = field?.property_single_select || field?.propertySingleSelect || {};
  if (options.length && !options.includes(value) && property.is_quick_add === false) {
    throw resultError("SAMPLING_RESULT_OPTION_INVALID", `${SAMPLING_RESULT_SHEET}字段“${title}”缺少选项“${value}”`, { fieldTitle: title, value, options });
  }
  return [{ text: value }];
}

async function loadSamplingResultContract(client, knownSheets, { requireGroup = false, requireReason = false } = {}) {
  const sheets = knownSheets || await client.getSheets();
  const byTitle = new Map(sheets.map((sheet) => [sheetTitle(sheet), sheet]));
  const ruleSheetTitle = byTitle.has("22_产品规则") ? "22_产品规则" : "22_上样组合规则";
  const requiredSheets = ["16_任务项执行", "21_产品主档", ruleSheetTitle, SAMPLING_RESULT_SHEET];
  if (requireGroup) requiredSheets.push("23_上样规则明细");
  for (const title of requiredSheets) if (!byTitle.has(title)) throw resultError("SAMPLING_RESULT_SHEET_MISSING", `智能表格缺少子表：${title}`, { sheetTitle: title });
  const resultSheetId = sheetId(byTitle.get(SAMPLING_RESULT_SHEET));
  const itemExecutionSheetId = sheetId(byTitle.get("16_任务项执行"));
  const productSheetId = sheetId(byTitle.get("21_产品主档"));
  const ruleSheetId = sheetId(byTitle.get(ruleSheetTitle));
  const groupSheetId = requireGroup ? sheetId(byTitle.get("23_上样规则明细")) : "";
  const [fields, itemExecutionFields, productFields, ruleFields, groupFields] = await Promise.all([
    client.getFields(resultSheetId),
    client.getFields(itemExecutionSheetId),
    client.getFields(productSheetId),
    client.getFields(ruleSheetId),
    requireGroup ? client.getFields(groupSheetId) : Promise.resolve([]),
  ]);
  const fieldContract = { fields, byTitle: {}, byId: {} };
  for (const field of fields) {
    if (field.field_title) fieldContract.byTitle[field.field_title] = field;
    if (field.field_id) fieldContract.byId[field.field_id] = field;
  }
  for (const title of Object.values(SAMPLING_RESULT_FIELDS)) {
    if (title === SAMPLING_RESULT_FIELDS.group && !requireGroup) continue;
    if (title === SAMPLING_RESULT_FIELDS.rejectionReason && !fieldContract.byTitle[title] && !requireReason) continue;
    assertFieldType(fieldContract.byTitle[title], title);
  }
  const ids = (items) => new Set(items.map((field) => String(field.field_id || field.id || "")).filter(Boolean));
  assertReference(fieldContract.byTitle[SAMPLING_RESULT_FIELDS.itemExecution], SAMPLING_RESULT_FIELDS.itemExecution, itemExecutionSheetId, ids(itemExecutionFields));
  assertReference(fieldContract.byTitle[SAMPLING_RESULT_FIELDS.rule], SAMPLING_RESULT_FIELDS.rule, ruleSheetId, ids(ruleFields));
  if (requireGroup) assertReference(fieldContract.byTitle[SAMPLING_RESULT_FIELDS.group], SAMPLING_RESULT_FIELDS.group, groupSheetId, ids(groupFields));
  assertReference(fieldContract.byTitle[SAMPLING_RESULT_FIELDS.product], SAMPLING_RESULT_FIELDS.product, productSheetId, ids(productFields));
  return { sheetId: resultSheetId, fieldContract, itemExecutionSheetId, productSheetId, ruleSheetId, groupSheetId };
}

function samplingResultKey(itemExecutionRecordId, round, productRecordId) {
  return `RESULT:${itemExecutionRecordId}:${round}:${productRecordId}`;
}

function desiredSamplingResults({ snapshot, values, imageCache, itemExecutionRecordId, round, requiresApproval, samplingReview }) {
  if (!itemExecutionRecordId) throw resultError("SAMPLING_ITEM_EXECUTION_MISSING", "产品上样结果缺少16_任务项执行记录，已停止提交");
  if (!Number.isInteger(round) || round < 1) throw resultError("SAMPLING_ROUND_INVALID", "产品上样提交轮次必须为正整数", { round });
  const normalized = sanitizeSamplingValues(snapshot, values);
  const review = normalizeSamplingReview(samplingReview);
  const qualified = new Set(review.qualifiedProductIds);
  const productRuleRecordId = snapshot && snapshot.productRule && snapshot.productRule.ruleRecordId;
  const seenProducts = new Map();
  return productsFromSnapshot(snapshot).map(({ group, product }) => {
    if (seenProducts.has(product.productRecordId)) {
      throw resultError("SAMPLING_PRODUCT_DUPLICATE_ACROSS_GROUPS", `产品“${product.name}”同时出现在多个规则分组中，无法生成唯一结果`, { productRecordId: product.productRecordId, groupRecordIds: [seenProducts.get(product.productRecordId), groupRecordId(group)] });
    }
    seenProducts.set(product.productRecordId, groupRecordId(group));
    const fileIds = normalized[product.productRecordId] || [];
    if (!fileIds.length || qualified.has(product.productRecordId)) return null;
    const images = fileIds.map((fileId) => imageFromCache(imageCache, fileId)).filter((image) => image?.image_url);
    if (images.length !== fileIds.length) throw resultError("SAMPLING_IMAGE_CACHE_INCOMPLETE", `产品“${product.name}”的照片尚未全部同步到企业微信，请重试`, { productRecordId: product.productRecordId, expected: fileIds.length, actual: images.length });
    const current = review.currentResultByProduct[product.productRecordId];
    return {
      resultKey: current?.resultKey || samplingResultKey(itemExecutionRecordId, round, product.productRecordId),
      existingRecordId: current?.recordId || "",
      itemExecutionRecordId,
      ruleRecordId: productRuleRecordId || group.ruleRecordId,
      groupRecordId: productRuleRecordId ? groupRecordId(group) : "",
      productRecordId: product.productRecordId,
      images,
      samplingStatus: fileIds.length ? "已上样" : "未上样",
      saveStatus: "已提交",
      round,
      approvalStatus: requiresApproval ? "待审批" : "无需审批",
      rejectionReason: "",
    };
  }).filter(Boolean);
}

function encodeSamplingResult(result, contract) {
  const { fieldContract } = contract;
  const key = (title) => resolveFieldKey(fieldContract, title, CELL_VALUE_KEY_TYPE_FIELD_ID);
  const field = (title) => fieldContract.byTitle[title];
  const values = {
      [key(SAMPLING_RESULT_FIELDS.itemExecution)]: [result.itemExecutionRecordId],
      [key(SAMPLING_RESULT_FIELDS.rule)]: [result.ruleRecordId],
      [key(SAMPLING_RESULT_FIELDS.product)]: [result.productRecordId],
      [key(SAMPLING_RESULT_FIELDS.images)]: result.images,
      [key(SAMPLING_RESULT_FIELDS.samplingStatus)]: selectCell(field(SAMPLING_RESULT_FIELDS.samplingStatus), result.samplingStatus, SAMPLING_RESULT_FIELDS.samplingStatus),
      [key(SAMPLING_RESULT_FIELDS.saveStatus)]: selectCell(field(SAMPLING_RESULT_FIELDS.saveStatus), result.saveStatus, SAMPLING_RESULT_FIELDS.saveStatus),
      [key(SAMPLING_RESULT_FIELDS.round)]: result.round,
      [key(SAMPLING_RESULT_FIELDS.approvalStatus)]: selectCell(field(SAMPLING_RESULT_FIELDS.approvalStatus), result.approvalStatus, SAMPLING_RESULT_FIELDS.approvalStatus),
      [key(SAMPLING_RESULT_FIELDS.resultKey)]: textCell(result.resultKey),
  };
  if (result.groupRecordId && field(SAMPLING_RESULT_FIELDS.group)) values[key(SAMPLING_RESULT_FIELDS.group)] = [result.groupRecordId];
  if (field(SAMPLING_RESULT_FIELDS.rejectionReason)) values[key(SAMPLING_RESULT_FIELDS.rejectionReason)] = textCell(result.rejectionReason || "");
  return { values };
}

function indexExistingResults(records, expectedKeys) {
  const indexed = new Map();
  for (const record of records) {
    const key = cellText(record, SAMPLING_RESULT_FIELDS.resultKey).trim();
    if (!expectedKeys.has(key)) continue;
    if (indexed.has(key)) throw resultError("SAMPLING_RESULT_KEY_CONFLICT", `产品上样结果唯一键“${key}”存在重复记录，请先对账`, { resultKey: key, recordIds: [indexed.get(key).record_id, record.record_id] });
    indexed.set(key, record);
  }
  return indexed;
}

async function readExistingResults(client, contract, expectedKeys) {
  const records = await client.getRecords(contract.sheetId, {
    keyType: CELL_VALUE_KEY_TYPE_FIELD_TITLE,
    fieldTitles: [SAMPLING_RESULT_FIELDS.resultKey],
  });
  return indexExistingResults(records, expectedKeys);
}

async function writeSamplingResults({ client, snapshot, values, imageCache, itemExecutionRecordId, round, requiresApproval, knownSheets, samplingReview }) {
  if (!client.configured) throw resultError("SMART_SHEET_NOT_CONFIGURED", "智能表格尚未配置，不能提交正式产品上样结果");
  const contract = await loadSamplingResultContract(client, knownSheets, { requireGroup: Number(snapshot && snapshot.schemaVersion) >= 2, requireReason: requiresApproval === true });
  const desired = desiredSamplingResults({ snapshot, values, imageCache, itemExecutionRecordId, round, requiresApproval, samplingReview });
  if (!desired.length) throw resultError("SAMPLING_RESULT_EMPTY", "产品上样快照中没有可写入的产品");
  const expectedKeys = new Set(desired.map((result) => result.resultKey));
  let existing = await readExistingResults(client, contract, expectedKeys);
  const updates = desired.filter((result) => result.existingRecordId);
  if (updates.length) {
    const rows = updates.map((result) => ({ record_id: result.existingRecordId, ...encodeSamplingResult(result, contract) }));
    await client.updateRecordsBatched(contract.sheetId, rows, { keyType: CELL_VALUE_KEY_TYPE_FIELD_ID });
  }
  const pending = desired.filter((result) => !result.existingRecordId && !existing.has(result.resultKey));
  for (let offset = 0; offset < pending.length; offset += WRITE_BATCH_LIMIT) {
    const batch = pending.slice(offset, offset + WRITE_BATCH_LIMIT);
    let response;
    try {
      response = await client.addRecords(contract.sheetId, batch.map((result) => encodeSamplingResult(result, contract)), { keyType: CELL_VALUE_KEY_TYPE_FIELD_ID });
    } catch (error) {
      existing = await readExistingResults(client, contract, expectedKeys);
      const missing = batch.filter((result) => !existing.has(result.resultKey));
      if (missing.length) throw error;
    }
    const returnedRecords = Array.isArray(response?.records) ? response.records : [];
    const returnedIdsComplete = returnedRecords.length === batch.length && returnedRecords.every((record) => String(record?.record_id || "").trim());
    if (returnedIdsComplete) {
      batch.forEach((result, index) => existing.set(result.resultKey, { record_id: returnedRecords[index].record_id }));
      continue;
    }
    // 企业微信明确返回记录 ID 时无需再次全表回读。只有响应丢失或返回不完整时，
    // 才走一次兜底对账，既保留幂等安全，也避免正常提交的重复网络往返。
    existing = await readExistingResults(client, contract, expectedKeys);
    const missing = batch.filter((result) => !existing.has(result.resultKey));
    if (missing.length) throw resultError("SAMPLING_RESULT_WRITE_UNCONFIRMED", `产品上样结果写入后有${missing.length}条未能回查确认，请重试`, { resultKeys: missing.map((result) => result.resultKey) });
  }
  const recordIds = desired.map((result) => ({ resultKey: result.resultKey, recordId: result.existingRecordId || existing.get(result.resultKey)?.record_id || "", productRecordId: result.productRecordId }));
  if (recordIds.some((entry) => !entry.recordId)) throw resultError("SAMPLING_RESULT_WRITE_UNCONFIRMED", "产品上样结果未能全部回查确认，请重试");
  return { sheetId: contract.sheetId, round, recordIds, createdCount: pending.length, updatedCount: updates.length, reusedCount: desired.length - pending.length - updates.length, resultCount: desired.length };
}

async function updateSamplingProductDecisions({ client, productDecisions, resultRecordIds, knownSheets }) {
  const resultMap = new Map((resultRecordIds || []).filter((entry) => entry && typeof entry === "object").map((entry) => [String(entry.productRecordId || ""), String(entry.recordId || "")]));
  const decisions = Array.isArray(productDecisions) ? productDecisions : [];
  if (!decisions.length) throw resultError("SAMPLING_PRODUCT_DECISIONS_MISSING", "当前审批没有产品审核结果");
  const contract = await loadSamplingResultContract(client, knownSheets);
  const approvalKey = resolveFieldKey(contract.fieldContract, SAMPLING_RESULT_FIELDS.approvalStatus, CELL_VALUE_KEY_TYPE_FIELD_ID);
  const reasonField = contract.fieldContract.byTitle[SAMPLING_RESULT_FIELDS.rejectionReason];
  if (decisions.some((item) => item.decision === "unqualified") && !reasonField) {
    throw resultError("SAMPLING_RESULT_FIELD_MISSING", `${SAMPLING_RESULT_SHEET}缺少字段“${SAMPLING_RESULT_FIELDS.rejectionReason}”`, { fieldTitle: SAMPLING_RESULT_FIELDS.rejectionReason });
  }
  const reasonKey = reasonField ? resolveFieldKey(contract.fieldContract, SAMPLING_RESULT_FIELDS.rejectionReason, CELL_VALUE_KEY_TYPE_FIELD_ID) : "";
  const rows = decisions.map((item) => {
    const recordId = resultMap.get(String(item.productRecordId || ""));
    if (!recordId) throw resultError("SAMPLING_PRODUCT_RESULT_UNMAPPED", "待审核产品与表24结果无法一一对应，请先对账", { productRecordId: item.productRecordId });
    const approvalStatus = item.decision === "qualified" ? "已通过" : "已退回";
    const values = { [approvalKey]: selectCell(contract.fieldContract.byTitle[SAMPLING_RESULT_FIELDS.approvalStatus], approvalStatus, SAMPLING_RESULT_FIELDS.approvalStatus) };
    if (reasonKey) values[reasonKey] = textCell(item.decision === "unqualified" ? item.reason : "");
    return { record_id: recordId, values };
  });
  const response = await client.updateRecordsBatched(contract.sheetId, rows, { keyType: CELL_VALUE_KEY_TYPE_FIELD_ID });
  return { sheetId: contract.sheetId, recordIds: rows.map((row) => row.record_id), updatedCount: rows.length, batches: response.batches || [] };
}

async function updateSamplingResultApprovalStatus({ client, resultRecordIds, approvalStatus, knownSheets }) {
  const recordIds = Array.from(new Set((resultRecordIds || []).map((entry) => typeof entry === "string" ? entry : entry?.recordId).filter(Boolean)));
  if (!recordIds.length) throw resultError("SAMPLING_RESULT_RECORDS_MISSING", "当前审批没有关联产品上样结果记录，不能更新审批状态");
  const contract = await loadSamplingResultContract(client, knownSheets);
  const key = resolveFieldKey(contract.fieldContract, SAMPLING_RESULT_FIELDS.approvalStatus, CELL_VALUE_KEY_TYPE_FIELD_ID);
  const value = selectCell(contract.fieldContract.byTitle[SAMPLING_RESULT_FIELDS.approvalStatus], approvalStatus, SAMPLING_RESULT_FIELDS.approvalStatus);
  const rows = recordIds.map((recordId) => ({ record_id: recordId, values: { [key]: value } }));
  const response = await client.updateRecordsBatched(contract.sheetId, rows, { keyType: CELL_VALUE_KEY_TYPE_FIELD_ID });
  return { sheetId: contract.sheetId, recordIds, updatedCount: rows.length, batches: response.batches || [] };
}

module.exports = {
  SAMPLING_RESULT_SHEET,
  SAMPLING_RESULT_FIELDS,
  loadSamplingResultContract,
  samplingResultKey,
  desiredSamplingResults,
  encodeSamplingResult,
  indexExistingResults,
  writeSamplingResults,
  updateSamplingResultApprovalStatus,
  updateSamplingProductDecisions,
  resultError,
};
