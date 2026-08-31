const { call } = require("../../utils/api");

Page({
  data: {
    loading: true,
    profile: { name: "", roleLabel: "" },
    metrics: { pending: 0, active: 0, rectify: 0, weekCompleted: 0 },
    modules: [],
  },
  async onShow() {
    try {
      let data = await call("bootstrap", {}, { silent: true });
      if (!data.config?.taskTypesReady && data.profile?.roleLabel === "管理员") {
        await call("refreshTaskTypes", {}, { silent: true });
        data = await call("bootstrap", {}, { silent: true });
      }
      const todoTotal = data.metrics.pending + data.metrics.active + data.metrics.rectify;
      this.setData({ ...data, todoTotal, loading: false });
      getApp().globalData.profile = data.profile;
    } catch (_) {
      this.setData({ loading: false });
    }
  },
  openModule(event) {
    const { code, enabled } = event.currentTarget.dataset;
    if (!enabled || !["STORE", "ATTENDANCE_CHECK", "DAILY_ATTENDANCE"].includes(code)) return wx.navigateTo({ url: "/pages/building/index" });
    if (code === "DAILY_ATTENDANCE") return wx.navigateTo({ url: "/pages/daily-attendance/index" });
    wx.navigateTo({ url: `/pages/task-list/index?type=${code}` });
  },
  openMetric(event) {
    wx.navigateTo({ url: `/pages/task-list/index?type=STORE&status=${event.currentTarget.dataset.status}` });
  },
  openProfile() { wx.switchTab({ url: "/pages/profile/index" }); },
});
