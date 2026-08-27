const {
  CELL_VALUE_KEY_TYPE_FIELD_ID,
  buildFieldContract,
  cellText,
  cellNumber,
  cellReferences,
  sheetId,
  sheetTitle,
} = require("./wecom");

const SAMPLING_SHEETS = Object.freeze({
  products: "21_产品主档",
  rules: "22_产品规则",
  groups: "23_上样规则明细",
});

const SAMPLING_SHEET_ALIASES = Object.freeze({
  products: ["21_产品主档"],
  rules: ["22_产品规则", "22_上样组合规则"],
  groups: ["23_上样规则明细"],
});

const FIELD_ALIASES = Object.freeze({
  productCode: ["产品编码"],
  productName: ["产品名称"],
  productSeries: ["系列", "产品系列"],
  productFinish: ["表面工艺", "表面效果", "花色"],
  productSpecification: ["规格", "产品规格"],
  productThumbnail: ["产品图片", "产品缩略图", "缩略图"],
  productOrder: ["展示顺序", "排序"],
  productStatus: ["产品状态", "状态", "启用状态", "是否启用"],
  ruleCode: ["产品规则编号", "规则编码"],
  ruleName: ["规则名称", "组合名称", "上样规则名称"],
  groupCode: ["规则分组编号", "规则明细编号"],
  groupRule: ["产品规则", "所属上样规则"],
  groupLevel1: ["一级分组名称"],
  groupLevel2: ["二级分组名称"],
  groupProducts: ["关联产品", "适用产品"],
  groupMinimum: ["必上样数量", "最少完成款数", "最少上样款数"],
});

const REQUIRED_FIELDS = Object.freeze({
  products: ["productCode", "productName", "productSpecification", "productStatus"],
  rules: ["ruleCode", "ruleName"],
  groups: ["groupCode", "groupRule", "groupLevel1", "groupLevel2", "groupProducts", "groupMinimum"],
});

function configError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function firstPresentTitle(contract, aliases) {
  return (aliases || []).find((title) => contract.byTitle[title]);
}

function resolveTitles(contract, section) {
  const result = {};
  const missing = [];
  for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
    const title = firstPresentTitle(contract, aliases);
    if (title) result[key] = title;
  }
  for (const key of REQUIRED_FIELDS[section] || []) if (!result[key]) missing.push(FIELD_ALIASES[key][0]);
  if (missing.length) throw configError("SAMPLING_FIELDS_MISSING", `${SAMPLING_SHEETS[section]}缺少字段：${missing.join("、")}`, { sheetTitle: SAMPLING_SHEETS[section], fields: missing });
  return result;
}

function recordValuesByTitle(record, contract) {
  const values = {};
  for (const [key, value] of Object.entries(record.values || {})) {
    const field = contract.byId[key];
    values[field ? field.field_title : key] = value;
  }
  return { ...record, values };
}

function enabled(record, title) {
  if (!title) return true;
  const raw = record && record.values && record.values[title];
  if (raw === undefined || raw === null || raw === "") return true;
  if (typeof raw === "boolean") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "boolean") return raw[0];
  const text = cellText(record, title).trim();
  if (["停用", "停售", "无效", "不可用", "否", "禁用"].includes(text)) return false;
  return true;
}

function dateIso(value) {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds).toISOString() : "";
}

function imageSnapshot(record, title) {
  const value = record && record.values && record.values[title];
  const first = Array.isArray(value) ? value[0] : value;
  if (!first || typeof first !== "object") return undefined;
  return {
    id: String(first.id || ""),
    title: String(first.title || ""),
    imageUrl: String(first.image_url || first.imageUrl || ""),
    width: Number(first.width || 0),
    height: Number(first.height || 0),
  };
}

function meaningful(record, titles) {
  return Object.values(titles || {}).some((title) => {
    const value = record && record.values && record.values[title];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "";
  });
}

function hasCellValue(record, title) {
  const value = record && record.values && record.values[title];
  if (Array.isArray(value)) return value.length > 0 && value.some((item) => item !== undefined && item !== null && item !== "");
  return value !== undefined && value !== null && value !== "";
}

function displayGroupName(level1Name, level2Name) {
  return level2Name ? `${level1Name} / ${level2Name}` : level1Name;
}

