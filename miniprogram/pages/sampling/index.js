const { call, uploadImage } = require("../../utils/api");
const { cloneEmptyOperationProgress, startOperationFeedback } = require("../../utils/operation-feedback");

Page({
  data: {
    loading: true,
    productRule: null,
    groups: [],
    navGroups: [],
    expandedSections: {},
    expandedProducts: {},
    activeGroup: 0,
    values: {},
    uploading: {},
    saving: false,
    readOnly: false,
    currentRound: 0,
    rejectionReason: "",
    approvalStatus: "",
    errorProductAnchor: "",
    autoSaveNotice: { visible: false, status: "", title: "", message: "" },
    saveAlert: { visible: false, title: "", summary: "", message: "", items: [], hasTarget: false, targetAnchor: "" },
    operationProgress: cloneEmptyOperationProgress(),
  },

  onLoad(query) {
    this.taskId = query.taskId;
    this.itemId = query.itemId;
    this.completeRequestId = "";
    this.setData({ readOnly: query.readOnly === "1" });
    this.load();
  },

  onUnload() {
    if (this.autoSaveNoticeTimer) clearTimeout(this.autoSaveNoticeTimer);
    if (this.operationFeedback) this.operationFeedback.dispose();
  },

  async load() {
    try {
      const data = await call("getSamplingForm", { taskId: this.taskId, itemId: this.itemId });
      const values = { ...data.values };
      (data.groups || []).forEach((group) => (group.products || []).forEach((product) => {
        if (!Array.isArray(values[product.id])) values[product.id] = [];
      }));
      const groups = this.decorateGroups(data.groups, values);
      const initialNavigation = this.buildGroupNavigation(groups);
      const firstSection = initialNavigation[0];
      const activeGroup = firstSection && firstSection.children.length ? firstSection.children[0].groupIndex : 0;
      const expandedSections = firstSection ? { [firstSection.key]: true } : {};
      const expandedProducts = this.defaultExpandedProducts(groups[activeGroup]);
      this.setData({
        ...data,
        groups,
        navGroups: this.buildGroupNavigation(groups, activeGroup, expandedSections),
        expandedSections,
        expandedProducts,
        activeGroup,
        values,
        readOnly: data.readOnly === true || this.data.readOnly,
        loading: false,
      });
    } catch (_) {
      this.setData({ loading: false });
    }
  },

  decorateGroups(groups, values, validationErrors = []) {
    const errors = new Map(validationErrors.filter((error) => error.productRecordId).map((error) => [error.productRecordId, error.message]));
    return (groups || []).map((group) => {
      const groupMinimumValue = group.requiredProducts !== undefined && group.requiredProducts !== null ? group.requiredProducts : group.minRequired;
      const requiredProducts = Number(groupMinimumValue || 0);
      const sourceProducts = group.products || [];
      const products = sourceProducts.map((product) => {
        const count = (values[product.id] || []).length;
        const maximum = product.maxPhotos === null || product.maxPhotos === undefined || product.maxPhotos === "" ? 20 : Number(product.maxPhotos);
        const minimum = Number(product.minPhotos || 1);
        return {
          ...product,
          photoCount: count,
          canAdd: product.editable !== false && count < maximum,
          photoHint: product.maxPhotos === null || product.maxPhotos === undefined || product.maxPhotos === "" ? `至少${minimum}张` : `${minimum}–${maximum}张`,
          validationError: errors.get(product.id) || "",
        };
      });
      const reportedProducts = products.filter((product) => product.photoCount > 0).length;
      const completedProducts = products.filter((product) => product.reviewState === "qualified" || product.photoCount >= Number(product.minPhotos || 1)).length;
      const partiallyInvalid = products.some((product) => product.photoCount > 0 && product.photoCount < Number(product.minPhotos || 1));
      const errorProducts = products.filter((product) => product.validationError);
      const progressText = requiredProducts === 0 ? `已选${reportedProducts}` : `${reportedProducts}/${requiredProducts}`;
      return {
        ...group,
        products,
        completedProducts,
        reportedProducts,
        productTotal: products.length,
        requiredProducts,
        ruleText: `${products.length}选${requiredProducts}`,
        qualified: !partiallyInvalid && completedProducts >= requiredProducts,
        qualificationText: !partiallyInvalid && completedProducts >= requiredProducts ? "达标" : "未达标",
        progressText,
        hasError: errorProducts.length > 0,
        errorCount: errorProducts.length,
        firstErrorProductId: errorProducts.length ? errorProducts[0].id : "",
      };
    });
  },

  buildGroupNavigation(groups, activeGroup = 0, expandedSections = {}) {
    const priority = { "必上": 0, "三选一": 1, "选上": 2 };
    const sections = [];
    const sectionMap = {};
    (groups || []).forEach((group, groupIndex) => {
      const level1Name = String(group.level1Name || group.ruleLabel || "其他").trim() || "其他";
      const level2Name = String(group.level2Name || group.name || "未命名分组").trim() || "未命名分组";
      if (!sectionMap[level1Name]) {
        sectionMap[level1Name] = { key: level1Name, level1Name, sourceOrder: sections.length, children: [] };
        sections.push(sectionMap[level1Name]);
      }
      sectionMap[level1Name].children.push({
        id: group.id || `group-${groupIndex}`,
        groupIndex,
        level2Name,
        progressText: group.progressText,
        qualified: group.qualified === true,
        productTotal: group.productTotal,
        hasError: group.hasError,
        errorCount: group.errorCount,
      });
    });
    sections.sort((left, right) => {
      const leftPriority = Object.prototype.hasOwnProperty.call(priority, left.level1Name) ? priority[left.level1Name] : 100;
      const rightPriority = Object.prototype.hasOwnProperty.call(priority, right.level1Name) ? priority[right.level1Name] : 100;
      return leftPriority - rightPriority || left.sourceOrder - right.sourceOrder;
    });
    return sections.map((section) => ({
      ...section,
      active: section.children.some((child) => child.groupIndex === activeGroup),
      expanded: expandedSections[section.key] === true,
    }));
  },

  syncGroupProgress(validationErrors = []) {
    const groups = this.decorateGroups(this.data.groups, this.data.values, validationErrors);
    this.setData({
      groups,
      navGroups: this.buildGroupNavigation(groups, this.data.activeGroup, this.data.expandedSections),
    });
  },

  defaultExpandedProducts(group, preferredProductId = "") {
    const products = group && Array.isArray(group.products) ? group.products : [];
    const preferred = preferredProductId && products.find((product) => product.id === preferredProductId);
    const target = preferred || products[0];
    return target && target.id ? { [target.id]: true } : {};
  },

  toggleSection(event) {
    const key = String(event.currentTarget.dataset.key || "");
    const groupIndex = Number(event.currentTarget.dataset.index);
    const expandedSections = { ...this.data.expandedSections, [key]: !this.data.expandedSections[key] };
    const activeGroup = expandedSections[key] && Number.isInteger(groupIndex) ? groupIndex : this.data.activeGroup;
    const expandedProducts = expandedSections[key]
      ? this.defaultExpandedProducts(this.data.groups[activeGroup])
      : this.data.expandedProducts;
    this.setData({
      expandedSections,
      expandedProducts,
      activeGroup,
      errorProductAnchor: "",
      navGroups: this.buildGroupNavigation(this.data.groups, activeGroup, expandedSections),
    });
  },

  selectGroup(event) {
    const activeGroup = Number(event.currentTarget.dataset.index);
    const group = this.data.groups[activeGroup];
    const firstErrorProductId = group && group.firstErrorProductId;
    this.setData({
      activeGroup,
      expandedProducts: this.defaultExpandedProducts(group, firstErrorProductId),
      navGroups: this.buildGroupNavigation(this.data.groups, activeGroup, this.data.expandedSections),
      errorProductAnchor: firstErrorProductId ? `product-${firstErrorProductId}` : "",
    });
  },

  toggleProduct(event) {
    const productId = String(event.currentTarget.dataset.id || "");
    if (!productId) return;
    this.setData({ expandedProducts: { ...this.data.expandedProducts, [productId]: !this.data.expandedProducts[productId] } });
  },

  showAutoSaveNotice(status, message, autoHideMs = 0) {
    if (this.autoSaveNoticeTimer) clearTimeout(this.autoSaveNoticeTimer);
    const titles = { saving: "正在自动保存", saved: "已自动保存", failed: "自动保存失败" };
    this.setData({ autoSaveNotice: { visible: true, status, title: titles[status] || "自动保存", message: message || "" } });
    if (autoHideMs > 0) {
      this.autoSaveNoticeTimer = setTimeout(() => {
        this.setData({ "autoSaveNotice.visible": false });
        this.autoSaveNoticeTimer = null;
      }, autoHideMs);
    }
  },

  buildSaveAlert(error, validationErrors = []) {
    const items = Array.from(new Set((validationErrors || []).map((item) => String(item.message || "").trim()).filter(Boolean)));
    const validationFailed = items.length > 0;
    const first = validationErrors && validationErrors.length ? validationErrors[0] : {};
    return {
      visible: true,
      title: validationFailed ? "暂时不能保存" : "保存失败",
      summary: validationFailed ? `还有 ${items.length} 项要求未完成，请处理后再保存。` : "本次保存未成功，请查看原因后重试。",
      message: validationFailed ? "" : String((error && error.message) || "服务暂时不可用，请稍后重试。"),
      items,
      hasTarget: validationFailed,
      targetAnchor: first.productRecordId ? `product-${first.productRecordId}` : "",
    };
  },

  closeSaveAlert() {
    this.setData({ "saveAlert.visible": false });
  },

  goToFirstIssue() {
    const targetAnchor = this.data.saveAlert.targetAnchor;
    this.setData({ "saveAlert.visible": false, errorProductAnchor: "" });
    if (targetAnchor) {
      setTimeout(() => this.setData({ errorProductAnchor: targetAnchor }), 60);
    }
  },

  noop() {},

  queueAutoSave(values) {
    this.autoSaveSequence = Number(this.autoSaveSequence || 0) + 1;
    const sequence = this.autoSaveSequence;
    this.showAutoSaveNotice("saving", "正在保存本次上样记录");
    const prior = this.autoSaveChain ? this.autoSaveChain.catch(() => {}) : Promise.resolve();
    const request = prior
      .then(() => call("saveItemDraft", { taskId: this.taskId, itemId: this.itemId, values, preSyncImages: true }, { silent: true }))
      .then((result) => {
        if (sequence === this.autoSaveSequence) {
          const pending = result?.imagePreSync?.status === "pending";
          this.showAutoSaveNotice(pending ? "saving" : "saved", pending ? "草稿已保存，照片将在正式保存时重试" : "草稿和照片已预同步", pending ? 2600 : 1600);
        }
        return result;
      })
      .catch((error) => {
        if (sequence === this.autoSaveSequence) this.showAutoSaveNotice("failed", error.message || "请检查网络后重试", 3200);
        error.autoSaveNoticeShown = true;
        throw error;
      });
    this.autoSaveChain = request.catch(() => {});
    return request;
  },

  chooseImage(event) {
    if (this.data.readOnly) return;
    const productId = event.currentTarget.dataset.id;
    const current = this.data.values[productId] || [];
    const product = this.data.groups.reduce((all, group) => all.concat(group.products || []), []).find((entry) => entry.id === productId);
    if (!product || product.editable === false) return;
    const maximum = product.maxPhotos === null || product.maxPhotos === undefined || product.maxPhotos === "" ? 20 : Number(product.maxPhotos);
    const remaining = maximum - current.length;
    if (remaining <= 0) {
      wx.showToast({ title: `该产品最多上传${maximum}张`, icon: "none" });
      return;
    }
    wx.chooseMedia({
      count: Math.min(9, remaining),
      mediaType: ["image"],
      sourceType: ["camera", "album"],
      success: async ({ tempFiles }) => {
        this.setData({ [`uploading.${productId}`]: true });
        try {
          const fileIDs = await Promise.all(tempFiles.map(({ tempFilePath }) => uploadImage(tempFilePath, `sampling/${this.taskId}/${productId}`)));
          const values = current.concat(fileIDs);
          this.setData({ [`values.${productId}`]: values });
          this.syncGroupProgress();
          const snapshot = JSON.parse(JSON.stringify(this.data.values));
          // 云存储上传完成即可继续操作；企业微信图片预同步在自动保存链中后台执行。
          // 点击正式保存时会等待尚未结束的预同步，避免重复上传同一张照片。
          this.queueAutoSave(snapshot).catch(() => {});
        } catch (error) {
          if (!error.autoSaveNoticeShown) wx.showToast({ title: error.message || "照片上传失败", icon: "none" });
        } finally {
          this.setData({ [`uploading.${productId}`]: false });
        }
      },
    });
  },

  previewImage(event) {
    const id = event.currentTarget.dataset.id;
    const index = Number(event.currentTarget.dataset.index) || 0;
    const urls = this.data.values[id] || [];
    if (urls.length) wx.previewImage({ current: urls[index], urls });
  },

  removeImage(event) {
    if (this.data.readOnly) return;
    const { id, index } = event.currentTarget.dataset;
    const product = this.data.groups.reduce((all, group) => all.concat(group.products || []), []).find((entry) => entry.id === id);
    if (!product || product.editable === false) return;
    const images = [...(this.data.values[id] || [])];
    images.splice(index, 1);
    this.setData({ [`values.${id}`]: images });
    this.syncGroupProgress();
    const snapshot = JSON.parse(JSON.stringify(this.data.values));
    this.queueAutoSave(snapshot).catch(() => {});
  },

  async save() {
    if (this.data.readOnly || this.data.saving) return;
    this.setData({ saving: true });
    this.operationFeedback = startOperationFeedback(this, {
      title: "正在保存产品上样",
      hint: "首次保存需要把现场照片同步到企业微信，请勿退出页面",
      stages: [
        { after: 0, message: "正在校验分组规则和照片完整性" },
        { after: 1500, message: "正在并行同步现场照片" },
        { after: 5200, message: "正在保存产品上样结果" },
        { after: 8500, message: "正在同步任务项和任务进度" },
      ],
    });
    try {
      if (this.autoSaveChain) await this.autoSaveChain;
      this.completeRequestId = this.completeRequestId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await call("completeTaskItem", { taskId: this.taskId, itemId: this.itemId, values: this.data.values, requestId: this.completeRequestId }, { silent: true });
      await this.operationFeedback.succeed("产品上样已保存");
      wx.navigateBack();
    } catch (error) {
      this.operationFeedback.fail();
      const validationErrors = error.details && Array.isArray(error.details.errors) ? error.details.errors : [];
      const saveAlert = this.buildSaveAlert(error, validationErrors);
      if (validationErrors.length) {
        const first = validationErrors[0];
        const errorGroupId = first.ruleRecordId || first.groupRecordId;
        const groupIndex = this.data.groups.findIndex((group) => (group.ruleRecordId || group.groupRecordId || group.id) === errorGroupId);
        const activeGroup = groupIndex >= 0 ? groupIndex : this.data.activeGroup;
        const activeGroupData = this.data.groups[activeGroup] || {};
        const sectionKey = String(activeGroupData.level1Name || activeGroupData.ruleLabel || "其他").trim() || "其他";
        const expandedSections = { ...this.data.expandedSections, [sectionKey]: true };
        const expandedProducts = first.productRecordId ? { ...this.data.expandedProducts, [first.productRecordId]: true } : this.data.expandedProducts;
        const groups = this.decorateGroups(this.data.groups, this.data.values, validationErrors);
        this.setData({
          activeGroup,
          expandedSections,
          expandedProducts,
          errorProductAnchor: first.productRecordId ? `product-${first.productRecordId}` : "",
          groups,
          navGroups: this.buildGroupNavigation(groups, activeGroup, expandedSections),
          saveAlert,
        });
      } else {
        this.setData({ saveAlert });
      }
      this.completeRequestId = "";
    } finally {
      this.operationFeedback = null;
      this.setData({ saving: false });
    }
  },

  goBack() {
    wx.navigateBack();
  },
});
