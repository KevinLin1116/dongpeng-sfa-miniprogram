const { call } = require("../../utils/api");
Page({ data: { loading: true, stats: {} }, async onShow() { try { this.setData({ stats: await call("getMyStats", {}, { silent: true }), loading: false }); } catch (_) { this.setData({ loading: false }); } } });
