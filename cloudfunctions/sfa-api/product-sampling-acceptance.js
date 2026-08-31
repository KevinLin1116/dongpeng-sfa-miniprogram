const {
  CELL_VALUE_KEY_TYPE_FIELD_TITLE,
  sheetId,
  sheetTitle,
  cellText,
  cellBoolean,
  cellReferences,
  textCell,
} = require("./wecom");

const CONFIRMATION = "CONFIRM_PRODUCT_SAMPLING_ACCEPTANCE_SETUP";

const TITLES = Object.freeze({
  taskTypes: "01_任务类型",
  resultDirectory: "02_结果表目录",
  publications: "04_任务发布",
  taskItems: "05_任务项设置",
  stores: "09_门店主档",
  templates: "17_审批模板",
  nodes: "18_审批节点设置",
  routes: "19_审批路由规则",
  regions: "20_大区主档",
  rules: "22_产品规则",
});

function setupError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function requireConfirmation(value) {
  if (value !== CONFIRMATION) {
    throw setupError("ACCEPTANCE_SETUP_CONFIRMATION_REQUIRED", `真实验收初始化需要确认口令：${CONFIRMATION}`);
  }
}

function requireFields(fields, sheetTitleValue, titles) {
  const actual = new Set((fields || []).map((field) => field.field_title));
  const missing = titles.filter((title) => !actual.has(title));
  if (missing.length) throw setupError("ACCEPTANCE_SETUP_FIELDS_MISSING", `${sheetTitleValue}缺少字段：${missing.join("、")}`, { sheetTitle: sheetTitleValue, fields: missing });
}

function findUnique(records, predicate, label) {
  const matches = (records || []).filter(predicate);
  if (matches.length !== 1) throw setupError("ACCEPTANCE_SETUP_RECORD_INVALID", `${label}应且只能存在一条，当前为${matches.length}条`, { label, recordIds: matches.map((record) => record.record_id) });
  return matches[0];
}

