const { call, uploadImage } = require("../../utils/api");
const { cloneEmptyOperationProgress, startOperationFeedback } = require("../../utils/operation-feedback");
const { createAttendanceWatermark } = require("../../utils/photo-watermark");

function capturedAtText(value = new Date()) {
  const pad = (number) => String(number).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

Page({
  data: { loading: true, item: null, values: {}, attendanceEvidence: {}, taskContext: {}, uploading: {}, saving: false, readOnly: false, operationProgress: cloneEmptyOperationProgress() },
  onLoad(query) { this.taskId = query.taskId; this.itemId = query.itemId; this.flow = query.flow || ""; this.role = query.role || ""; this.nextItemId = query.nextItemId || ""; this.completeRequestId = ""; this.setData({ readOnly: query.readOnly === "1" }); this.load(); },
  onUnload() { clearTimeout(this.saveTimer); if (this.operationFeedback) this.operationFeedback.dispose(); },
  async load() {
    try { const data = await call("getTaskItemForm", { taskId: this.taskId, itemId: this.itemId }); const values = { ...data.values }; data.item.fields.forEach((field) => { if (values[field.key] === undefined) values[field.key] = field.inputType === "image" ? [] : ""; }); this.setData({ ...data, values, readOnly: data.readOnly === true || this.data.readOnly, loading: false }); }
    catch (_) { this.setData({ loading: false }); }
  },
  setValue(event) { if (this.data.readOnly) return; this.setData({ [`values.${event.currentTarget.dataset.key}`]: event.detail.value }); this.autoSave(); },
  setChoice(event) { if (this.data.readOnly) return; const field = this.data.item.fields.find((entry) => entry.key === event.currentTarget.dataset.key); this.setData({ [`values.${field.key}`]: field.options[event.detail.value] }); this.autoSave(); },
  autoSave() { if (this.data.readOnly) return; clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => { this.saveTimer = null; const values = JSON.parse(JSON.stringify(this.data.values)); const attendanceEvidence = JSON.parse(JSON.stringify(this.data.attendanceEvidence || {})); this.autoSaveChain = (this.autoSaveChain || Promise.resolve()).then(() => call("saveItemDraft", { taskId: this.taskId, itemId: this.itemId, values, attendanceEvidence, preSyncImages: true }, { silent: true })).catch(() => {}); }, 700); },
  chooseImages(event) {
    if (this.data.readOnly) return;
    const key = event.currentTarget.dataset.key; const field = this.data.item.fields.find((entry) => entry.key === key); const current = this.data.values[key] || [];
    const remaining = field.maxImages ? Math.max(1, field.maxImages - current.length) : 9;
    wx.chooseMedia({ count: Math.min(9, remaining), mediaType: ["image"], sourceType: field.cameraOnly ? ["camera"] : ["camera", "album"], camera: field.camera || "back", success: async ({ tempFiles }) => {
      this.setData({ [`uploading.${key}`]: true });
      try {
        if (field.watermark === "attendance") {
          const file = tempFiles[0];
          const capturedAt = capturedAtText();
          const location = this.data.taskContext.location || {};
          const address = location.address || (Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude)) ? `${Number(location.latitude).toFixed(6)}, ${Number(location.longitude).toFixed(6)}` : "地址解析失败");
          const originalFileId = await uploadImage(file.tempFilePath, `tasks/${this.taskId}/${this.itemId}/original`, { compress: false });
          const watermarkedPath = await createAttendanceWatermark(this, file.tempFilePath, { employeeName: this.data.taskContext.employeeName, capturedAt, address });
          const watermarkedFileId = await uploadImage(watermarkedPath, `tasks/${this.taskId}/${this.itemId}/watermarked`, { quality: 92 });
          this.setData({
            [`values.${key}`]: [watermarkedFileId],
            [`attendanceEvidence.${key}`]: { originalFileIds: [originalFileId], watermarkedFileIds: [watermarkedFileId], capturedAt, address },
          });
        } else {
          const ids = await Promise.all(tempFiles.map((file) => uploadImage(file.tempFilePath, `tasks/${this.taskId}/${this.itemId}`)));
          this.setData({ [`values.${key}`]: current.concat(ids) });
        }
        if (field.watermark === "attendance") await this.save();
        else this.autoSave();
      }
      catch (error) { wx.showModal({ title: "照片处理失败", content: error.message || "请重新拍摄", showCancel: false }); }
      finally { this.setData({ [`uploading.${key}`]: false }); }
    }});
  },
  previewImage(event) { const key = event.currentTarget.dataset.key; const index = Number(event.currentTarget.dataset.index) || 0; const urls = this.data.values[key] || []; if (urls.length) wx.previewImage({ current: urls[index], urls }); },
  removeImage(event) { if (this.data.readOnly) return; const { key, index } = event.currentTarget.dataset; const images = [...(this.data.values[key] || [])]; images.splice(index, 1); const data = { [`values.${key}`]: images }; if (!images.length) data[`attendanceEvidence.${key}`] = {}; this.setData(data); this.autoSave(); },
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
      await call("completeTaskItem", { taskId: this.taskId, itemId: this.itemId, values: this.data.values, attendanceEvidence: this.data.attendanceEvidence, requestId: this.completeRequestId }, { silent: true });
      await this.operationFeedback.succeed("任务项已保存");
      if (this.flow === "attendance" && this.role === "photo" && this.nextItemId) {
        wx.redirectTo({ url: `/pages/dynamic-form/index?taskId=${encodeURIComponent(this.taskId)}&itemId=${encodeURIComponent(this.nextItemId)}&flow=attendance&role=work` });
      } else if (this.flow === "daily") {
        await this.submitAttendance();
      } else if (this.flow === "attendance" && this.role === "work") {
        const submitNow = await new Promise((resolve) => wx.showModal({ title: "提交并完成考勤", content: "提交后考勤结果将锁定且不可修改。", confirmText: "提交考勤", cancelText: "稍后提交", success: (result) => resolve(result.confirm), fail: () => resolve(false) }));
        if (submitNow) await this.submitAttendance();
        else wx.navigateBack();
      } else wx.navigateBack();
    } catch (error) {
      this.operationFeedback.fail();
      wx.showModal({ title: "保存失败", content: error.message || "服务暂时不可用，请稍后重试。", showCancel: false, confirmText: "知道了" });
    } finally { this.operationFeedback = null; this.setData({ saving: false }); }
  },
  async submitAttendance() {
    this.submitRequestId = this.submitRequestId || `${this.taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const feedback = startOperationFeedback(this, {
      title: "正在提交考勤",
      hint: "正在写入考勤结果，请勿退出当前页面",
      stages: [
        { after: 0, message: "正在校验任务内容和签到信息" },
        { after: 1500, message: "正在写入考勤结果和照片" },
        { after: 4000, message: "正在完成任务状态同步" },
      ],
    });
    this.operationFeedback = feedback;
    try {
      await call("submitTask", { taskId: this.taskId, requestId: this.submitRequestId }, { silent: true });
      this.submitRequestId = "";
      await feedback.succeed("考勤已提交");
      wx.showToast({ title: "考勤已完成", icon: "success" });
      wx.navigateBack({ delta: 2 });
    } catch (error) {
      feedback.fail();
      wx.showModal({ title: "任务项已保存，考勤未提交", content: error.message || "请返回任务项列表后重试提交。", showCancel: false, confirmText: "知道了" });
    } finally {
      if (this.operationFeedback === feedback) this.operationFeedback = null;
    }
  },
  goBack() { wx.navigateBack(); },
});
