const {
  CELL_VALUE_KEY_TYPE_FIELD_ID,
  buildFieldContract,
  sheetId,
  sheetTitle,
  cellText,
  cellNumber,
  cellReferences,
  cellUsers,
} = require("./wecom");
const { recordValuesByTitle, enabled } = require("./sampling-config");

const APPROVAL_SHEETS = Object.freeze({
  people: "08_人员主档",
  stores: "09_门店主档",
  templates: "17_审批模板",
  nodes: "18_审批节点设置",
  routes: "19_审批路由规则",
  regions: "20_大区主档",
});

const ALIASES = Object.freeze({
  personUserId: ["企微人员ID", "企业微信账号ID（自动）", "企业微信账号ID", "企业微信账号", "企业微信用户ID", "UserID"],
  personName: ["姓名（自动）", "姓名", "人员姓名"],
  storeRegion: ["所属大区"],
  templateName: ["审批模板名称", "模板名称"],
  templateCode: ["审批模板编码", "模板编码"],
  templateStatus: ["是否启用", "启用状态", "状态"],
  nodeTemplate: ["所属审批模板"],
  nodeCode: ["节点编码"],
  nodeName: ["审批节点名称", "节点名称"],
  nodeOrder: ["节点顺序", "审批顺序", "顺序"],
  nodeDuty: ["人员职责字段", "审核职责", "审核角色"],
  nodeStatus: ["是否启用", "启用状态", "状态"],
  routeTemplate: ["所属审批模板"],
  routeNode: ["所属审批节点"],
  routeRegion: ["适用大区"],
  routeDuty: ["审核职责", "审核角色"],
  routeReviewer: ["当前审核人", "固定审核人"],
  routeStatus: ["是否生效", "是否启用", "启用状态", "状态"],
  routeStartsAt: ["生效时间", "开始时间"],
  routeEndsAt: ["失效时间", "结束时间"],
  regionCode: ["大区编码（自动）", "大区编码"],
  regionName: ["大区名称"],
  regionManager: ["产品经理", "产品经理（企业微信）", "产品经理（旧关联备份，请勿维护）"],
  regionStatus: ["状态", "启用状态", "是否启用"],
});

const REQUIRED = Object.freeze({
  people: ["personUserId", "personName"],
  stores: ["storeRegion"],
  templates: ["templateName", "templateStatus"],
  nodes: ["nodeTemplate", "nodeName", "nodeOrder", "nodeDuty", "nodeStatus"],
  routes: ["routeTemplate", "routeNode", "routeRegion", "routeDuty", "routeStatus"],
  regions: ["regionCode", "regionName", "regionManager", "regionStatus"],
});

function routeError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function resolveTitles(contract, section) {
  const titles = {};
  const missing = [];
  for (const [key, aliases] of Object.entries(ALIASES)) {
    const title = aliases.find((candidate) => contract.byTitle[candidate]);
    if (title) titles[key] = title;
  }
  for (const key of REQUIRED[section] || []) if (!titles[key]) missing.push(ALIASES[key][0]);
  if (missing.length) throw routeError("APPROVAL_FIELDS_MISSING", `${APPROVAL_SHEETS[section]}缺少字段：${missing.join("、")}`, { sheetTitle: APPROVAL_SHEETS[section], fields: missing });
  return titles;
}

function timestamp(record, title) {
  if (!title || record?.values?.[title] === undefined) return null;
  const number = cellNumber(record, title);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(cellText(record, title));
  return Number.isFinite(parsed) ? parsed : null;
}

function routeIsEffective(record, titles, at) {
  if (!enabled(record, titles.routeStatus)) return false;
  const start = timestamp(record, titles.routeStartsAt);
  const end = timestamp(record, titles.routeEndsAt);
  return (!start || at >= start) && (!end || at <= end);
}

function singleReference(record, title, label) {
  const ids = cellReferences(record, title);
  if (ids.length !== 1) throw routeError("APPROVAL_RELATION_INVALID", `${label}必须且只能关联一条记录`, { recordId: record.record_id, fieldTitle: title, recordIds: ids });
  return ids[0];
}

