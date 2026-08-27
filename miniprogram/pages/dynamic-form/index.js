const { call, uploadImage } = require("../../utils/api");
const { cloneEmptyOperationProgress, startOperationFeedback } = require("../../utils/operation-feedback");

Page({
  data: { loading: true, item: null, values: {}, uploading: {}, saving: false, readOnly: false, operationProgress: cloneEmptyOperationProgress() },
  onLoad(query) { this.taskId = query.taskId; this.itemId = query.itemId; this.completeRequestId = ""; this.setData({ readOnly: query.readOnly === "1" }); this.load(); },
  onUnload() { clearTimeout(this.saveTimer); if (this.operationFeedback) this.operationFeedback.dispose(); },
  async load() {
    try { const data = await call("getTaskItemForm", { taskId: this.taskId, itemId: this.itemId }); const values = { ...data.values }; data.item.fields.forEach((field) => { if (values[field.key] === undefined) values[field.key] = field.inputType === "image" ? [] : ""; }); this.setData({ ...data, values, readOnly: data.readOnly === true || this.data.readOnly, loading: false }); }
    catch (_) { this.setData({ loading: false }); }
  },
  setValue(event) { if (this.data.readOnly) return; this.setData({ [`values.${event.currentTarget.dataset.key}`]: event.detail.value }); this.autoSave(); },
  setChoice(event) { if (this.data.readOnly) return; const field = this.data.item.fields.find((entry) => entry.key === event.currentTarget.dataset.key); this.setData({ [`values.${field.key}`]: field.options[event.detail.value] }); this.autoSave(); },
  autoSave() { if (this.data.readOnly) return; clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => { this.saveTimer = null; const values = JSON.parse(JSON.stringify(this.data.values)); this.autoSaveChain = (this.autoSaveChain || Promise.resolve()).then(() => call("saveItemDraft", { taskId: this.taskId, itemId: this.itemId, values, preSyncImages: true }, { silent: true })).catch(() => {}); }, 700); },
  chooseImages(event) {
    if (this.data.readOnly) return;
    const key = event.currentTarget.dataset.key; const field = this.data.item.fields.find((entry) => entry.key === key); const current = this.data.values[key] || [];
    const remaining = field.maxImages ? Math.max(1, field.maxImages - current.length) : 9;
    wx.chooseMedia({ count: Math.min(9, remaining), mediaType: ["image"], sourceType: ["camera", "album"], success: async ({ tempFiles }) => {
      this.setData({ [`uploading.${key}`]: true });
      try { const ids = await Promise.all(tempFiles.map((file) => uploadImage(file.tempFilePath, `tasks/${this.taskId}/${this.itemId}`))); this.setData({ [`values.${key}`]: current.concat(ids) }); this.autoSave(); }
      finally { this.setData({ [`uploading.${key}`]: false }); }
    }});
  },
  previewImage(event) { const key = event.currentTarget.dataset.key; const index = Number(event.currentTarget.dataset.index) || 0; const urls = this.data.values[key] || []; if (urls.length) wx.previewImage({ current: urls[index], urls }); },
  removeImage(event) { if (this.data.readOnly) return; const { key, index } = event.currentTarget.dataset; const images = [...(this.data.values[key] || [])]; images.splice(index, 1); this.setData({ [`values.${key}`]: images }); this.autoSave(); },
  async save() {
    if (this.data.readOnly || this.data.saving) return; this.setData({ saving: true });
    clearTimeout(this.saveTimer); this.saveTimer = null;
    this.operationFeedback = startOperationFeedback(this, { title: "正在保存任务项", stages: [
      { after: 0, message: "正在完成草稿保存和内容校验" },
      { after: 1800, message: "正在写入业务结果" },
      { after: 4300, message: "正在同步任务进度到企业微信" },
    ] });
    try {
      if (this.autoSaveChain) await this.autoSaveChain;
      this.completeRequestId = this.completeRequestId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await call("completeTaskItem", { taskId: this.taskId, itemId: this.itemId, values: this.data.values, requestId: this.completeRequestId }, { silent: true });
      await this.operationFeedback.succeed("任务项已保存");
      wx.navigateBack();
    } catch (error) {
      this.operationFeedback.fail();
      wx.showModal({ title: "保存失败", content: error.message || "服务暂时不可用，请稍后重试。", showCancel: false, confirmText: "知道了" });
    } finally { this.operationFeedback = null; this.setData({ saving: false }); }
  },
  goBack() { wx.navigateBack(); },
});
