const assert = require("assert");
const { ALIASES, ApprovalConfigRepository, buildApprovalConfiguration, freezeApprovalStructure, resolveNodeReviewer } = require("../reviewer-router");

const text = (value) => [{ type: "text", text: String(value) }];
const option = (value) => [{ text: value }];
const record = (id, values) => ({ record_id: id, values });
const titles = {
  people: { personUserId: "企微人员ID", personName: "姓名" },
  stores: { storeRegion: "所属大区" },
  templates: { templateName: "审批模板名称", templateCode: "审批模板编码", templateStatus: "状态" },
  nodes: { nodeTemplate: "所属审批模板", nodeCode: "节点编码", nodeName: "节点名称", nodeOrder: "节点顺序", nodeDuty: "审核职责", nodeStatus: "状态" },
  routes: { routeTemplate: "所属审批模板", routeNode: "所属审批节点", routeRegion: "适用大区", routeDuty: "审核职责", routeReviewer: "当前审核人", routeStatus: "状态", routeStartsAt: "生效时间", routeEndsAt: "失效时间" },
  regions: { regionCode: "大区编码", regionName: "大区名称", regionManager: "产品经理", regionStatus: "状态" },
};

function records() {
  return {
    people: [
      record("person-a", { "企微人员ID": text("ManagerA"), "姓名": text("经理甲") }),
      record("person-b", { "企微人员ID": text("ManagerB"), "姓名": text("经理乙") }),
      record("person-fixed", { "企微人员ID": text("FixedUser"), "姓名": text("固定审核人") }),
      record("person-no-id", { "姓名": text("无账号人员") }),
    ],
    stores: [record("store-1", { "所属大区": ["region-south"] })],
    templates: [record("template-1", { "审批模板名称": text("产品上样审批"), "审批模板编码": text("SAMPLING"), "状态": option("启用") })],
    nodes: [
      record("node-1", { "所属审批模板": ["template-1"], "节点编码": text("PM"), "节点名称": text("产品经理审批"), "节点顺序": 1, "审核职责": option("产品经理"), "状态": option("启用") }),
      record("node-2", { "所属审批模板": ["template-1"], "节点编码": text("FIXED"), "节点名称": text("总部复核"), "节点顺序": 2, "审核职责": option("固定人员"), "状态": option("启用") }),
    ],
    routes: [
      record("route-pm", { "所属审批模板": ["template-1"], "所属审批节点": ["node-1"], "适用大区": ["region-south"], "审核职责": option("产品经理"), "状态": option("启用") }),
      record("route-fixed", { "所属审批模板": ["template-1"], "所属审批节点": ["node-2"], "适用大区": ["region-south"], "审核职责": option("固定人员"), "当前审核人": ["person-fixed"], "状态": option("启用") }),
    ],
    regions: [record("region-south", { "大区编码": text("SOUTH"), "大区名称": text("华南"), "产品经理": ["person-a"], "状态": option("启用") })],
  };
}

function setup(input = records()) {
  const configuration = buildApprovalConfiguration({ records: input, titles });
  const snapshot = freezeApprovalStructure(configuration, ["template-1"], "产品上样");
  const task = { storeRecordId: "store-1", storeName: "绿岛湖店" };
  const item = { name: "产品上样", approvalStructureSnapshot: snapshot };
  return { configuration, snapshot, task, item };
}

function testFreezeAndLiveManager() {
  const { configuration, snapshot, task, item } = setup();
  assert.deepStrictEqual(snapshot.nodes.map((node) => node.nodeRecordId), ["node-1", "node-2"]);
  const first = resolveNodeReviewer({ configuration, task, item, nodeIndex: 0 });
  assert.strictEqual(first.userId, "ManagerA");
  const nextRecords = records();
  nextRecords.regions[0].values["产品经理"] = ["person-b"];
  const changed = setup(nextRecords).configuration;
  const latest = resolveNodeReviewer({ configuration: changed, task, item, nodeIndex: 0 });
  assert.strictEqual(latest.userId, "ManagerB", "提交前换产品经理必须使用最新人员");
  const fixed = resolveNodeReviewer({ configuration: changed, task, item, nodeIndex: 1 });
  assert.strictEqual(fixed.userId, "FixedUser");
}

function testNativeWecomManagerAndLiveChange() {
  const nativeRecords = records();
  nativeRecords.regions[0].values["产品经理"] = [{ user_id: "ManagerA" }];
  const base = setup(nativeRecords);
  assert.strictEqual(resolveNodeReviewer(base).userId, "ManagerA");
  assert.strictEqual(resolveNodeReviewer(base).name, "经理甲", "成员字段只返回账号ID时应从人员主档补全中文姓名");

  nativeRecords.regions[0].values["产品经理"] = [{ user_id: "ManagerB", name: "经理乙" }];
  const changed = setup(nativeRecords);
  assert.strictEqual(resolveNodeReviewer({ configuration: changed.configuration, task: base.task, item: base.item }).userId, "ManagerB", "企业微信成员字段更新后必须实时使用最新产品经理");
}

