const { call } = require("../../utils/api");
const { dateTime } = require("../../utils/format");
function daysInMonth(month) { const [year, m] = month.split("-").map(Number); return new Date(year, m, 0).getDate(); }
function formatMonth(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`; }
function recordStatus(task) {
  if (task.status === "missed") return { label: "缺卡", tone: "missed" };
  if (task.dailyJurisdictionStatus === "abnormal") return { label: "辖区异常", tone: "abnormal" };
  if (task.status === "completed") return { label: "正常", tone: "completed" };
  if (task.status === "not_started") return { label: "未开始", tone: "pending" };
  return { label: "待打卡", tone: "pending" };
}
Page({
  data: { loading: true, month: formatMonth(), selectedDate: "", days: [], tasks: [], actionText: "加载中" },
  onShow() { this.load(); },
  async load() {
    try {
      const data = await call("getDailyAttendanceCalendar", { month: this.data.month, date: this.data.selectedDate }, { silent: true });
      const state = new Map(data.calendar.map((entry) => [entry.date, entry])); const count = daysInMonth(data.month);
      const days = Array.from({ length: count }, (_, index) => { const day = index + 1; const date = `${data.month}-${String(day).padStart(2, "0")}`; return { day, date, ...(state.get(date) || { morning: "none", afternoon: "none" }) }; });
      this.tasksByDate = Object.fromEntries(Object.entries(data.tasksByDate || {}).map(([date, tasks]) => [date, tasks.map((task) => {
        const display = recordStatus(task);
        return { ...task, timeText: `${dateTime(task.startAt)} - ${dateTime(task.deadlineAt)}`, statusLabel: display.label, statusTone: display.tone, addressText: task.checkInAddress || "尚未打卡", checkInTimeText: task.checkedInAt ? dateTime(task.checkedInAt) : "尚未打卡" };
      })]));
      this.setData({ month: data.month, selectedDate: data.selectedDate, calendar: data.calendar, days, loading: false });
      this.updateSelectedDate(data.selectedDate);
    } catch (error) { this.setData({ loading: false }); wx.showToast({ title: error.message || "加载失败", icon: "none" }); }
  },
  updateSelectedDate(date) {
    const tasks = this.tasksByDate?.[date] || [];
    const executable = tasks.find((task) => task.status === "pending" || task.status === "active");
    const actionText = executable ? "打卡" : tasks.some((task) => task.status === "missed") ? "已缺卡" : tasks.length ? "已完成" : "今日无需打卡";
    this.setData({ selectedDate: date, tasks, actionText, executableTaskId: executable?.id || "" });
  },
  selectDate(event) { this.updateSelectedDate(event.currentTarget.dataset.date); },
  changeMonth(event) { const d = new Date(`${this.data.month}-01T00:00:00`); d.setMonth(d.getMonth() + Number(event.currentTarget.dataset.delta)); const month = formatMonth(d); this.setData({ month, selectedDate: `${month}-01`, loading: true }); this.load(); },
  checkIn() { if (!this.data.executableTaskId) return; wx.navigateTo({ url: `/pages/task-execution/index?id=${encodeURIComponent(this.data.executableTaskId)}` }); },
  goBack() { wx.navigateBack(); },
});
