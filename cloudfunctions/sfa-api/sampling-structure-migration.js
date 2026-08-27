const { sheetId, sheetTitle, cellText, cellReferences, textCell } = require("./wecom");

const CONFIRMATION = "CONFIRM_PRODUCT_SAMPLING_RULE_V2";
const CLEANUP_CONFIRMATION = "CONFIRM_PRODUCT_SAMPLING_ONE_WAY_CLEANUP_V3";
const LINK_REPAIR_CONFIRMATION = "CONFIRM_PRODUCT_SAMPLING_GROUP_LINK_REPAIR_V3";
const SHEET_TITLES = Object.freeze({
  publications: "04_任务发布",
  products: "21_产品主档",
  legacyRules: "22_上样组合规则",
  rules: "22_产品规则",
  groups: "23_上样规则明细",
  results: "24_产品上样结果",
});

function migrationError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function textField(title) { return { field_title: title, field_type: "FIELD_TYPE_TEXT" }; }
function numberField(title) { return { field_title: title, field_type: "FIELD_TYPE_NUMBER", property_number: { decimal_places: 0, use_separate: false } }; }
function autoNumberField(title) {
  return {
    field_title: title,
    field_type: "FIELD_TYPE_AUTONUMBER",
    property_auto_number: {
      type: "NUMBER_TYPE_INCR",
      rules: [{ type: "NUMBER_RULE_TYPE_INCR", value: "3" }],
      reformat_existing_record: true,
    },
  };
}
function referenceField(title, targetSheetId, isMultiple) {
  return {
    field_title: title,
    field_type: "FIELD_TYPE_REFERENCE",
    property_reference: { sub_id: targetSheetId, field_id: "", is_multiple: isMultiple },
  };
}

function fieldType(field) { return String(field && field.field_type || ""); }
function fieldProperty(field, name) { return field && field[name] || {}; }

async function inspect(client) {
  const sheets = await client.getSheets();
  const byTitle = new Map(sheets.map((sheet) => [sheetTitle(sheet), sheet]));
  const rulesSheet = byTitle.get(SHEET_TITLES.rules) || byTitle.get(SHEET_TITLES.legacyRules);
  const required = [SHEET_TITLES.publications, SHEET_TITLES.products, SHEET_TITLES.groups, SHEET_TITLES.results];
  const missing = required.filter((title) => !byTitle.has(title));
  if (!rulesSheet) missing.push(SHEET_TITLES.rules);
  if (missing.length) throw migrationError("SAMPLING_MIGRATION_SHEET_MISSING", `智能表格缺少子表：${missing.join("、")}`, { missing });
  const selected = {
    publications: byTitle.get(SHEET_TITLES.publications),
    products: byTitle.get(SHEET_TITLES.products),
    rules: rulesSheet,
    groups: byTitle.get(SHEET_TITLES.groups),
    results: byTitle.get(SHEET_TITLES.results),
  };
  const fields = {};
  for (const [key, sheet] of Object.entries(selected)) fields[key] = await client.getFields(sheetId(sheet));
  return { sheets: selected, fields };
}

function fieldMap(fields) { return new Map((fields || []).map((field) => [field.field_title, field])); }

