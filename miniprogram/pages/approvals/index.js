const { call } = require("../../utils/api");
const { dateTime } = require("../../utils/format");
Page({
  data: { loading: true, active: "pending", tabs: [{ key: "pending", label: "待我审核" }, { key: "handled", label: "我已处理" }], approvals: [] },
  onShow() { this.load(); },
  async load() { try { const list = await call("listApprovals", { status: this.data.active }, { silent: true }); this.setData({ approvals: list.map((item) => ({ ...item, submittedText: dateTime(item.submittedAt) })), loading: false }); } catch (_) { this.setData({ loading: false }); } },
  changeTab(event) { this.setData({ active: event.currentTarget.dataset.key, loading: true }); this.load(); },
  open(event) { wx.navigateTo({ url: `/pages/approval-detail/index?id=${event.currentTarget.dataset.id}` }); },
  goBack() { wx.navigateBack(); },
});
