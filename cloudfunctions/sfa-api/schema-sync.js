const crypto = require("crypto");
const { sheetId, sheetTitle, cellText, cellBoolean, cellNumber, cellReferences } = require("./wecom");

const TASK_ITEM_SHEET = "05_任务项设置";
const FIELD_SETTING_SHEET = "15_任务项字段设置";
const RESULT_DIRECTORY_SHEET = "02_结果表目录";

const RESULT_FIELD_TYPES = Object.freeze({
  text: "FIELD_TYPE_TEXT",
  textarea: "FIELD_TYPE_TEXT",
  number: "FIELD_TYPE_NUMBER",
  singleChoice: "FIELD_TYPE_SINGLE_SELECT",
  image: "FIELD_TYPE_IMAGE",
});

const RESERVED_RESULT_FIELDS = new Set([
  "执行记录",
  "任务项",
  "保存状态",
  "提交人",
  "提交时间",
  "创建人",
  "创建时间",
  "最后编辑人",
  "最后编辑时间",
]);

const INPUT_TYPE_CODES = Object.freeze({
  "单行文本": "text",
  "多行文本": "textarea",
  "数字": "number",
  "单选": "singleChoice",
  "图片": "image",
  text: "text",
  textarea: "textarea",
  number: "number",
  singleChoice: "singleChoice",
  image: "image",
});

function normalizeInputType(value) {
  return INPUT_TYPE_CODES[String(value || "").trim()] || "";
}

function resultFieldType(fieldConfig) {
  return RESULT_FIELD_TYPES[fieldConfig && fieldConfig.inputType] || "";
}

function resultFieldTitle(fieldConfig) {
  return String(fieldConfig?.resultFieldTitle || fieldConfig?.label || "").trim();
}

function resultFieldDefinition(fieldConfig) {
  const fieldType = resultFieldType(fieldConfig);
  if (!fieldType) throw new Error(`字段“${fieldConfig.label}”的输入类型暂不支持自动建列`);
  const definition = { field_title: resultFieldTitle(fieldConfig), field_type: fieldType };
  if (fieldType === "FIELD_TYPE_NUMBER") {
    definition.property_number = { decimal_places: 2, use_separate: false };
  } else if (fieldType === "FIELD_TYPE_SINGLE_SELECT") {
    // 开启快速新增后，表15新增选项无需再次修改结果表字段结构；首次写入时会自动补充选项。
    definition.property_single_select = { is_quick_add: true, options: [] };
  }
  return definition;
}

function fieldType(field) {
  return String((field && (field.field_type || field.type)) || "").toUpperCase();
}

function isCompatibleResultField(fieldConfig, field) {
  return Boolean(field && resultFieldType(fieldConfig) === fieldType(field));
}

function assertConfigurableResultField(fieldConfig) {
  if (RESERVED_RESULT_FIELDS.has(fieldConfig.label)) {
    throw new Error(`字段“${fieldConfig.label}”是结果表保留字段，不能由表15动态配置`);
  }
  if (!resultFieldType(fieldConfig)) throw new Error(`字段“${fieldConfig.label}”的输入类型暂不支持自动建列`);
}