function buildSamplingConfiguration({ productRecords, ruleRecords, groupRecords, detailRecords, titles, loadedAt = new Date().toISOString() }) {
  const ruleRows = ruleRecords || [];
  const groupRows = groupRecords || detailRecords || [];

  const products = (productRecords || []).filter((record) => enabled(record, titles.products.productStatus)).filter((record) => meaningful(record, titles.products)).map((record) => ({
    recordId: record.record_id,
    code: cellText(record, titles.products.productCode).trim(),
    name: cellText(record, titles.products.productName).trim(),
    series: titles.products.productSeries ? cellText(record, titles.products.productSeries).trim() : "",
    finish: titles.products.productFinish ? cellText(record, titles.products.productFinish).trim() : "",
    specification: cellText(record, titles.products.productSpecification).trim(),
    thumbnail: titles.products.productThumbnail ? imageSnapshot(record, titles.products.productThumbnail) : undefined,
    order: titles.products.productOrder ? cellNumber(record, titles.products.productOrder) : 0,
    sourceUpdatedAt: dateIso(record.update_time),
  }));
  const productCodeOwner = new Map();
  for (const product of products) {
    if (!product.code || !product.name) throw configError("SAMPLING_PRODUCT_INCOMPLETE", `产品主档“${product.recordId}”缺少产品编码或产品名称`, { productRecordId: product.recordId });
    if (productCodeOwner.has(product.code)) throw configError("SAMPLING_PRODUCT_CODE_DUPLICATE", `产品编码“${product.code}”存在重复记录`, { productCode: product.code, recordIds: [productCodeOwner.get(product.code), product.recordId] });
    productCodeOwner.set(product.code, product.recordId);
  }
  const productById = new Map(products.map((product) => [product.recordId, product]));

  const groups = groupRows.filter((record) => meaningful(record, titles.groups)).map((record) => {
    const groupCode = cellText(record, titles.groups.groupCode).trim();
    const ruleRecordIds = cellReferences(record, titles.groups.groupRule);
    const level1Name = cellText(record, titles.groups.groupLevel1).trim();
    const level2Name = cellText(record, titles.groups.groupLevel2).trim();
    const productRecordIds = cellReferences(record, titles.groups.groupProducts);
    return {
      groupRecordId: record.record_id,
      groupCode,
      ruleRecordIds,
      level1Name,
      level2Name,
      displayName: displayGroupName(level1Name, level2Name),
      productRecordIds,
      minRequired: cellNumber(record, titles.groups.groupMinimum),
      minimumProvided: hasCellValue(record, titles.groups.groupMinimum),
      sourceUpdatedAt: dateIso(record.update_time),
      products: productRecordIds.map((productRecordId) => productById.get(productRecordId)).filter(Boolean),
    };
  });
  const rules = ruleRows.filter((record) => meaningful(record, titles.rules)).map((record) => {
    const ruleRecordId = record.record_id;
    const ruleCode = cellText(record, titles.rules.ruleCode).trim();
    const ruleName = cellText(record, titles.rules.ruleName).trim();
    const selectedGroups = groups.filter((group) => group.ruleRecordIds.includes(ruleRecordId));
    const groupRecordIds = selectedGroups.map((group) => group.groupRecordId);
    return { ruleRecordId, ruleCode, ruleName, groupRecordIds, groups: selectedGroups, sourceUpdatedAt: dateIso(record.update_time) };
  });
  const ruleCodeOwner = new Map();
  for (const rule of rules) {
    if (!rule.ruleCode) continue;
    if (ruleCodeOwner.has(rule.ruleCode)) throw configError("SAMPLING_RULE_CODE_DUPLICATE", `产品规则编号“${rule.ruleCode}”存在重复记录`, { ruleCode: rule.ruleCode, recordIds: [ruleCodeOwner.get(rule.ruleCode), rule.ruleRecordId] });
    ruleCodeOwner.set(rule.ruleCode, rule.ruleRecordId);
  }

  return { loadedAt, products, groups, rules };
}

