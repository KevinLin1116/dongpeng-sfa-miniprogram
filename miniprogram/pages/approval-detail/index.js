const { call } = require("../../utils/api");
const { cloneEmptyOperationProgress, startOperationFeedback } = require("../../utils/operation-feedback");

function initialReviewExpansion(evidenceGroups, productReview) {
  const expandedGroups = {};
  const expandedProducts = {};
  if (!productReview) return { expandedGroups, expandedProducts };
  evidenceGroups.forEach((group, groupIndex) => {
    expandedGroups[groupIndex] = true;
    (group.products || []).forEach((product) => {
      if (product.productRecordId) expandedProducts[product.productRecordId] = true;
    });
  });
  return { expandedGroups, expandedProducts };
}

Page({
  data: {
    loading: true,
    approval: null,
    processing: false,
    productDecisions: {},
    reviewSummary: { total: 0, decided: 0, qualified: 0, unqualified: 0 },
    expandedGroups: {},
    expandedProducts: {},
    reviewAlert: { visible: false, title: "", message: "", items: [] },
    operationProgress: cloneEmptyOperationProgress(),
  },

  onLoad(query) { this.id = query.id; this.decisionRequestId = ""; this.load(); },
  onUnload() { if (this.operationFeedback) this.operationFeedback.dispose(); },

  async load() {
    try {
      const source = await call("getApproval", { approvalId: this.id });
      const evidenceGroups = Array.isArray(source.evidenceGroups) ? source.evidenceGroups.map((group, groupIndex) => ({
        ...group,
        products: (group.products || []).map((product) => ({
          ...product,
          images: (product.images || []).map((image) => typeof image === "string" ? { image_url: image } : image),
        })),
        reviewRequiredCount: (group.products || []).filter((product) => product.reviewRequired !== false).length,
        qualifiedCount: (group.products || []).filter((product) => product.currentStatus === "qualified").length,
        groupIndex,
      })).filter((group) => group.products.length) : [];
      const legacyImages = (source.images || []).map((image) => typeof image === "string" ? { image_url: image } : image);
      const imageUrls = evidenceGroups.length
        ? evidenceGroups.flatMap((group) => group.products.flatMap((product) => product.images.map((image) => image.image_url).filter(Boolean)))
        : legacyImages.map((image) => image.image_url).filter(Boolean);
      const productReview = source.reviewMode === "product";
      const { expandedGroups, expandedProducts } = initialReviewExpansion(evidenceGroups, productReview);
      const approval = { ...source, evidenceGroups, legacyImages, imageUrls, productReview };
      this.setData({ approval, expandedGroups, expandedProducts, loading: false });
      this.syncReviewSummary();
    } catch (_) { this.setData({ loading: false }); }
  },

  reviewProducts() {
    return (this.data.approval?.evidenceGroups || []).flatMap((group) => group.products || []).filter((product) => product.reviewRequired !== false);
  },

  syncReviewSummary() {
    const products = this.reviewProducts();
    const decisions = this.data.productDecisions || {};
    const values = products.map((product) => decisions[product.productRecordId]).filter(Boolean);
    this.setData({ reviewSummary: {
      total: products.length,
      decided: values.filter((entry) => entry.decision).length,
      qualified: values.filter((entry) => entry.decision === "qualified").length,
      unqualified: values.filter((entry) => entry.decision === "unqualified").length,
    } });
  },

  setProductDecision(event) {
    if (!this.data.approval?.canDecide || this.data.processing) return;
    const productRecordId = String(event.currentTarget.dataset.id || "");
    const decision = String(event.currentTarget.dataset.decision || "");
    if (!productRecordId || !["qualified", "unqualified"].includes(decision)) return;
    const current = this.data.productDecisions[productRecordId] || {};
    const productDecisions = { ...this.data.productDecisions, [productRecordId]: { decision, reason: decision === "unqualified" ? (current.reason || "") : "" } };
    this.setData({ productDecisions, [`expandedProducts.${productRecordId}`]: decision === "unqualified" ? true : this.data.expandedProducts[productRecordId] });
    this.syncReviewSummary();
  },

  inputProductReason(event) {
    const productRecordId = String(event.currentTarget.dataset.id || "");
    const current = this.data.productDecisions[productRecordId] || { decision: "unqualified" };
    this.setData({ [`productDecisions.${productRecordId}`]: { ...current, decision: "unqualified", reason: event.detail.value } });
    this.syncReviewSummary();
  },

  markAllQualified() {
    if (!this.data.approval?.canDecide || this.data.processing) return;
    const productDecisions = { ...this.data.productDecisions };
    this.reviewProducts().forEach((product) => { productDecisions[product.productRecordId] = { decision: "qualified", reason: "" }; });
    this.setData({ productDecisions });
    this.syncReviewSummary();
  },

  toggleGroup(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ [`expandedGroups.${index}`]: !this.data.expandedGroups[index] });
  },

  toggleProduct(event) {
    const id = String(event.currentTarget.dataset.id || "");
    if (id) this.setData({ [`expandedProducts.${id}`]: !this.data.expandedProducts[id] });
  },

  preview(event) {
    const { url, groupIndex, productIndex, legacy } = event.currentTarget.dataset;
    if (!url) return;
    let urls = [];
    if (legacy) urls = (this.data.approval.legacyImages || []).map((image) => image.image_url).filter(Boolean);
    else {
      const product = this.data.approval.evidenceGroups?.[Number(groupIndex)]?.products?.[Number(productIndex)];
      urls = (product?.images || []).map((image) => image.image_url).filter(Boolean);
    }
    wx.previewImage({ current: url, urls: urls.length ? urls : [url] });
  },

  buildProductDecisions() {
    const missing = [];
    const reasons = [];
    const decisions = this.reviewProducts().map((product) => {
      const entry = this.data.productDecisions[product.productRecordId] || {};
      if (!entry.decision) missing.push(product.code || product.name || product.productRecordId);
      if (entry.decision === "unqualified" && !String(entry.reason || "").trim()) reasons.push(product.code || product.name || product.productRecordId);
      return { productRecordId: product.productRecordId, decision: entry.decision || "", reason: String(entry.reason || "").trim() };
    });
    if (missing.length || reasons.length) {
      const items = [];
      if (missing.length) items.push(`尚未判断：${missing.join("、")}`);
      if (reasons.length) items.push(`请填写不合格原因：${reasons.join("、")}`);
      this.setData({ reviewAlert: { visible: true, title: "审核结果未完成", message: "请逐一判断本轮所有待审核产品。", items } });
      return null;
    }
    return decisions;
  },

  closeReviewAlert() { this.setData({ "reviewAlert.visible": false }); },
  noop() {},
  submitProductReview() { const decisions = this.buildProductDecisions(); if (decisions) this.decide("", "", decisions); },
  approve() { this.decide("approved"); },
  reject() { wx.showModal({ title: "退回整改", editable: true, placeholderText: "请填写明确的整改原因", confirmText: "确认退回", success: (res) => { if (res.confirm && res.content.trim()) this.decide("rejected", res.content.trim()); } }); },

  async decide(decision, reason = "", productDecisions = null) {
    if (this.data.processing) return;
    this.setData({ processing: true });
    this.operationFeedback = startOperationFeedback(this, {
      title: "正在提交审核结果",
      hint: "正在同步产品结果和审批记录，请勿重复提交",
      stages: [
        { after: 0, message: "正在校验本次产品审核结果" },
        { after: 1600, message: "正在更新产品合格与退回状态" },
        { after: 4300, message: "正在同步任务项和任务状态" },
        { after: 7000, message: "正在写入审核记录" },
      ],
    });
    try {
      this.decisionRequestId = this.decisionRequestId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const payload = { approvalId: this.id, requestId: this.decisionRequestId };
      if (productDecisions) payload.productDecisions = productDecisions;
      else Object.assign(payload, { decision, reason });
      const result = await call("decideApproval", payload, { silent: true });
      const title = result.status === "pending" ? "已流转下一节点" : result.status === "approved" ? "审核完成" : "已退回整改";
      await this.operationFeedback.succeed(title);
      wx.navigateBack();
    } catch (error) {
      this.operationFeedback.fail();
      this.decisionRequestId = "";
      this.setData({ reviewAlert: { visible: true, title: "审核提交失败", message: error.message || "服务暂时不可用，请稍后重试。", items: [] } });
    }
    finally { this.operationFeedback = null; this.setData({ processing: false }); }
  },

  goBack() { wx.navigateBack(); },
});

module.exports = { initialReviewExpansion };