function migrationPlan(baseline) {
  const ids = Object.fromEntries(Object.entries(baseline.sheets).map(([key, sheet]) => [key, sheetId(sheet)]));
  const maps = Object.fromEntries(Object.entries(baseline.fields).map(([key, fields]) => [key, fieldMap(fields)]));
  const additions = {
    publications: [referenceField("产品规则", ids.rules, false)],
    rules: [autoNumberField("产品规则编号")],
    groups: [autoNumberField("规则分组编号"), referenceField("产品规则", ids.rules, false), textField("一级分组名称"), textField("二级分组名称"), referenceField("关联产品", ids.products, true), numberField("必上样数量")],
    results: [referenceField("规则分组", ids.groups, false), numberField("提交轮次"), textField("结果唯一键")],
  };
  const addOperations = Object.entries(additions).map(([section, definitions]) => ({
    section,
    sheetId: ids[section],
    fields: definitions.filter((definition) => {
      if (maps[section].has(definition.field_title)) return false;
      if (section === "groups" && definition.field_title === "产品规则" && maps.groups.has("所属上样规则")) return false;
      return true;
    }),
  })).filter((operation) => operation.fields.length);
  const legacyRuleName = maps.rules.get("上样规则名称");
  const renameRuleName = legacyRuleName && !maps.rules.has("规则名称") ? {
    sheetId: ids.rules,
    fields: [{ field_id: legacyRuleName.field_id, field_title: "规则名称", field_type: legacyRuleName.field_type }],
  } : null;
  const renameRuleSheet = sheetTitle(baseline.sheets.rules) === SHEET_TITLES.legacyRules;
  return { ids, renameRuleSheet, renameRuleName, addOperations };
}

function assertField(fields, title, expectedType, reference) {
  const field = fieldMap(fields).get(title);
  if (!field || fieldType(field) !== expectedType) throw migrationError("SAMPLING_MIGRATION_VERIFY_FAILED", `字段“${title}”类型回读不正确`, { title, expectedType, actualType: fieldType(field) });
  if (expectedType === "FIELD_TYPE_AUTONUMBER") {
    const property = fieldProperty(field, "property_auto_number");
    if (property.type !== "NUMBER_TYPE_INCR" || !Array.isArray(property.rules) || !property.rules.length) throw migrationError("SAMPLING_MIGRATION_VERIFY_FAILED", `自动编号字段“${title}”属性回读不完整`, { title });
  }
  if (reference) {
    const property = fieldProperty(field, "property_reference");
    if (property.sub_id !== reference.subId || Boolean(property.is_multiple) !== reference.multiple) throw migrationError("SAMPLING_MIGRATION_VERIFY_FAILED", `关联字段“${title}”目标或多选设置不正确`, { title, expected: reference, actual: property });
  }
  return field;
}

async function verify(client) {
  const baseline = await inspect(client);
  const ids = Object.fromEntries(Object.entries(baseline.sheets).map(([key, sheet]) => [key, sheetId(sheet)]));
  const verified = {
    publications: assertField(baseline.fields.publications, "产品规则", "FIELD_TYPE_REFERENCE", { subId: ids.rules, multiple: false }),
    ruleNumber: assertField(baseline.fields.rules, "产品规则编号", "FIELD_TYPE_AUTONUMBER"),
    ruleName: assertField(baseline.fields.rules, "规则名称", "FIELD_TYPE_TEXT"),
    groupNumber: assertField(baseline.fields.groups, "规则分组编号", "FIELD_TYPE_AUTONUMBER"),
    groupRule: assertField(baseline.fields.groups, "产品规则", "FIELD_TYPE_REFERENCE", { subId: ids.rules, multiple: false }),
    groupLevel1: assertField(baseline.fields.groups, "一级分组名称", "FIELD_TYPE_TEXT"),
    groupLevel2: assertField(baseline.fields.groups, "二级分组名称", "FIELD_TYPE_TEXT"),
    groupProducts: assertField(baseline.fields.groups, "关联产品", "FIELD_TYPE_REFERENCE", { subId: ids.products, multiple: true }),
    groupMinimum: assertField(baseline.fields.groups, "必上样数量", "FIELD_TYPE_NUMBER"),
    resultGroup: assertField(baseline.fields.results, "规则分组", "FIELD_TYPE_REFERENCE", { subId: ids.groups, multiple: false }),
    resultRound: assertField(baseline.fields.results, "提交轮次", "FIELD_TYPE_NUMBER"),
    resultKey: assertField(baseline.fields.results, "结果唯一键", "FIELD_TYPE_TEXT"),
  };
  return {
    sheetTitles: Object.fromEntries(Object.entries(baseline.sheets).map(([key, sheet]) => [key, sheetTitle(sheet)])),
    fields: Object.fromEntries(Object.entries(verified).map(([key, field]) => [key, { id: field.field_id, title: field.field_title, type: field.field_type, property: Object.fromEntries(Object.entries(field).filter(([name]) => name.startsWith("property_"))) }])),
  };
}