function selectCell(value) {
  return [{ text: String(value) }];
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function assertReference(record, title, expectedRecordId, label) {
  const references = cellReferences(record, title);
  if (references.length !== 1 || references[0] !== expectedRecordId) {
    throw setupError("ACCEPTANCE_SETUP_VERIFY_FAILED", `${label}回读校验失败`, { recordId: record.record_id, field: title, expectedRecordId, references });
  }
}

async function loadTable(client, sheet) {
  const id = sheetId(sheet);
  const [fields, records] = await Promise.all([
    client.getFields(id),
    client.getRecords(id, { keyType: CELL_VALUE_KEY_TYPE_FIELD_TITLE }),
  ]);
  return { id, fields, records };
}

async function prepareProductSamplingAcceptance(client, options = {}) {
  requireConfirmation(options.confirmation);
  const taskName = String(options.taskName || "产品上样全链路验收-20260819").trim();
  const storeCode = String(options.storeCode || "MD002").trim();
  const executorUserId = String(options.executorUserId || "LinWenKai").trim();
  const ruleName = String(options.ruleName || "8月新品上样").trim();
  const regionName = String(options.regionName || "华南运营中心").trim();
  const nowMs = Number(options.nowMs || Date.now());
  if (!taskName || !storeCode || !executorUserId || !ruleName || !regionName || !Number.isFinite(nowMs)) {
    throw setupError("ACCEPTANCE_SETUP_INPUT_INVALID", "真实验收初始化参数不完整");
  }

  const sheets = await client.getSheets();
  const byTitle = Object.fromEntries(sheets.map((sheet) => [sheetTitle(sheet), sheet]));
  for (const title of Object.values(TITLES)) if (!byTitle[title]) throw setupError("ACCEPTANCE_SETUP_SHEET_MISSING", `智能表格缺少子表：${title}`);

  const tableEntries = await Promise.all(Object.entries(TITLES).map(async ([key, title]) => [key, await loadTable(client, byTitle[title])]));
  const tables = Object.fromEntries(tableEntries);

  requireFields(tables.taskItems.fields, TITLES.taskItems, ["任务项名称", "写入结果表", "是否必做", "展示顺序", "是否启用", "需要审批", "审批模板", "适用任务类型"]);
  requireFields(tables.routes.fields, TITLES.routes, ["路由规则名称", "所属审批模板", "适用大区", "审核职责", "是否生效", "所属审批节点"]);
  requireFields(tables.publications.fields, TITLES.publications, ["任务名称", "任务类型", "开始时间", "截止时间", "任务门店", "执行人员", "任务项", "产品规则", "需要定位", "允许距离（米）", "超范围处理", "发布状态", "确认发布"]);

  const taskType = findUnique(tables.taskTypes.records, (record) => cellText(record, "类型编码").trim() === "STORE", "门店任务类型");
  const resultDirectory = findUnique(tables.resultDirectory.records, (record) => cellText(record, "结果表名称").trim() === "产品上样结果", "产品上样结果目录");
  const taskItem = findUnique(tables.taskItems.records, (record) => cellText(record, "任务项名称").trim() === "产品上样", "产品上样任务项");
  const store = findUnique(tables.stores.records, (record) => cellText(record, "门店编码").trim() === storeCode, `门店${storeCode}`);
  const template = findUnique(tables.templates.records, (record) => cellText(record, "审批模板编码").trim() === "PRODUCT_SAMPLING" || cellText(record, "审批模板名称").trim() === "产品上样审批", "产品上样审批模板");
  const node = findUnique(tables.nodes.records, (record) => cellText(record, "审批节点名称").trim() === "产品经理审批" && cellReferences(record, "所属审批模板").includes(template.record_id), "产品经理审批节点");
  const region = findUnique(tables.regions.records, (record) => cellText(record, "大区名称").trim() === regionName, `大区${regionName}`);
  const productRule = findUnique(tables.rules.records, (record) => compactText(cellText(record, "规则名称")) === compactText(ruleName), `产品规则${ruleName}`);

  const storeRegions = cellReferences(store, "所属大区");
  if (storeRegions.length !== 1 || storeRegions[0] !== region.record_id) {
    throw setupError("ACCEPTANCE_SETUP_STORE_REGION_INVALID", `门店${storeCode}必须且只能关联大区${regionName}`, { storeRecordId: store.record_id, regionRecordIds: storeRegions });
  }

  await client.updateRecords(tables.taskItems.id, [{
    record_id: taskItem.record_id,
    values: {
      "写入结果表": [resultDirectory.record_id],
      "是否必做": true,
      "展示顺序": 2,
      "是否启用": true,
      "需要审批": true,
      "审批模板": [template.record_id],
      "适用任务类型": [taskType.record_id],
    },
  }], { keyType: CELL_VALUE_KEY_TYPE_FIELD_TITLE });

  const routeName = `${regionName}-产品上样审批`;
  const routeMatches = tables.routes.records.filter((record) => cellText(record, "路由规则名称").trim() === routeName);
  if (routeMatches.length > 1) throw setupError("ACCEPTANCE_SETUP_ROUTE_DUPLICATE", `审批路由“${routeName}”存在重复记录`, { recordIds: routeMatches.map((record) => record.record_id) });
  const routeValues = {
    "路由规则名称": textCell(routeName),
    "所属审批模板": [template.record_id],
    "适用大区": [region.record_id],
    "审核职责": selectCell("产品经理"),
    "是否生效": true,
    "所属审批节点": [node.record_id],
  };
  let routeRecordId = routeMatches[0]?.record_id;
  if (routeRecordId) {
    await client.updateRecords(tables.routes.id, [{ record_id: routeRecordId, values: routeValues }], { keyType: CELL_VALUE_KEY_TYPE_FIELD_TITLE });
  } else {
    const response = await client.addRecords(tables.routes.id, [{ values: routeValues }], { keyType: CELL_VALUE_KEY_TYPE_FIELD_TITLE });
    routeRecordId = response.records?.[0]?.record_id;
    if (!routeRecordId) throw setupError("ACCEPTANCE_SETUP_ROUTE_WRITE_FAILED", "产品上样审批路由新增后未返回记录ID");
  }

  const publicationMatches = tables.publications.records.filter((record) => cellText(record, "任务名称").trim() === taskName);
  if (publicationMatches.length > 1) throw setupError("ACCEPTANCE_SETUP_TASK_DUPLICATE", `验收任务“${taskName}”存在重复记录`, { recordIds: publicationMatches.map((record) => record.record_id) });
  const publicationValues = {
    "任务名称": textCell(taskName),
    "任务类型": [taskType.record_id],
    "执行要求": textCell("按产品规则完成上样拍照，提交后由门店所属大区的最新产品经理审批。"),
    "开始时间": String(nowMs - 60 * 60 * 1000),
    "截止时间": String(nowMs + 30 * 24 * 60 * 60 * 1000),
    "任务门店": [store.record_id],
    "执行人员": [{ user_id: executorUserId }],
    "任务项": [taskItem.record_id],
    "产品规则": [productRule.record_id],
    "需要定位": true,
    "允许距离（米）": 500,
    "超范围处理": selectCell("标记异常"),
    "发布状态": selectCell("草稿"),
    "确认发布": true,
  };
  let publicationRecordId = publicationMatches[0]?.record_id;
  if (publicationRecordId) {
    if (!cellBoolean(publicationMatches[0], "确认发布")) {
      await client.updateRecords(tables.publications.id, [{ record_id: publicationRecordId, values: publicationValues }], { keyType: CELL_VALUE_KEY_TYPE_FIELD_TITLE });
    }
  } else {
    const response = await client.addRecords(tables.publications.id, [{ values: publicationValues }], { keyType: CELL_VALUE_KEY_TYPE_FIELD_TITLE });
    publicationRecordId = response.records?.[0]?.record_id;
    if (!publicationRecordId) throw setupError("ACCEPTANCE_SETUP_TASK_WRITE_FAILED", "产品上样验收任务新增后未返回记录ID");
  }

  const [verifiedItem] = await client.getRecords(tables.taskItems.id, { recordIds: [taskItem.record_id], keyType: CELL_VALUE_KEY_TYPE_FIELD_TITLE });
  const [verifiedRoute] = await client.getRecords(tables.routes.id, { recordIds: [routeRecordId], keyType: CELL_VALUE_KEY_TYPE_FIELD_TITLE });
  const [verifiedPublication] = await client.getRecords(tables.publications.id, { recordIds: [publicationRecordId], keyType: CELL_VALUE_KEY_TYPE_FIELD_TITLE });
  if (!verifiedItem || !verifiedRoute || !verifiedPublication) throw setupError("ACCEPTANCE_SETUP_VERIFY_FAILED", "真实验收初始化写入后回读记录失败");
  assertReference(verifiedItem, "写入结果表", resultDirectory.record_id, "产品上样结果表");
  assertReference(verifiedItem, "审批模板", template.record_id, "产品上样审批模板");
  assertReference(verifiedRoute, "所属审批节点", node.record_id, "产品上样审批节点");
  assertReference(verifiedRoute, "适用大区", region.record_id, "产品上样审批大区");
  assertReference(verifiedPublication, "任务项", taskItem.record_id, "验收任务项");
  assertReference(verifiedPublication, "产品规则", productRule.record_id, "验收产品规则");
  if (!cellBoolean(verifiedItem, "是否启用") || !cellBoolean(verifiedItem, "需要审批") || !cellBoolean(verifiedPublication, "确认发布")) {
    throw setupError("ACCEPTANCE_SETUP_VERIFY_FAILED", "产品上样任务项或验收任务启用状态回读失败");
  }

  return {
    taskName,
    publicationRecordId,
    taskItemRecordId: taskItem.record_id,
    resultDirectoryRecordId: resultDirectory.record_id,
    routeRecordId,
    templateRecordId: template.record_id,
    nodeRecordId: node.record_id,
    regionRecordId: region.record_id,
    storeRecordId: store.record_id,
    executorUserId,
    productRuleRecordId: productRule.record_id,
    verified: true,
  };
}

module.exports = { CONFIRMATION, TITLES, prepareProductSamplingAcceptance };
