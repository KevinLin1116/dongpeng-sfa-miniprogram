const crypto = require("crypto");
const {
  CELL_VALUE_KEY_TYPE_FIELD_TITLE,
  cellText,
  sheetId,
  sheetTitle,
  textCell,
} = require("./wecom");

const REGION_SHEET_TITLE = "20_大区主档";
const REGION_NAME_TITLES = ["大区名称"];
const REGION_CODE_TITLES = ["大区编码（自动）", "大区编码"];

function regionCodeError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function firstField(fields, titles) {
  return titles.map((title) => fields.find((field) => field.field_title === title)).find(Boolean);
}

function generatedRegionCode(recordId, regionName, attempt = 0) {
  const fingerprint = crypto.createHash("sha256")
    .update(`${String(regionName).trim()}\n${String(recordId).trim()}\n${attempt}`)
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();
  return `DQ-${fingerprint}`;
}

async function ensureRegionCodes(client, { recordIds } = {}) {
  const sheets = await client.getSheets();
  const regionSheet = sheets.find((sheet) => sheetTitle(sheet) === REGION_SHEET_TITLE);
  if (!regionSheet) throw regionCodeError("REGION_SHEET_MISSING", `智能表格缺少子表：${REGION_SHEET_TITLE}`);
  const regionSheetId = sheetId(regionSheet);
  const fields = await client.getFields(regionSheetId);
  const nameField = firstField(fields, REGION_NAME_TITLES);
  const codeField = firstField(fields, REGION_CODE_TITLES);
  if (!nameField || !codeField) throw regionCodeError("REGION_CODE_FIELDS_MISSING", `${REGION_SHEET_TITLE}缺少大区名称或大区编码（自动）字段`);

  const records = await client.getRecords(regionSheetId, {
    keyType: CELL_VALUE_KEY_TYPE_FIELD_TITLE,
    fieldTitles: [nameField.field_title, codeField.field_title],
  });
  const targetIds = new Set((recordIds || []).map(String).filter(Boolean));
  const targets = targetIds.size ? records.filter((record) => targetIds.has(String(record.record_id))) : records;
  const usedCodes = new Set(records.map((record) => cellText(record, codeField.field_title).trim()).filter(Boolean));
  const updates = [];
  const skipped = [];

  for (const record of targets) {
    const existingCode = cellText(record, codeField.field_title).trim();
    if (existingCode) {
      skipped.push({ recordId: record.record_id, reason: "existing_code" });
      continue;
    }
    const regionName = cellText(record, nameField.field_title).trim();
    if (!regionName) {
      skipped.push({ recordId: record.record_id, reason: "missing_name" });
      continue;
    }
    let attempt = 0;
    let code = generatedRegionCode(record.record_id, regionName, attempt);
    while (usedCodes.has(code) && attempt < 20) code = generatedRegionCode(record.record_id, regionName, ++attempt);
    if (usedCodes.has(code)) throw regionCodeError("REGION_CODE_COLLISION", `大区“${regionName}”无法生成唯一编码`, { recordId: record.record_id });
    usedCodes.add(code);
    updates.push({ record_id: record.record_id, values: { [codeField.field_title]: textCell(code) } });
  }

  if (updates.length) await client.updateRecordsBatched(regionSheetId, updates, { keyType: CELL_VALUE_KEY_TYPE_FIELD_TITLE });
  return {
    sheetId: regionSheetId,
    scanned: targets.length,
    generated: updates.length,
    generatedRecords: updates.map((record) => ({ recordId: record.record_id, code: cellText(record, codeField.field_title) })),
    skipped,
  };
}

module.exports = { REGION_SHEET_TITLE, generatedRegionCode, ensureRegionCodes };