function buildApprovalConfiguration({ records, titles, loadedAt = new Date().toISOString() }) {
  const people = (records.people || []).map((record) => ({
    recordId: record.record_id,
    userId: cellText(record, titles.people.personUserId).trim() || cellUsers(record, titles.people.personUserId)[0]?.userId || "",
    name: cellText(record, titles.people.personName).trim() || cellUsers(record, titles.people.personName)[0]?.name || "",
  }));
  const activeTemplates = (records.templates || []).filter((record) => enabled(record, titles.templates.templateStatus)).map((record) => ({
    recordId: record.record_id,
    code: titles.templates.templateCode ? cellText(record, titles.templates.templateCode).trim() : "",
    name: cellText(record, titles.templates.templateName).trim(),
  }));
  const activeTemplateIds = new Set(activeTemplates.map((template) => template.recordId));
  const nodes = (records.nodes || []).filter((record) => enabled(record, titles.nodes.nodeStatus)).map((record) => ({
    recordId: record.record_id,
    templateRecordId: singleReference(record, titles.nodes.nodeTemplate, `审批节点“${record.record_id}”所属审批模板`),
    code: titles.nodes.nodeCode ? cellText(record, titles.nodes.nodeCode).trim() : "",
    name: cellText(record, titles.nodes.nodeName).trim(),
    order: cellNumber(record, titles.nodes.nodeOrder),
    duty: cellText(record, titles.nodes.nodeDuty).trim(),
  })).filter((node) => activeTemplateIds.has(node.templateRecordId)).sort((a, b) => a.order - b.order || a.recordId.localeCompare(b.recordId));
  const routes = (records.routes || []).map((record) => ({
    record,
    recordId: record.record_id,
    templateRecordIds: cellReferences(record, titles.routes.routeTemplate),
    nodeRecordIds: cellReferences(record, titles.routes.routeNode),
    regionRecordIds: cellReferences(record, titles.routes.routeRegion),
    duty: cellText(record, titles.routes.routeDuty).trim(),
    reviewerRecordIds: titles.routes.routeReviewer ? cellReferences(record, titles.routes.routeReviewer) : [],
    reviewerUsers: titles.routes.routeReviewer ? cellUsers(record, titles.routes.routeReviewer) : [],
  }));
  const regions = (records.regions || []).filter((record) => enabled(record, titles.regions.regionStatus)).map((record) => ({
    recordId: record.record_id,
    code: cellText(record, titles.regions.regionCode).trim(),
    name: cellText(record, titles.regions.regionName).trim(),
    managerRecordIds: cellReferences(record, titles.regions.regionManager),
    managerUsers: cellUsers(record, titles.regions.regionManager),
  }));
  const stores = (records.stores || []).map((record) => ({ recordId: record.record_id, regionRecordIds: cellReferences(record, titles.stores.storeRegion) }));
  return { loadedAt, people, templates: activeTemplates, nodes, routes, regions, stores, routeTitles: titles.routes };
}

class ApprovalConfigRepository {
  constructor({ client }) { this.client = client; }

  invalidate() {}

  async load() {
    const sheets = await this.client.getSheets();
    const byTitle = Object.fromEntries(sheets.map((sheet) => [sheetTitle(sheet), sheet]));
    for (const title of Object.values(APPROVAL_SHEETS)) if (!byTitle[title]) throw routeError("APPROVAL_SHEET_MISSING", `智能表格缺少子表：${title}`, { sheetTitle: title });
    const records = {};
    const titles = {};
    const sections = Object.keys(APPROVAL_SHEETS);
    // 审批人必须实时读取，但六张配置表之间没有前后依赖。先并行读取字段，
    // 再并行读取记录，可把十二次串行网络往返压缩为两轮。
    const loadedFields = await Promise.all(sections.map(async (section) => {
      const id = sheetId(byTitle[APPROVAL_SHEETS[section]]);
      const fields = await this.client.getFields(id);
      const contract = buildFieldContract(fields);
      titles[section] = resolveTitles(contract, section);
      return { section, id, fields, contract };
    }));
    await Promise.all(loadedFields.map(async ({ section, id, fields, contract }) => {
      const fieldIds = fields.map((field) => field.field_id).filter(Boolean);
      const loaded = await this.client.getRecords(id, { keyType: CELL_VALUE_KEY_TYPE_FIELD_ID, fieldIds });
      records[section] = loaded.map((record) => recordValuesByTitle(record, contract));
    }));
    return buildApprovalConfiguration({ records, titles });
  }
}

