const { call } = require("../../utils/api");
const { statusMeta, timeRange } = require("../../utils/format");
const { sortTasks } = require("../../utils/task-sort");

const SORT_FIELDS = [
  { key: "status", label: "任务状态", description: "相同状态按截止时间排列" },
  { key: "startAt", label: "任务开始时间", description: "按任务开始时间排列" },
  { key: "deadlineAt", label: "任务截止时间", description: "按任务截止时间排列" },
];

const SORT_DIRECTIONS = [{ key: "asc", label: "升序" }, { key: "desc", label: "降序" }];

Page({
  data: {
    loading: true,
    keyword: "",
    activeStatus: "all",
    tabs: [{ key: "all", label: "全部" }, { key: "pending", label: "待执行" }, { key: "active", label: "执行中" }, { key: "rectify", label: "待整改" }, { key: "review", label: "待复核" }, { key: "completed", label: "已完成" }],
    tasks: [],
    shownTasks: [],
    sortFields: SORT_FIELDS,
    sortDirections: SORT_DIRECTIONS,
    sortField: "status",
    sortDirection: "asc",
    pendingSortField: "status",
    pendingSortDirection: "asc",
    sortVisible: false,
  },
  onLoad(query) { this.setData({ activeStatus: query.status || "all" }); },
  onShow() { this.load(); },
  async load() {
    try {
      const tasks = await call("listTasks", { taskType: "STORE" }, { silent: true });
      const normalized = tasks.map((task) => ({ ...task, statusMeta: statusMeta(task.status), timeText: timeRange(task.startAt, task.deadlineAt) }));
      this.setData({ tasks: normalized, loading: false }); this.filter();
    } catch (_) { this.setData({ loading: false }); }
  },
  onKeyword(event) { this.setData({ keyword: event.detail.value }); this.filter(); },
  changeStatus(event) { this.setData({ activeStatus: event.currentTarget.dataset.key }); this.filter(); },
  openSort() {
    this.setData({ sortVisible: true, pendingSortField: this.data.sortField, pendingSortDirection: this.data.sortDirection });
  },
  closeSort() { this.setData({ sortVisible: false }); },
  stopPropagation() {},
  chooseSortField(event) { this.setData({ pendingSortField: event.currentTarget.dataset.key }); },
  chooseSortDirection(event) { this.setData({ pendingSortDirection: event.currentTarget.dataset.key }); },
  applySort() {
    const sortField = this.data.pendingSortField;
    const sortDirection = this.data.pendingSortDirection;
    this.setData({ sortField, sortDirection, sortVisible: false });
    this.filter();
  },
  filter() {
    const { tasks, keyword, activeStatus, sortField, sortDirection } = this.data;
    const key = keyword.trim().toLowerCase();
    const filtered = tasks.filter((task) => (activeStatus === "all" || task.status === activeStatus) && (!key || `${task.name}${task.storeName}${task.storeCode}`.toLowerCase().includes(key)));
    const shownTasks = sortTasks(filtered, sortField, sortDirection);
    this.setData({ shownTasks });
  },
  openTask(event) { wx.navigateTo({ url: `/pages/task-execution/index?id=${event.currentTarget.dataset.id}` }); },
  goBack() { wx.navigateBack(); },
});
