App({
  globalData: {
    envId: "cloudbase-d9gfexfk498efa64a",
    profile: null,
  },
  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({ title: "版本提示", content: "请升级微信后再使用东鹏智巡", showCancel: false });
      return;
    }
    wx.cloud.init({ env: this.globalData.envId, traceUser: true });
  },
});