function freezeApprovalStructure(configuration, templateRecordIds, itemName = "任务项") {
  const ids = Array.from(new Set((templateRecordIds || []).map(String).filter(Boolean)));
  if (ids.length !== 1) throw routeError("APPROVAL_TEMPLATE_INVALID", `任务项“${itemName}”必须且只能关联一个审批模板`, { templateRecordIds: ids });
  const template = configuration.templates.find((entry) => entry.recordId === ids[0]);
  if (!template) throw routeError("APPROVAL_TEMPLATE_INACTIVE", `任务项“${itemName}”关联的审批模板未启用或不存在`, { templateRecordId: ids[0] });
  const nodes = configuration.nodes.filter((node) => node.templateRecordId === template.recordId);
  if (!nodes.length) throw routeError("APPROVAL_NODE_MISSING", `审批模板“${template.name}”没有启用的审批节点`, { templateRecordId: template.recordId });
  if (nodes.some((node) => !Number.isFinite(node.order) || node.order <= 0 || !node.name || !node.duty)) throw routeError("APPROVAL_NODE_INVALID", `审批模板“${template.name}”存在未完整维护的节点`, { templateRecordId: template.recordId });
  const orders = new Set();
  for (const node of nodes) {
    if (orders.has(node.order)) throw routeError("APPROVAL_NODE_ORDER_CONFLICT", `审批模板“${template.name}”存在重复节点顺序${node.order}`, { templateRecordId: template.recordId, order: node.order });
    orders.add(node.order);
  }
  return {
    templateRecordId: template.recordId,
    templateCode: template.code,
    templateName: template.name,
    frozenAt: new Date().toISOString(),
    nodes: nodes.map(({ recordId, code, name, order, duty }) => ({ nodeRecordId: recordId, nodeCode: code, nodeName: name, order, duty })),
  };
}

function personFromRecord(configuration, personRecordId, label) {
  const person = configuration.people.find((entry) => entry.recordId === personRecordId);
  if (!person) throw routeError("REVIEWER_PERSON_NOT_FOUND", `${label}关联的人员主档不存在`, { personRecordId });
  if (!person.userId) throw routeError("REVIEWER_WECOM_ID_MISSING", `${label}“${person.name || personRecordId}”缺少企微人员ID`, { personRecordId });
  return person;
}