async function ensureResultFields(client, sheet, fields) {
  const id = sheetId(sheet);
  const title = sheetTitle(sheet);
  let tableFields = await client.getFields(id);
  let byTitle = new Map(tableFields.map((field) => [field.field_title || field.title, field]));
  const uniqueFields = [];
  const seen = new Map();
  for (const fieldConfig of fields) {
    assertConfigurableResultField(fieldConfig);
    const resultTitle = resultFieldTitle(fieldConfig);
    const previousType = seen.get(resultTitle);
    if (previousType && previousType !== fieldConfig.inputType) {
      throw new Error(`结果表“${title}”字段“${resultTitle}”在表15中配置了互相冲突的输入类型`);
    }
    if (previousType) continue;
    seen.set(resultTitle, fieldConfig.inputType);
    uniqueFields.push(fieldConfig);
  }

  for (const fieldConfig of uniqueFields) {
    const fieldTitle = resultFieldTitle(fieldConfig);
    const existing = byTitle.get(fieldTitle);
    if (existing && !isCompatibleResultField(fieldConfig, existing)) {
      throw new Error(`结果表“${title}”字段“${fieldTitle}”类型冲突：表15配置为${resultFieldType(fieldConfig)}，结果表实际为${fieldType(existing) || "未知类型"}`);
    }
  }

  const missing = uniqueFields.filter((fieldConfig) => !byTitle.has(resultFieldTitle(fieldConfig)));
  for (let index = 0; index < missing.length; index += 10) {
    const batch = missing.slice(index, index + 10).map(resultFieldDefinition);
    try {
      await client.addFields(id, batch);
    } catch (error) {
      // 并发同步可能已由另一请求补齐；回读后仍缺失才继续抛错。
      tableFields = await client.getFields(id);
      byTitle = new Map(tableFields.map((field) => [field.field_title || field.title, field]));
      const unresolved = missing.slice(index, index + 10).filter((fieldConfig) => !byTitle.has(resultFieldTitle(fieldConfig)));
      if (unresolved.length) throw error;
    }
  }

  if (missing.length) {
    tableFields = await client.getFields(id);
    byTitle = new Map(tableFields.map((field) => [field.field_title || field.title, field]));
  }
  for (const fieldConfig of uniqueFields) {
    const fieldTitle = resultFieldTitle(fieldConfig);
    const existing = byTitle.get(fieldTitle);
    if (!existing) throw new Error(`结果表“${title}”自动新增字段“${fieldTitle}”后回读失败`);
    if (!isCompatibleResultField(fieldConfig, existing)) {
      throw new Error(`结果表“${title}”字段“${fieldTitle}”类型冲突：表15配置为${resultFieldType(fieldConfig)}，结果表实际为${fieldType(existing) || "未知类型"}`);
    }
  }
  return { fields: tableFields, added: missing.map((fieldConfig) => resultFieldTitle(fieldConfig)) };
}

function schemaHash(fields) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(fields.map((field) => [
      field.label,
      field.inputType,
      field.required,
      field.order,
      field.options,
      field.minImages,
      field.maxImages,
      field.maxLength,
      field.placeholder,
    ])))
    .digest("hex")
    .slice(0, 16);
}

function configuredFields(settings, itemId) {
  return settings
    .filter((record) => cellReferences(record, "所属任务项").includes(itemId) && cellBoolean(record, "执行端展示"))
    .map((record) => ({
      id: record.record_id,
      key: record.record_id,
      label: cellText(record, "字段名称").trim(),
      inputType: normalizeInputType(cellText(record, "输入类型")),
      required: cellBoolean(record, "是否必填"),
      visible: true,
      order: cellNumber(record, "展示顺序"),
      options: cellText(record, "选项（每行一个）").split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
      minImages: cellNumber(record, "最小图片数"),
      maxImages: cellNumber(record, "最大图片数"),
      maxLength: cellNumber(record, "最大字数"),
      placeholder: cellText(record, "占位提示").trim(),
    }))
    .filter((field) => field.label && field.inputType)
    .sort((a, b) => a.order - b.order);
}

