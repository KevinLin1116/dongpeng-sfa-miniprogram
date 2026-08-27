const { call } = require("../../utils/api");
const { statusMeta, dateTime } = require("../../utils/format");
const { locationDisplay } = require("../../utils/location-display");
const { cloneEmptyOperationProgress, startOperationFeedback } = require("../../utils/operation-feedback");

function locationCheckInPending(task) {
  return Boolean(task && !task.readOnly && task.requiresLocation === true && !(task.location && task.location.checkedIn));
}

Page({
  data: { loading: true, task: null, locating: false, submitting: false, operationProgress: cloneEmptyOperationProgress() },
  onLoad(query) { this.taskId = query.id; this.load(); },
  onUnload() { if (this.operationFeedback) this.operationFeedback.dispose(); },
  async onShow() { if (this.loadedOnce) await this.load(true); this.loadedOnce = true; },
  async load(silent = false) {
    try {
      const task = await call("getTask", { taskId: this.taskId }, { silent });
      task.readOnly = task.readOnly === true || task.status === "review" || task.status === "completed";
      task.startText = dateTime(task.startAt); task.deadlineText = dateTime(task.deadlineAt);
      task.location = task.location || {};
      task.locationDisplay = locationDisplay(task.location, task.storeName);
      task.locationGateLocked = locationCheckInPending(task);
      task.executionNotice = task.executionAccess && !task.executionAccess.allowed ? task.executionAccess.message : "";
      task.items = task.items.map((item, index) => ({
        ...item,
        number: String(index + 1).padStart(2, "0"),
        statusMeta: statusMeta(item.status),
        entryLocked: task.locationGateLocked,
      }));
      this.setData({ task, loading: false });
    } catch (_) { this.setData({ loading: false }); }
  },
  async openLocationSettings() {
    const confirmed = await new Promise((resolve) => wx.showModal({
      title: "需要定位权限",
      content: "任务签到需要获取当前位置，用于核验您与任务门店的距离。请在设置中允许使用位置信息。",
      confirmText: "去设置",
      success: (res) => resolve(res.confirm),
      fail: () => resolve(false),
    }));
    if (!confirmed) return false;
    const settings = await new Promise((resolve, reject) => wx.openSetting({ success: resolve, fail: reject }));
    return settings.authSetting["scope.userLocation"] === true;
  },
  async getCurrentLocation() {
    const settings = await new Promise((resolve, reject) => wx.getSetting({ success: resolve, fail: reject }));
    if (settings.authSetting["scope.userLocation"] === false) {
      const enabled = await this.openLocationSettings();
      if (!enabled) throw new Error("未获得定位权限");
    }
    try {
      return await new Promise((resolve, reject) => wx.getLocation({
        type: "gcj02",
        isHighAccuracy: true,
        highAccuracyExpireTime: 5000,
        success: resolve,
        fail: reject,
      }));
    } catch (error) {
      const detail = error.errMsg || error.message || "";
      if (/auth deny|auth denied|authorize|permission|deny/i.test(detail)) {
        const enabled = await this.openLocationSettings();
        if (enabled) {
          return new Promise((resolve, reject) => wx.getLocation({
            type: "gcj02",
            isHighAccuracy: true,
            highAccuracyExpireTime: 5000,
            success: resolve,
            fail: reject,
          }));
        }
        throw new Error("未获得定位权限");
      }
      if (/system permission denied|location service|gps/i.test(detail)) {
        throw new Error("请先开启手机定位服务");
      }
      if (/timeout/i.test(detail)) throw new Error("定位超时，请到开阔处重试");
      throw new Error("暂时无法获取位置，请稍后重试");
    }
  },
  async checkIn() {
    const task = this.data.task;
    if (!task || task.readOnly || this.data.locating || (task.location && task.location.checkedIn)) return;
    this.setData({ locating: true });
    try {
      const location = await this.getCurrentLocation();
      const result = await call("checkIn", { taskId: this.taskId, latitude: location.latitude, longitude: location.longitude, accuracy: location.accuracy });
      this.setData({ "task.location": result, "task.locationDisplay": locationDisplay(result, task.storeName) });
      await this.load(true);
      wx.showToast({ title: "签到成功", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error.message || "定位失败", icon: "none", duration: 2500 });
    } finally {
      this.setData({ locating: false });
    }
  },
  openItem(event) {
    const task = this.data.task;
    const item = task && task.items.find((entry) => entry.id === event.currentTarget.dataset.id);
    if (!item) return;
    if (locationCheckInPending(task)) {
      wx.showModal({
        title: "请先完成定位签到",
        content: "该任务要求定位签到，签到成功后才能进入并执行任务项。",
        showCancel: false,
        confirmText: "知道了",
      });
      return;
    }
    if (!task.readOnly && item.editable === false && task.executionNotice) {
      wx.showToast({ title: task.executionNotice, icon: "none", duration: 2500 });
      return;
    }
    const readOnly = item.editable === false;
    const path = item.renderer === "sampling" ? "sampling" : "dynamic-form";
    wx.navigateTo({ url: `/pages/${path}/index?taskId=${encodeURIComponent(this.taskId)}&itemId=${encodeURIComponent(item.id)}&readOnly=${readOnly ? "1" : "0"}` });
  },
  async submitTask() {
    if (!this.data.task.canSubmit || this.data.submitting) return;
    const confirmed = await new Promise((resolve) => wx.showModal({ title: "提交任务", content: "提交后任务将锁定；如被退回，仅退回的任务项可修改。", confirmText: "确认提交", success: (res) => resolve(res.confirm) }));
    if (!confirmed) return;
    this.setData({ submitting: true });
    this.operationFeedback = startOperationFeedback(this, {
      title: "正在提交任务",
      hint: "产品和照片较多时可能需要十几秒，请勿重复提交",
      stages: [
        { after: 0, message: "正在校验任务项和本次提交内容" },
        { after: 1800, message: "正在生成并核对业务结果" },
        { after: 4800, message: "正在获取最新审核人并生成审批" },
        { after: 7800, message: "正在同步任务状态到企业微信" },
      ],
    });
    try {
      this.submitRequestId = this.submitRequestId || `${this.taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await call("submitTask", { taskId: this.taskId, requestId: this.submitRequestId }, { silent: true });
      this.submitRequestId = "";
      await this.operationFeedback.succeed("任务已提交，正在返回任务列表");
      wx.navigateBack({ delta: 1 });
    } catch (error) {
      this.operationFeedback.fail();
      wx.showModal({ title: "任务提交失败", content: error.message || "服务暂时不可用，请稍后重试。", showCancel: false, confirmText: "知道了" });
    }
    finally { this.operationFeedback = null; this.setData({ submitting: false }); }
  },
  goBack() { wx.navigateBack(); },
});