const FINAL_FIELDS = Object.freeze({
  rules: ["规则名称", "产品规则编号"],
  groups: ["一级分组名称", "产品规则", "二级分组名称", "关联产品", "必上样数量", "规则分组编号"],
});

function assertSubset(source, target) {
  const targetSet = new Set(target);
  return source.every((value) => targetSet.has(value));
}

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function waitForField(client, targetSheetId, title, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const field = fieldMap(await client.getFields(targetSheetId)).get(title);
    if (field) return field;
    if (attempt < attempts - 1) await wait(300);
  }
  throw migrationError("SAMPLING_GROUP_RULE_FIELD_NOT_READY", `字段“${title}”创建后未能及时回读，请稍后重试`);
}

async function repairSamplingGroupRuleLinks(client, confirmation, links) {
  if (confirmation !== LINK_REPAIR_CONFIRMATION) throw migrationError("SAMPLING_LINK_REPAIR_CONFIRMATION_REQUIRED", "产品规则关联恢复缺少明确确认口令");
  const baseline = await inspect(client);
  const ids = Object.fromEntries(Object.entries(baseline.sheets).map(([key, sheet]) => [key, sheetId(sheet)]));
  const ruleRecords = await client.getRecords(ids.rules);
  const groupRecords = await client.getRecords(ids.groups);
  const ruleIds = new Set(ruleRecords.map((record) => record.record_id));
  const groupIds = new Set(groupRecords.map((record) => record.record_id));
  const normalizedLinks = Array.isArray(links) ? links.map((item) => ({ groupRecordId: String(item && item.groupRecordId || ""), ruleRecordId: String(item && item.ruleRecordId || "") })) : [];
  const mapping = new Map();
  for (const link of normalizedLinks) {
    if (!groupIds.has(link.groupRecordId) || !ruleIds.has(link.ruleRecordId)) throw migrationError("SAMPLING_LINK_REPAIR_TARGET_INVALID", "关联恢复包含不存在的产品规则或规则分组，已停止写入", link);
    if (mapping.has(link.groupRecordId) && mapping.get(link.groupRecordId) !== link.ruleRecordId) throw migrationError("SAMPLING_LINK_REPAIR_CONFLICT", `规则分组“${link.groupRecordId}”配置了多个产品规则，已停止写入`);
    mapping.set(link.groupRecordId, link.ruleRecordId);
  }
  const missingGroups = Array.from(groupIds).filter((recordId) => !mapping.has(recordId));
  if (missingGroups.length) throw migrationError("SAMPLING_LINK_REPAIR_INCOMPLETE", "关联恢复映射未覆盖全部规则分组，已停止写入", { missingGroupRecordIds: missingGroups });

  let productRuleField = fieldMap(await client.getFields(ids.groups)).get("产品规则");
  if (!productRuleField) {
    await client.addFields(ids.groups, [referenceField("产品规则", ids.rules, false)]);
    productRuleField = await waitForField(client, ids.groups, "产品规则");
  }
  assertField([productRuleField], "产品规则", "FIELD_TYPE_REFERENCE", { subId: ids.rules, multiple: false });
  await client.updateRecordsBatched(ids.groups, Array.from(mapping, ([groupRecordId, ruleRecordId]) => ({ record_id: groupRecordId, values: { "产品规则": [ruleRecordId] } })));

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = await client.getRecords(ids.groups);
    const invalid = current.filter((record) => {
      const linked = cellReferences(record, "产品规则");
      return linked.length !== 1 || linked[0] !== mapping.get(record.record_id);
    });
    if (!invalid.length) return { field: { id: productRuleField.field_id, title: productRuleField.field_title, type: productRuleField.field_type, property: productRuleField.property_reference }, restored: current.map((record) => ({ groupRecordId: record.record_id, ruleRecordId: mapping.get(record.record_id) })) };
    if (attempt < 11) await wait(300);
  }
  throw migrationError("SAMPLING_LINK_REPAIR_VERIFY_FAILED", "产品规则关联写入后回读不一致，已停止后续操作");
}