function testAssignedReviewerCanBePersistedByCaller() {
  const { configuration, task, item } = setup();
  const assigned = resolveNodeReviewer({ configuration, task, item });
  const nextRecords = records();
  nextRecords.regions[0].values["产品经理"] = ["person-b"];
  assert.strictEqual(assigned.userId, "ManagerA", "节点分配后的审批记录不应被后续主档变化改写");
  assert.strictEqual(resolveNodeReviewer({ configuration: setup(nextRecords).configuration, task, item }).userId, "ManagerB", "新节点分配仍取最新人员");
}

function testMissingRegionRouteConflictAndMissingId() {
  const noRegion = records();
  noRegion.stores[0].values["所属大区"] = [];
  const base = setup();
  assert.throws(() => resolveNodeReviewer({ configuration: setup(noRegion).configuration, task: base.task, item: base.item }), (error) => error.code === "REVIEW_ROUTE_DIMENSION_MISSING");

  const noRoute = records();
  noRoute.routes = noRoute.routes.filter((entry) => entry.record_id !== "route-pm");
  assert.throws(() => resolveNodeReviewer({ configuration: setup(noRoute).configuration, task: base.task, item: base.item }), (error) => error.code === "REVIEW_ROUTE_NOT_FOUND");

  const conflict = records();
  conflict.routes.push(record("route-pm-2", { ...conflict.routes[0].values }));
  assert.throws(() => resolveNodeReviewer({ configuration: setup(conflict).configuration, task: base.task, item: base.item }), (error) => error.code === "REVIEW_ROUTE_CONFLICT");

  const noId = records();
  noId.regions[0].values["产品经理"] = ["person-no-id"];
  assert.throws(() => resolveNodeReviewer({ configuration: setup(noId).configuration, task: base.task, item: base.item }), (error) => error.code === "REVIEWER_WECOM_ID_MISSING");
}

function testNoHardCodedFallback() {
  const invalid = records();
  invalid.regions[0].values["产品经理"] = [];
  const base = setup();
  assert.throws(() => resolveNodeReviewer({ configuration: setup(invalid).configuration, task: base.task, item: base.item }), (error) => error.code === "REGION_PRODUCT_MANAGER_INVALID" && !/LinWenKai|管理员/.test(error.message));
}

function testLiveChineseFieldAliases() {
  assert(ALIASES.nodeName.includes("审批节点名称"), "应兼容智能表格现有的审批节点名称字段");
  assert(ALIASES.nodeDuty.includes("人员职责字段"), "应兼容智能表格现有的人员职责字段");
  assert(ALIASES.routeStatus.includes("是否生效"), "应兼容智能表格现有的路由生效字段");
}

async function testRepositoryLoadsIndependentSheetsInParallel() {
  const sheetEntries = Object.entries({ people: "08_人员主档", stores: "09_门店主档", templates: "17_审批模板", nodes: "18_审批节点设置", routes: "19_审批路由规则", regions: "20_大区主档" });
  const sheets = sheetEntries.map(([section, title]) => ({ title, sheet_id: section }));
  const fieldTitles = {
    people: ["企微人员ID", "姓名"], stores: ["所属大区"], templates: ["审批模板名称", "状态"],
    nodes: ["所属审批模板", "审批节点名称", "节点顺序", "审核职责", "状态"],
    routes: ["所属审批模板", "所属审批节点", "适用大区", "审核职责", "状态"],
    regions: ["大区编码", "大区名称", "产品经理", "状态"],
  };
  let activeFields = 0;
  let maximumActiveFields = 0;
  const client = {
    getSheets: async () => sheets,
    getFields: async (sheetId) => {
      activeFields += 1;
      maximumActiveFields = Math.max(maximumActiveFields, activeFields);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeFields -= 1;
      return fieldTitles[sheetId].map((title, index) => ({ field_id: `${sheetId}-${index}`, field_title: title, field_type: "FIELD_TYPE_TEXT" }));
    },
    getRecords: async () => [],
  };
  const result = await new ApprovalConfigRepository({ client }).load();
  assert.strictEqual(maximumActiveFields, 6, "六张审批配置表字段应并行读取");
  assert.deepStrictEqual(result.people, []);
}

async function main() {
  testFreezeAndLiveManager();
  testNativeWecomManagerAndLiveChange();
  testAssignedReviewerCanBePersistedByCaller();
  testMissingRegionRouteConflictAndMissingId();
  testNoHardCodedFallback();
  testLiveChineseFieldAliases();
  await testRepositoryLoadsIndependentSheetsInParallel();
  process.stdout.write("reviewer router tests passed\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