function resolveNodeReviewer({ configuration, task, item, nodeIndex = 0, at = Date.now() }) {
  const structure = item.approvalStructureSnapshot;
  if (!structure?.templateRecordId || !Array.isArray(structure.nodes) || !structure.nodes.length) throw routeError("APPROVAL_STRUCTURE_SNAPSHOT_MISSING", `任务项“${item.name}”缺少发布时审批结构快照，请重新发布任务`);
  const node = structure.nodes[nodeIndex];
  if (!node) throw routeError("APPROVAL_NODE_NOT_FOUND", `任务项“${item.name}”不存在第${nodeIndex + 1}个审批节点`, { nodeIndex });
  const currentTemplate = configuration.templates.find((entry) => entry.recordId === structure.templateRecordId);
  const currentNode = configuration.nodes.find((entry) => entry.recordId === node.nodeRecordId && entry.templateRecordId === structure.templateRecordId);
  if (!currentTemplate || !currentNode) throw routeError("APPROVAL_STRUCTURE_INACTIVE", `任务项“${item.name}”的审批模板或节点已停用，请联系任务发布者处理`, { templateRecordId: structure.templateRecordId, nodeRecordId: node.nodeRecordId });
  const storeRecordId = task.storeRecordId || task.storeSnapshot?.recordId;
  const store = configuration.stores.find((entry) => entry.recordId === storeRecordId);
  if (!store || store.regionRecordIds.length !== 1) throw routeError("REVIEW_ROUTE_DIMENSION_MISSING", `门店“${task.storeName || storeRecordId}”必须且只能维护一个当前所属大区`, { storeRecordId, regionRecordIds: store?.regionRecordIds || [] });
  const region = configuration.regions.find((entry) => entry.recordId === store.regionRecordIds[0]);
  if (!region) throw routeError("REVIEW_REGION_INACTIVE", `门店“${task.storeName || storeRecordId}”当前所属大区未启用或不存在`, { storeRecordId, regionRecordId: store.regionRecordIds[0] });
  const matches = configuration.routes.filter((route) => route.templateRecordIds.includes(structure.templateRecordId)
    && route.nodeRecordIds.includes(node.nodeRecordId)
    && route.regionRecordIds.includes(region.recordId)
    && routeIsEffective(route.record, configuration.routeTitles, at));
  if (!matches.length) throw routeError("REVIEW_ROUTE_NOT_FOUND", `审批模板“${structure.templateName}”的节点“${node.nodeName}”未配置大区“${region.name}”的有效路由`, { templateRecordId: structure.templateRecordId, nodeRecordId: node.nodeRecordId, regionRecordId: region.recordId });
  if (matches.length > 1) throw routeError("REVIEW_ROUTE_CONFLICT", `审批模板“${structure.templateName}”的节点“${node.nodeName}”在大区“${region.name}”命中多条路由，请先处理重复配置`, { routeRecordIds: matches.map((route) => route.recordId) });
  const route = matches[0];
  const duty = route.duty || node.duty;
  let reviewer;
  if (duty === "产品经理") {
    if (region.managerUsers.length === 1 && region.managerUsers[0].userId) {
      const manager = region.managerUsers[0];
      const person = configuration.people.find((entry) => entry.userId === manager.userId);
      reviewer = { recordId: person?.recordId || "", userId: manager.userId, name: person?.name || manager.name || manager.userId };
    } else if (region.managerRecordIds.length === 1) {
      reviewer = personFromRecord(configuration, region.managerRecordIds[0], `大区“${region.name}”产品经理`);
    } else {
      throw routeError("REGION_PRODUCT_MANAGER_INVALID", `大区“${region.name}”必须且只能选择一名企业微信产品经理`, {
        regionRecordId: region.recordId,
        managerRecordIds: region.managerRecordIds,
        managerUserIds: region.managerUsers.map((entry) => entry.userId),
      });
    }
  } else if (route.reviewerRecordIds.length === 1) {
    reviewer = personFromRecord(configuration, route.reviewerRecordIds[0], `路由“${route.recordId}”当前审核人`);
  } else if (route.reviewerUsers.length === 1 && route.reviewerUsers[0].userId) {
    reviewer = { recordId: "", userId: route.reviewerUsers[0].userId, name: route.reviewerUsers[0].name || route.reviewerUsers[0].userId };
  } else {
    throw routeError("FIXED_REVIEWER_INVALID", `审批路由“${route.recordId}”必须且只能维护一名当前审核人`, { routeRecordId: route.recordId, duty });
  }
  return {
    templateRecordId: structure.templateRecordId,
    templateName: structure.templateName,
    nodeIndex,
    nodeRecordId: node.nodeRecordId,
    nodeName: node.nodeName,
    nodeDuty: duty,
    routeRecordId: route.recordId,
    regionRecordId: region.recordId,
    regionCode: region.code,
    regionName: region.name,
    reviewerRecordId: reviewer.recordId,
    userId: reviewer.userId,
    name: reviewer.name || reviewer.userId,
    resolvedAt: new Date(at).toISOString(),
  };
}

module.exports = {
  APPROVAL_SHEETS,
  ALIASES,
  ApprovalConfigRepository,
  buildApprovalConfiguration,
  freezeApprovalStructure,
  resolveNodeReviewer,
  routeIsEffective,
  routeError,
};