async function cleanupSamplingRuleStructure(client, confirmation) {
  if (confirmation !== CLEANUP_CONFIRMATION) throw migrationError("SAMPLING_CLEANUP_CONFIRMATION_REQUIRED", "产品上样单向关系清理缺少明确确认口令");
  const baseline = await inspect(client);
  const ids = Object.fromEntries(Object.entries(baseline.sheets).map(([key, sheet]) => [key, sheetId(sheet)]));
  const ruleFields = fieldMap(baseline.fields.rules);
  const groupFields = fieldMap(baseline.fields.groups);
  const records = await client.getRecords(ids.groups);
  const sourceLevel1 = groupFields.get("一级分组名称");
  const primary = baseline.fields.groups[0];
  if (!primary) throw migrationError("SAMPLING_CLEANUP_PRIMARY_MISSING", "23_上样规则明细缺少首列，无法安全精简");

  if (primary.field_title !== "一级分组名称") {
    if (sourceLevel1 && sourceLevel1.field_id !== primary.field_id) {
      const updates = [];
      for (const record of records) {
        const existing = cellText(record, primary.field_title).trim();
        const desired = cellText(record, sourceLevel1.field_title).trim();
        if (existing && desired && existing !== desired) throw migrationError("SAMPLING_CLEANUP_LEVEL1_CONFLICT", `规则分组“${record.record_id}”的首列与一级分组名称不一致，已停止删除`, { recordId: record.record_id });
        if (!existing && desired) updates.push({ record_id: record.record_id, values: { [primary.field_title]: textCell(desired) } });
      }
      if (updates.length) await client.updateRecordsBatched(ids.groups, updates);
      await client.deleteFields(ids.groups, [sourceLevel1.field_id]);
    }
    await client.updateFields(ids.groups, [{ field_id: primary.field_id, field_title: "一级分组名称", field_type: primary.field_type }]);
  }

  const refreshedGroupFields = fieldMap(await client.getFields(ids.groups));
  const oldRuleField = refreshedGroupFields.get("所属上样规则");
  const currentRuleField = refreshedGroupFields.get("产品规则");
  if (oldRuleField && currentRuleField && oldRuleField.field_id !== currentRuleField.field_id) throw migrationError("SAMPLING_CLEANUP_RULE_FIELD_CONFLICT", "23表同时存在两个产品规则关联字段，无法自动合并");
  if (oldRuleField && !currentRuleField) await client.updateFields(ids.groups, [{
    field_id: oldRuleField.field_id,
    field_title: "产品规则",
    field_type: oldRuleField.field_type,
    property_reference: oldRuleField.property_reference,
  }]);

  const latestGroupFields = fieldMap(await client.getFields(ids.groups));
  const oldProducts = latestGroupFields.get("适用产品");
  const newProducts = latestGroupFields.get("关联产品");
  if (oldProducts && newProducts) {
    const latestRecords = await client.getRecords(ids.groups);
    for (const record of latestRecords) {
      const oldIds = cellReferences(record, oldProducts.field_title);
      const newIds = cellReferences(record, newProducts.field_title);
      if (!assertSubset(oldIds, newIds)) throw migrationError("SAMPLING_CLEANUP_PRODUCT_CONFLICT", `规则分组“${record.record_id}”的旧适用产品尚未完整迁入关联产品，已停止删除`, { recordId: record.record_id, missingProductRecordIds: oldIds.filter((id) => !newIds.includes(id)) });
    }
  }

  const currentRules = fieldMap(await client.getFields(ids.rules));
  const oldRuleCode = currentRules.get("规则编码");
  const newRuleCode = currentRules.get("产品规则编号");
  if (oldRuleCode && newRuleCode) {
    const ruleRecords = await client.getRecords(ids.rules);
    for (const record of ruleRecords) {
      if (cellText(record, oldRuleCode.field_title).trim() && !cellText(record, newRuleCode.field_title).trim()) throw migrationError("SAMPLING_CLEANUP_RULE_NUMBER_MISSING", `产品规则“${record.record_id}”尚未生成自动编号，已停止删除旧规则编码`, { recordId: record.record_id });
    }
  }

  const rulesToDelete = Array.from(currentRules.values()).filter((field) => !FINAL_FIELDS.rules.includes(field.field_title));
  const finalGroupMap = fieldMap(await client.getFields(ids.groups));
  const groupsToDelete = Array.from(finalGroupMap.values()).filter((field) => !FINAL_FIELDS.groups.includes(field.field_title));
  if (rulesToDelete.length) await client.deleteFields(ids.rules, rulesToDelete.map((field) => field.field_id));
  if (groupsToDelete.length) await client.deleteFields(ids.groups, groupsToDelete.map((field) => field.field_id));

  const finalRuleFields = await client.getFields(ids.rules);
  const finalGroupFields = await client.getFields(ids.groups);
  const finalRuleTitles = finalRuleFields.map((field) => field.field_title);
  const finalGroupTitles = finalGroupFields.map((field) => field.field_title);
  if (FINAL_FIELDS.rules.some((title) => !finalRuleTitles.includes(title)) || finalRuleTitles.some((title) => !FINAL_FIELDS.rules.includes(title))) throw migrationError("SAMPLING_CLEANUP_VERIFY_FAILED", "22_产品规则字段精简结果不正确", { actual: finalRuleTitles, expected: FINAL_FIELDS.rules });
  if (FINAL_FIELDS.groups.some((title) => !finalGroupTitles.includes(title)) || finalGroupTitles.some((title) => !FINAL_FIELDS.groups.includes(title))) throw migrationError("SAMPLING_CLEANUP_VERIFY_FAILED", "23_上样规则明细字段精简结果不正确", { actual: finalGroupTitles, expected: FINAL_FIELDS.groups });
  assertField(finalGroupFields, "产品规则", "FIELD_TYPE_REFERENCE", { subId: ids.rules, multiple: false });
  return {
    deleted: {
      rules: rulesToDelete.map((field) => field.field_title),
      groups: groupsToDelete.map((field) => field.field_title),
    },
    fields: { rules: finalRuleTitles, groups: finalGroupTitles },
    recordCount: records.length,
  };
}

