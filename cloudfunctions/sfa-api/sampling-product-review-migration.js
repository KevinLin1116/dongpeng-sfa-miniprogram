const { sheetId, sheetTitle, cellReferences } = require("./wecom");

const CONFIRMATION = "CONFIRM_SAMPLING_PRODUCT_REVIEW_V1";
const SHEET_TITLE = "24_产品上样结果";
const REASON_FIELD = "不合格原因";

function migrationError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function fieldType(field) { return String(field?.field_type || field?.type || "").toUpperCase(); }

async function inspectSamplingProductReview(client, options = {}) {
  const sheets = await client.getSheets();
  const sheet = sheets.find((entry) => sheetTitle(entry) === SHEET_TITLE);
  if (!sheet) throw migrationError("SAMPLING_REVIEW_SHEET_MISSING", `智能表格缺少子表：${SHEET_TITLE}`);
  const targetSheetId = sheetId(sheet);
  // The fixed-IP proxy caches get_fields responses but cannot currently invalidate
  // that cache after add_fields. Querying the target title with a different page
  // limit gives the post-write verification a distinct cache key, preventing a
  // successful field creation from being mistaken for a failed migration.
  const fieldQueryLimit = options.verification ? 99 : 100;
  const [fields, records] = await Promise.all([
    client.getFields(targetSheetId, { fieldTitles: [REASON_FIELD], limit: fieldQueryLimit }),
    client.getRecords(targetSheetId),
  ]);
  const reasonField = fields.find((field) => field.field_title === REASON_FIELD);
  if (reasonField && !fieldType(reasonField).includes("TEXT")) throw migrationError("SAMPLING_REVIEW_FIELD_TYPE_INVALID", `字段“${REASON_FIELD}”已存在但不是文本字段`, { actualType: reasonField.field_type });
  const groups = new Map();
  for (const record of records) {
    const itemExecution = cellReferences(record, "任务项执行")[0] || "";
    const product = cellReferences(record, "上样产品")[0] || "";
    if (!itemExecution || !product) continue;
    const key = `${itemExecution}:${product}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record.record_id);
  }
  return {
    sheetId: targetSheetId,
    reasonField: reasonField ? { id: reasonField.field_id, title: reasonField.field_title, type: reasonField.field_type } : null,
    recordCount: records.length,
    duplicates: Array.from(groups, ([key, recordIds]) => ({ key, recordIds })).filter((entry) => entry.recordIds.length > 1),
  };
}

async function migrateSamplingProductReview(client, confirmation) {
  if (confirmation !== CONFIRMATION) throw migrationError("SAMPLING_REVIEW_MIGRATION_CONFIRMATION_REQUIRED", "产品上样逐产品审核迁移缺少明确确认口令");
  const before = await inspectSamplingProductReview(client);
  if (!before.reasonField) await client.addFields(before.sheetId, [{ field_title: REASON_FIELD, field_type: "FIELD_TYPE_TEXT" }]);
  const after = await inspectSamplingProductReview(client, { verification: true });
  if (!after.reasonField || !fieldType(after.reasonField).includes("TEXT")) throw migrationError("SAMPLING_REVIEW_MIGRATION_VERIFY_FAILED", `字段“${REASON_FIELD}”创建后回读失败`);
  return { changed: !before.reasonField, field: after.reasonField, recordCount: after.recordCount, duplicateAudit: after.duplicates };
}

module.exports = { CONFIRMATION, SHEET_TITLE, REASON_FIELD, inspectSamplingProductReview, migrateSamplingProductReview, migrationError };