async function syncEnabledSchemas(client) {
  const sheets = await client.getSheets();
  const byTitle = Object.fromEntries(sheets.map((sheet) => [sheetTitle(sheet), sheet]));
  const itemSheet = byTitle[TASK_ITEM_SHEET];
  const fieldSheet = byTitle[FIELD_SETTING_SHEET];
  const directorySheet = byTitle[RESULT_DIRECTORY_SHEET];
  if (!itemSheet || !fieldSheet || !directorySheet) throw new Error("智能表格缺少任务项配置相关子表");

  const [items, settings, directory] = await Promise.all([
    client.getRecords(sheetId(itemSheet)),
    client.getRecords(sheetId(fieldSheet)),
    client.getRecords(sheetId(directorySheet)),
  ]);
  const directoryById = new Map(directory.map((record) => [record.record_id, record]));

  const schemas = items.filter((record) => cellBoolean(record, "是否启用")).map((item) => {
    const itemId = item.record_id;
    const itemName = cellText(item, "任务项名称").trim() || itemId;
    const resultRefs = cellReferences(item, "写入结果表");
    if (resultRefs.length !== 1) return { itemId, itemName, status: "invalid", message: "必须且只能选择一个写入结果表" };

    const resultConfig = directoryById.get(resultRefs[0]);
    if (!resultConfig) return { itemId, itemName, status: "invalid", message: "写入结果表未在02_结果表目录中登记" };
    if (!cellBoolean(resultConfig, "允许任务项写入") || cellText(resultConfig, "当前状态") !== "可用") {
      return { itemId, itemName, status: "invalid", message: "写入结果表当前不可用" };
    }

    const fields = configuredFields(settings, itemId);
    const duplicate = fields.find((field, index) => fields.findIndex((candidate) => candidate.label === field.label) !== index);
    if (duplicate) return { itemId, itemName, status: "invalid", message: `字段名称重复：${duplicate.label}` };

    return {
      itemId,
      itemName,
      required: cellBoolean(item, "是否必做"),
      order: cellNumber(item, "展示顺序"),
      instructions: cellText(item, "执行要求").trim(),
      allowsMultipleSubmissions: cellBoolean(item, "允许多次提交"),
      minimumSubmissions: cellNumber(item, "最少提交次数"),
      status: "ready",
      taskTypeIds: cellReferences(item, "适用任务类型"),
      resultDirectoryRecordId: resultConfig.record_id,
      resultSheetTitle: cellText(resultConfig, "子表标识").trim(),
      resultRelationField: cellText(resultConfig, "主关联字段").trim() || "执行记录",
      writeMode: cellText(resultConfig, "写入方式").trim(),
      renderer: cellText(item, "表单展示方式").trim() || cellText(resultConfig, "表单展示方式").trim(),
      requiresApproval: cellBoolean(item, "需要审批"),
      approvalTemplateIds: cellReferences(item, "审批模板"),
      fields,
      schemaHash: schemaHash(fields),
    };
  });

  const readyByResultSheet = new Map();
  for (const schema of schemas.filter((item) => item.status === "ready")) {
    if (!readyByResultSheet.has(schema.resultSheetTitle)) readyByResultSheet.set(schema.resultSheetTitle, []);
    readyByResultSheet.get(schema.resultSheetTitle).push(schema);
  }
  for (const [resultSheetTitle, relatedSchemas] of readyByResultSheet.entries()) {
    const resultSheet = byTitle[resultSheetTitle];
    if (!resultSheet) {
      for (const schema of relatedSchemas) {
        schema.status = "invalid";
        schema.message = `智能表格缺少结果子表：${resultSheetTitle}`;
      }
      continue;
    }
    try {
      const ensured = await ensureResultFields(client, resultSheet, relatedSchemas.flatMap((schema) => schema.fields));
      for (const schema of relatedSchemas) schema.addedResultFields = ensured.added.filter((label) => schema.fields.some((field) => field.label === label));
    } catch (error) {
      for (const schema of relatedSchemas) {
        schema.status = "invalid";
        schema.message = error.message;
      }
    }
  }
  return schemas;
}

module.exports = {
  INPUT_TYPE_CODES,
  RESULT_FIELD_TYPES,
  RESERVED_RESULT_FIELDS,
  normalizeInputType,
  resultFieldDefinition,
  resultFieldTitle,
  isCompatibleResultField,
  ensureResultFields,
  schemaHash,
  configuredFields,
  syncEnabledSchemas,
};
