const assert = require("assert");
const path = require("path");

let page;
let callCount = 0;
global.Page = (definition) => { page = definition; };
global.wx = {
  cloud: {
    async callFunction() {
      callCount += 1;
      if (callCount === 1) return { result: { ok: false, code: "SAVE_FAILED", message: "模拟保存失败" } };
      return { result: { ok: true, data: { saved: true } } };
    },
  },
  showToast() {},
};

require(path.resolve(__dirname, "../miniprogram/pages/sampling/index.js"));

async function main() {
  const decorated = page.decorateGroups([{ id: "g1", level1Name: "必上", minRequired: 1, products: [{ id: "p1", minPhotos: 1 }, { id: "p2", minPhotos: 1 }] }], { p1: [], p2: [] }, [{ productRecordId: "p2", message: "至少上传1张" }]);
  assert.strictEqual(decorated[0].errorCount, 1);
  assert.strictEqual(decorated[0].firstErrorProductId, "p2");
  assert.strictEqual(decorated[0].ruleText, "2选1");
  assert.strictEqual(decorated[0].reportedProducts, 0);
  assert.strictEqual(decorated[0].qualificationText, "未达标");
  assert.strictEqual(decorated[0].products[0].photoHint, "至少1张");

  const reported = page.decorateGroups([{ id: "g1", level1Name: "必上", minRequired: 1, products: [{ id: "p1", minPhotos: 1 }, { id: "p2", minPhotos: 1 }] }], { p1: ["cloud://env/p1.jpg"], p2: [] });
  assert.strictEqual(reported[0].reportedProducts, 1);
  assert.strictEqual(reported[0].qualificationText, "达标");

  const rectification = page.decorateGroups([{ id: "g1", minRequired: 2, products: [
    { id: "qualified", minPhotos: 1, reviewState: "qualified", editable: false },
    { id: "rectify", minPhotos: 1, reviewState: "rectify", editable: true, rejectionReason: "重拍" },
    { id: "candidate", minPhotos: 1, reviewState: "candidate", editable: true },
  ] }], { qualified: ["cloud://old-qualified"], rectify: [], candidate: [] });
  assert.strictEqual(rectification[0].completedProducts, 1, "历史合格产品必须计入分组达标数");
  assert.strictEqual(rectification[0].products[0].canAdd, false, "历史合格产品不可再上传");
  assert.deepStrictEqual(rectification[0].products.map((product) => product.id), ["qualified", "rectify", "candidate"], "补充候选产品必须直接进入当前二级分组列表");

  const optional = page.decorateGroups([{ id: "optional", minRequired: 0, products: [{ id: "p3", minPhotos: 1 }] }], { p3: [] });
  assert.strictEqual(optional[0].progressText, "已选0");
  const selectedOptional = page.decorateGroups(optional, { p3: ["cloud://env/p3.jpg"] });
  assert.strictEqual(selectedOptional[0].progressText, "已选1");

  const groupedNavigation = page.buildGroupNavigation([
    { id: "three-1", level1Name: "三选一", level2Name: "三选一 1", progressText: "0/1", productTotal: 3 },
    { id: "must-1", level1Name: "必上", level2Name: "必上 1", progressText: "2/2", qualified: true, productTotal: 2 },
    { id: "optional-1", level1Name: "选上", level2Name: "分组 1", progressText: "已选0", productTotal: 1 },
    { id: "three-2", level1Name: "三选一", level2Name: "三选一 2", progressText: "0/1", productTotal: 3 },
    { id: "must-2", level1Name: "必上", level2Name: "必上 2", progressText: "0/2", productTotal: 2 },
  ], 4, { "必上": true });
  assert.deepStrictEqual(groupedNavigation.map((section) => section.level1Name), ["必上", "三选一", "选上"]);
  assert.deepStrictEqual(groupedNavigation[0].children.map((child) => child.level2Name), ["必上 1", "必上 2"]);
  assert.deepStrictEqual(groupedNavigation[1].children.map((child) => child.level2Name), ["三选一 1", "三选一 2"]);
  assert.strictEqual(groupedNavigation[0].active, true);
  assert.strictEqual(groupedNavigation[0].expanded, true);
  assert.strictEqual(groupedNavigation[1].expanded, false);
  assert.strictEqual(groupedNavigation[0].children[0].qualified, true);
  assert.strictEqual(groupedNavigation[0].children[1].qualified, false);
  assert.strictEqual(groupedNavigation[0].children[1].groupIndex, 4);

  const state = { groups: decorated, expandedSections: { "必上": true }, expandedProducts: {} };
  page.selectGroup.call({ data: state, buildGroupNavigation: page.buildGroupNavigation, defaultExpandedProducts: page.defaultExpandedProducts, setData(value) { Object.assign(state, value); } }, { currentTarget: { dataset: { index: 0 } } });
  assert.strictEqual(state.errorProductAnchor, "product-p2");
  assert.deepStrictEqual(state.expandedProducts, { p2: true }, "存在校验错误时应优先展开首个错误产品");

  assert.deepStrictEqual(page.defaultExpandedProducts(rectification[0]), { qualified: true }, "进入二级分组默认只展开第一个产品");

  const productState = { expandedProducts: {} };
  page.toggleProduct.call({ data: productState, setData(value) { Object.assign(productState, value); } }, { currentTarget: { dataset: { id: "p1" } } });
  assert.strictEqual(productState.expandedProducts.p1, true);
  page.toggleProduct.call({ data: productState, setData(value) { Object.assign(productState, value); } }, { currentTarget: { dataset: { id: "p1" } } });
  assert.strictEqual(productState.expandedProducts.p1, false);

  const validationAlert = page.buildSaveAlert(new Error("未达标"), [
    { message: "三选一 / 三选一 1 至少完成1款", productRecordId: "p1" },
    { message: "三选一 / 三选一 1 至少完成1款", productRecordId: "p1" },
    { message: "必上 / 必上 2 至少完成2款" },
  ]);
  assert.strictEqual(validationAlert.title, "暂时不能保存");
  assert.strictEqual(validationAlert.items.length, 2, "相同校验文案应合并，避免弹窗重复展示");
  assert.strictEqual(validationAlert.targetAnchor, "product-p1");
  assert.strictEqual(validationAlert.hasTarget, true);

  const notices = [];
  const queueContext = {
    taskId: "task-1",
    itemId: "item-1",
    autoSaveChain: null,
    autoSaveSequence: 0,
    showAutoSaveNotice(status, message) { notices.push({ status, message }); },
  };
  await assert.rejects(() => page.queueAutoSave.call(queueContext, { p1: ["cloud://1"] }), /模拟保存失败/);
  const retried = await page.queueAutoSave.call(queueContext, { p1: ["cloud://1", "cloud://2"] });
  assert.deepStrictEqual(retried, { saved: true }, "一次保存失败后，后续自动保存仍必须继续执行");
  assert.deepStrictEqual(notices.map((notice) => notice.status), ["saving", "failed", "saving", "saved"]);
  process.stdout.write("sampling page tests passed\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
