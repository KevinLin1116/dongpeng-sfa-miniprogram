const assert = require("assert");
const path = require("path");

let page;
let previewOptions;
global.Page = (definition) => { page = definition; };
global.wx = { previewImage(options) { previewOptions = options; } };

const { initialReviewExpansion } = require(path.resolve(__dirname, "../miniprogram/pages/approval-detail/index.js"));

function main() {
  assert.deepStrictEqual(initialReviewExpansion([
    { products: [{ productRecordId: "p1" }, { productRecordId: "p2" }] },
    { products: [{ productRecordId: "p3" }] },
  ], true), {
    expandedGroups: { 0: true, 1: true },
    expandedProducts: { p1: true, p2: true, p3: true },
  }, "逐产品审核进入页面时应默认展开全部分组和产品，直接展示执行照片");
  assert.deepStrictEqual(initialReviewExpansion([{ products: [{ productRecordId: "p1" }] }], false), {
    expandedGroups: {}, expandedProducts: {},
  }, "普通审批页面不应套用逐产品展开规则");

  const context = {
    data: {
      approval: {
        evidenceGroups: [{ products: [
          { images: [{ image_url: "https://example.com/p1-a.jpg" }, { image_url: "https://example.com/p1-b.jpg" }] },
          { images: [{ image_url: "https://example.com/p2.jpg" }] },
        ] }],
        legacyImages: [{ image_url: "https://example.com/legacy.jpg" }],
      },
    },
  };
  page.preview.call(context, { currentTarget: { dataset: { url: "https://example.com/p1-b.jpg", groupIndex: 0, productIndex: 0 } } });
  assert.deepStrictEqual(previewOptions.urls, ["https://example.com/p1-a.jpg", "https://example.com/p1-b.jpg"], "预览不得混入其他产品照片");
  page.preview.call(context, { currentTarget: { dataset: { url: "https://example.com/legacy.jpg", legacy: 1 } } });
  assert.deepStrictEqual(previewOptions.urls, ["https://example.com/legacy.jpg"]);

  const reviewState = {
    approval: { canDecide: true, evidenceGroups: [{ products: [{ productRecordId: "p1", code: "P1", reviewRequired: true }, { productRecordId: "p2", code: "P2", reviewRequired: true }, { productRecordId: "p0", reviewRequired: false }] }] },
    productDecisions: {}, reviewSummary: {}, processing: false, expandedProducts: {}, reviewAlert: {},
  };
  const reviewContext = {
    data: reviewState,
    reviewProducts: page.reviewProducts,
    syncReviewSummary: page.syncReviewSummary,
    setData(patch) { Object.entries(patch).forEach(([key, value]) => { const parts = key.split("."); let target = reviewState; while (parts.length > 1) { const part = parts.shift(); target[part] = target[part] || {}; target = target[part]; } target[parts[0]] = value; }); },
  };
  page.setProductDecision.call(reviewContext, { currentTarget: { dataset: { id: "p1", decision: "qualified" } } });
  page.setProductDecision.call(reviewContext, { currentTarget: { dataset: { id: "p2", decision: "unqualified" } } });
  page.inputProductReason.call(reviewContext, { currentTarget: { dataset: { id: "p2" } }, detail: { value: "照片模糊" } });
  const decisions = page.buildProductDecisions.call(reviewContext);
  assert.deepStrictEqual(decisions, [{ productRecordId: "p1", decision: "qualified", reason: "" }, { productRecordId: "p2", decision: "unqualified", reason: "照片模糊" }]);
  assert.deepStrictEqual(reviewState.reviewSummary, { total: 2, decided: 2, qualified: 1, unqualified: 1 });

  reviewState.productDecisions.p2.reason = "";
  assert.strictEqual(page.buildProductDecisions.call(reviewContext), null);
  assert.strictEqual(reviewState.reviewAlert.visible, true);
  process.stdout.write("approval detail page tests passed\n");
}

main();