async function migrateSamplingRuleStructure(client, confirmation) {
  if (confirmation !== CONFIRMATION) throw migrationError("SAMPLING_MIGRATION_CONFIRMATION_REQUIRED", "产品上样结构迁移缺少明确确认口令");
  const baseline = await inspect(client);
  const plan = migrationPlan(baseline);
  const applied = [];
  if (plan.renameRuleName) {
    await client.updateFields(plan.renameRuleName.sheetId, plan.renameRuleName.fields);
    applied.push({ action: "rename_field", sheet: SHEET_TITLES.rules, from: "上样规则名称", to: "规则名称" });
  }
  for (const operation of plan.addOperations) {
    await client.addFields(operation.sheetId, operation.fields);
    applied.push({ action: "add_fields", section: operation.section, titles: operation.fields.map((field) => field.field_title) });
  }
  if (plan.renameRuleSheet) {
    await client.updateSheet(plan.ids.rules, SHEET_TITLES.rules);
    applied.push({ action: "rename_sheet", from: SHEET_TITLES.legacyRules, to: SHEET_TITLES.rules });
  }
  return { applied, verified: await verify(client) };
}

module.exports = { CONFIRMATION, CLEANUP_CONFIRMATION, LINK_REPAIR_CONFIRMATION, FINAL_FIELDS, SHEET_TITLES, autoNumberField, referenceField, inspect, migrationPlan, verify, migrateSamplingRuleStructure, cleanupSamplingRuleStructure, repairSamplingGroupRuleLinks, migrationError };