function resolveProductRule(configuration, ruleRecordId) {
  const rule = (configuration.rules || []).find((item) => item.ruleRecordId === ruleRecordId);
  if (!rule) throw configError("SAMPLING_PRODUCT_RULE_NOT_FOUND", "任务选择的产品规则不存在，请重新选择", { ruleRecordId });
  if (!rule.ruleCode || !rule.ruleName) throw configError("SAMPLING_PRODUCT_RULE_INCOMPLETE", `产品规则“${rule.ruleName || rule.ruleRecordId}”缺少系统编号或规则名称`, { ruleRecordId });
  if (!rule.groupRecordIds.length) throw configError("SAMPLING_PRODUCT_RULE_EMPTY", `产品规则“${rule.ruleName}”尚未选择规则分组`, { ruleRecordId });
  if (rule.groups.length !== rule.groupRecordIds.length) {
    const found = new Set(rule.groups.map((group) => group.groupRecordId));
    throw configError("SAMPLING_PRODUCT_RULE_GROUP_MISSING", `产品规则“${rule.ruleName}”关联了不存在的规则分组`, { ruleRecordId, groupRecordIds: rule.groupRecordIds.filter((id) => !found.has(id)) });
  }

  const seenProducts = new Map();
  for (const group of rule.groups) {
    const linkedRuleRecordIds = Array.isArray(group.ruleRecordIds) ? group.ruleRecordIds : [ruleRecordId];
    if (linkedRuleRecordIds.length !== 1 || linkedRuleRecordIds[0] !== ruleRecordId) throw configError("SAMPLING_GROUP_RULE_INVALID", `规则分组“${group.displayName || group.groupRecordId}”必须且只能关联当前产品规则`, { ruleRecordId, groupRecordId: group.groupRecordId, linkedRuleRecordIds });
    if (!group.groupCode || !group.level1Name) throw configError("SAMPLING_GROUP_INCOMPLETE", `规则分组“${group.displayName || group.groupRecordId}”缺少系统编号或一级分组名称`, { ruleRecordId, groupRecordId: group.groupRecordId });
    if (!group.productRecordIds.length) throw configError("SAMPLING_GROUP_PRODUCTS_MISSING", `规则分组“${group.displayName}”尚未选择关联产品`, { ruleRecordId, groupRecordId: group.groupRecordId });
    if (group.products.length !== group.productRecordIds.length) {
      const found = new Set(group.products.map((product) => product.recordId));
      throw configError("SAMPLING_GROUP_PRODUCT_INACTIVE", `规则分组“${group.displayName}”关联了停用或不存在的产品`, { ruleRecordId, groupRecordId: group.groupRecordId, productRecordIds: group.productRecordIds.filter((id) => !found.has(id)) });
    }
    if (group.minimumProvided === false || !Number.isInteger(group.minRequired) || group.minRequired < 0) throw configError("SAMPLING_NUMBER_INVALID", `规则分组“${group.displayName}”必上样数量必须为0或正整数`, { ruleRecordId, groupRecordId: group.groupRecordId, value: group.minRequired });
    if (group.minRequired > group.products.length) throw configError("SAMPLING_GROUP_MINIMUM_EXCEEDS_PRODUCTS", `规则分组“${group.displayName}”必上样${group.minRequired}款，但只关联了${group.products.length}款产品`, { ruleRecordId, groupRecordId: group.groupRecordId, minRequired: group.minRequired, productCount: group.products.length });
    for (const product of group.products) {
      if (seenProducts.has(product.recordId)) throw configError("SAMPLING_PRODUCT_DUPLICATE_ACROSS_GROUPS", `产品“${product.name}”不能同时出现在同一规则的多个分组中`, { ruleRecordId, productRecordId: product.recordId, groupRecordIds: [seenProducts.get(product.recordId), group.groupRecordId] });
      seenProducts.set(product.recordId, group.groupRecordId);
    }
  }
  return rule;
}

class SamplingConfigRepository {
  constructor({ client, cacheTtlMs = 60_000 }) {
    this.client = client;
    this.cacheTtlMs = cacheTtlMs;
  }

  invalidate(sheetIdOrTitle) {
    const titles = Object.values(SAMPLING_SHEET_ALIASES).flat();
    if (!sheetIdOrTitle || !this.sheetIds || Object.values(this.sheetIds).includes(sheetIdOrTitle) || titles.includes(sheetIdOrTitle)) {
      this.cached = undefined;
      this.cachedAt = 0;
    }
  }

  async load({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.cached && Date.now() - this.cachedAt < this.cacheTtlMs) return this.cached;
    const sheets = await this.client.getSheets();
    const byTitle = Object.fromEntries(sheets.map((sheet) => [sheetTitle(sheet), sheet]));
    const selectedSheets = {};
    for (const [section, aliases] of Object.entries(SAMPLING_SHEET_ALIASES)) {
      const matchedTitle = aliases.find((title) => byTitle[title]);
      if (!matchedTitle) throw configError("SAMPLING_SHEET_MISSING", `智能表格缺少子表：${SAMPLING_SHEETS[section]}`, { sheetTitle: SAMPLING_SHEETS[section] });
      selectedSheets[section] = byTitle[matchedTitle];
    }
    this.sheetIds = Object.fromEntries(Object.entries(selectedSheets).map(([key, sheet]) => [key, sheetId(sheet)]));
    const sections = ["products", "rules", "groups"];
    const loaded = await Promise.all(sections.map(async (section) => {
      const id = this.sheetIds[section];
      const fields = await this.client.getFields(id);
      const contract = buildFieldContract(fields);
      const sectionTitles = resolveTitles(contract, section);
      const fieldIds = fields.map((field) => field.field_id).filter(Boolean);
      const records = await this.client.getRecords(id, { keyType: CELL_VALUE_KEY_TYPE_FIELD_ID, fieldIds });
      return { section, titles: sectionTitles, records: records.map((record) => recordValuesByTitle(record, contract)) };
    }));
    const titles = {};
    const records = {};
    for (const item of loaded) { titles[item.section] = item.titles; records[item.section] = item.records; }
    this.cached = buildSamplingConfiguration({ productRecords: records.products, ruleRecords: records.rules, groupRecords: records.groups, titles });
    this.cachedAt = Date.now();
    return this.cached;
  }
}

module.exports = {
  SAMPLING_SHEETS,
  SAMPLING_SHEET_ALIASES,
  FIELD_ALIASES,
  REQUIRED_FIELDS,
  SamplingConfigRepository,
  buildSamplingConfiguration,
  resolveProductRule,
  resolveTitles,
  recordValuesByTitle,
  enabled,
  configError,
};
