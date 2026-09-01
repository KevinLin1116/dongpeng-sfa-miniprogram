const { call } = require("../../utils/api");
const { dateTime } = require("../../utils/format");

const ALL_TASK_TYPES = { key: "", label: "全部任务类型" };

Page({
  data: {
    loading: true,
    active: "pending",
    tabs: [{ key: "pending", label: "待我审核" }, { key: "handled", label: "我已处理" }],
    sourceApprovals: [],
    approvals: [],
    taskTypeOptions: [ALL_TASK_TYPES],
    taskTypeIndex: 0,
  },

  onShow() { this.load(); },

  async load() {
    try {
      const [list, taskTypes] = await Promise.all([
        call("listApprovals", { status: this.data.active }, { silent: true }),
        call("listVisibleTaskTypes", {}, { silent: true }),
      ]);
      const sourceApprovals = list.map((item) => ({
        ...item,
        taskTypeLabel: item.taskTypeName || item.taskType || "未标注任务类型",
        executorLabel: item.submitterName || item.submitterUserId || "未标注执行人",
        submittedText: dateTime(item.submittedAt),
      }));
      this.setData({
        sourceApprovals,
        taskTypeOptions: [ALL_TASK_TYPES, ...(taskTypes || []).map((item) => ({ key: item.code, label: item.name }))],
        taskTypeIndex: 0,
        loading: false,
      });
      this.applyFilters();
    } catch (_) { this.setData({ sourceApprovals: [], approvals: [], loading: false }); }
  },

  applyFilters() {
    const taskType = this.data.taskTypeOptions[this.data.taskTypeIndex]?.key || "";
    const approvals = this.data.sourceApprovals.filter((item) => {
      const itemTaskType = item.taskType || item.taskTypeLabel;
      return !taskType || itemTaskType === taskType;
    });
    this.setData({ approvals });
  },

  changeTab(event) { this.setData({ active: event.currentTarget.dataset.key, loading: true }); this.load(); },
  changeTaskType(event) { this.setData({ taskTypeIndex: Number(event.detail.value) }); this.applyFilters(); },
  open(event) { wx.navigateTo({ url: `/pages/approval-detail/index?id=${event.currentTarget.dataset.id}` }); },
});
