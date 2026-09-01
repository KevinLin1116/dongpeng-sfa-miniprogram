const { call } = require("../../utils/api");
const { dateTime } = require("../../utils/format");

Page({
  data: { loading: true, stats: {}, recentCompleted: [] },
  async onShow() {
    try {
      const stats = await call("getMyStats", {}, { silent: true });
      this.setData({ stats, recentCompleted: (stats.recentCompleted || []).map((item) => ({ ...item, completedAtText: dateTime(item.completedAt) })), loading: false });
    } catch (_) { this.setData({ loading: false }); }
  },
});
