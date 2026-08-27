const { sheetId, sheetTitle } = require("./wecom");

// DO NOT DEPLOY: this draft was generated against an obsolete sample workbook.
// The live workbook already uses 16_任务项执行 and 17-19 for approval configuration.
// Rebuild this module only after the live 01-24 schema has been read back and approved.
const QUARANTINE_REASON = "structure-migration is quarantined: live 01-24 schema audit is incomplete";

function assertMigrationEnabled() {
  throw new Error(QUARANTINE_REASON);
}

const TARGET_SCHEMA_VERSION = "SMART_SHEET_SCHEMA_V3";

function singleSelect(title, options = []) {
  return {
    field_title: title,
    field_type: "FIELD_TYPE_SINGLE_SELECT",
    property_single_select: {
      is_quick_add: true,
      options: options.map((text) => ({ text })),
    },
  };
}

function field(title, type, property = {}) {
  return { field_title: title, field_type: type, ...property };
}

const SAFE_ADDITIONS = Object.freeze({
  "05_任务项设置": [
    field("需要审批", "FIELD_TYPE_CHECKBOX", { property_checkbox: { checked: false } }),
  ],
  "06_任务执行": [
    field("任务项快照标识", "FIELD_TYPE_TEXT"),
  ],
  "07_审核记录": [
    field("规则匹配值", "FIELD_TYPE_TEXT"),
  ],
  "08_人员主档": [
    field("企业微信人员", "FIELD_TYPE_USER", { property_user: { is_multiple: false, is_notified: false } }),
    field("企业微信账号ID（自动）", "FIELD_TYPE_TEXT"),
  ],
  "09_门店主档": [
    field("门店位置", "FIELD_TYPE_LOCATION", { property_location: { input_type: "LOCATION_INPUT_TYPE_MANUAL" } }),
  ],
  "15_任务项字段设置": [
    field("需要水印", "FIELD_TYPE_CHECKBOX", { property_checkbox: { checked: false } }),
    singleSelect("图片来源", ["仅拍照", "相册或拍照"]),
    field("显示条件值", "FIELD_TYPE_TEXT"),
    singleSelect("状态", ["启用", "停用"]),
  ],
  "16_审批规则": [
    field("审批规则名称", "FIELD_TYPE_TEXT"),
    field("规则编码", "FIELD_TYPE_TEXT"),
    singleSelect("匹配维度", ["固定人员", "销售区域", "运营中心"]),
    field("匹配值", "FIELD_TYPE_TEXT"),
    field("审核人", "FIELD_TYPE_USER", { property_user: { is_multiple: false, is_notified: false } }),
    field("优先级", "FIELD_TYPE_NUMBER", { property_number: { decimal_places: 0, use_separate: false } }),
    field("生效时间", "FIELD_TYPE_DATE_TIME", { property_date_time: { format: "yyyy-mm-dd hh:mm", auto_fill: false } }),
    field("失效时间", "FIELD_TYPE_DATE_TIME", { property_date_time: { format: "yyyy-mm-dd hh:mm", auto_fill: false } }),
    singleSelect("状态", ["启用", "停用"]),
  ],
});

// 关联、引用和条件关联字段的 property 契约必须以当前文档真实字段回读结果为准。
// 在没有确认目标 sheet_id、显示字段和接口 property 结构前，不自动猜测创建。
const RELATION_ADDITIONS = Object.freeze([
  { sheet: "04_任务发布", title: "任务项", type: "关联字段", target: "05_任务项设置", multiple: true },
  { sheet: "05_任务项设置", title: "适用任务类型", type: "关联字段", target: "01_任务类型", multiple: true },
  { sheet: "05_任务项设置", title: "审批规则", type: "关联字段", target: "16_审批规则", multiple: true },
  { sheet: "07_审核记录", title: "审批规则", type: "关联字段", target: "16_审批规则", multiple: false },
  { sheet: "15_任务项字段设置", title: "显示条件字段", type: "关联字段", target: "15_任务项字段设置", multiple: false },
]);

function fieldSummary(value) {
  return {
    id: value.field_id || value.id || "",
    title: value.field_title || value.title || "",
    type: value.field_type || value.type || "",
    property: Object.fromEntries(Object.entries(value).filter(([key]) => key.startsWith("property_"))),
  };
}

async function inspectStructure(client) {
  const sheets = await client.getSheets();
  const result = {};
  for (const sheet of sheets) {
    const title = sheetTitle(sheet);
    const id = sheetId(sheet);
    const fields = await client.getFields(id);
    result[title] = {
      sheetId: id,
      fields: fields.map(fieldSummary),
    };
  }
  return { version: TARGET_SCHEMA_VERSION, sheets: result };
}

async function planStructureMigration(client) {
  const structure = await inspectStructure(client);
  const safe = [];
  for (const [title, definitions] of Object.entries(SAFE_ADDITIONS)) {
    const current = structure.sheets[title];
    if (!current) {
      safe.push({ action: "add_sheet", sheet: title, fields: definitions });
      continue;
    }
    const existingTitles = new Set(current.fields.map((item) => item.title));
    const missing = definitions.filter((definition) => !existingTitles.has(definition.field_title));
    if (missing.length) safe.push({ action: "add_fields", sheet: title, sheetId: current.sheetId, fields: missing });
  }
  const existingRelations = new Set(Object.values(structure.sheets)
    .flatMap((item) => item.fields.map((value) => value.title)));
  const relations = RELATION_ADDITIONS.filter((item) => !existingRelations.has(item.title) || item.title === "审批规则");
  return { version: TARGET_SCHEMA_VERSION, safe, relations, structure };
}

async function applySafeStructureMigration(client) {
  assertMigrationEnabled();
  const plan = await planStructureMigration(client);
  const applied = [];
  for (const operation of plan.safe) {
    if (operation.action === "add_sheet") {
      const created = await client.addSheet(operation.sheet);
      const id = sheetId(created);
      if (!id) throw new Error(`新增子表“${operation.sheet}”后未能回读子表ID`);
      await client.addFields(id, operation.fields);
      applied.push({ action: "add_sheet", sheet: operation.sheet, fieldCount: operation.fields.length });
    } else {
      await client.addFields(operation.sheetId, operation.fields);
      applied.push({ action: "add_fields", sheet: operation.sheet, fieldCount: operation.fields.length });
    }
  }
  const verified = await inspectStructure(client);
  return { version: TARGET_SCHEMA_VERSION, applied, pendingRelations: plan.relations, verified };
}

module.exports = {
  TARGET_SCHEMA_VERSION,
  QUARANTINE_REASON,
  SAFE_ADDITIONS,
  RELATION_ADDITIONS,
  fieldSummary,
  inspectStructure,
  planStructureMigration,
  applySafeStructureMigration,
};
