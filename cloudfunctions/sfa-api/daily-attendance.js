const { sheetId, sheetTitle, cellText, cellBoolean, cellUsers } = require("./wecom");

const DAILY_TASK_TYPE = "DAILY_ATTENDANCE";
const DAILY_SHEETS = Object.freeze({ config: "25_日常考勤配置", calendar: "26_考勤日历", exceptions: "27_人员考勤例外", jurisdictions: "28_人员考勤辖区" });
const PERIODS = Object.freeze([
  { key: "morning", label: "上午", startField: "上午开始时间", deadlineField: "上午截止时间" },
  { key: "afternoon", label: "下午", startField: "下午开始时间", deadlineField: "下午截止时间" },
]);

function dailyError(code, message) { const error = new Error(message); error.code = code; return error; }
function chinaParts(input = Date.now()) { const text = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(input)); return text.replace(/\//g, "-"); }
function chinaDateTime(date, time) { const value = String(time || "").trim(); if (!/^\d{1,2}:\d{2}$/.test(value)) return ""; const [hour, minute] = value.split(":").map(Number); const iso = `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`; return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : ""; }
// Smart Sheet date-time values can be returned as milliseconds since epoch,
// formatted text, or an ISO value.  Compare all variants as Shanghai dates.
function smartSheetDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{10,13}$/.test(text)) {
    const timestamp = Number(text.length === 10 ? `${text}000` : text);
    if (Number.isFinite(timestamp)) return chinaParts(timestamp);
  }
  const matched = text.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
  if (matched) return `${matched[1]}-${matched[2]}-${matched[3]}`;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? chinaParts(timestamp) : "";
}
function splitPlaces(value) { return String(value || "").split(/[、,，]/).map((item) => item.trim()).filter(Boolean); }
function valueMatch(actual, expected) { const options = splitPlaces(expected); return !options.length || options.some((item) => actual === item || actual.includes(item) || item.includes(actual)); }
function dateInRange(date, start, end) { return (!start || date >= start) && (!end || date <= end); }
function dailyTaskId(date, period, userId) { return `daily_${date}_${period}_${String(userId).replace(/[^a-zA-Z0-9_-]/g, "_")}`; }

async function readDailyConfiguration(client) {
  const sheets = await client.getSheets();
  const byTitle = new Map(sheets.map((sheet) => [sheetTitle(sheet), sheet]));
  const missing = Object.values(DAILY_SHEETS).filter((title) => !byTitle.has(title));
  if (missing.length) throw dailyError("DAILY_ATTENDANCE_CONFIG_MISSING", `日常考勤尚未完成配置：缺少${missing.join("、")}`);
  const records = await Promise.all(Object.entries(DAILY_SHEETS).map(async ([key, title]) => [key, await client.getRecords(sheetId(byTitle.get(title)))]));
  return Object.fromEntries(records);
}

function enabled(record) { return cellBoolean(record, "是否启用") || cellText(record, "是否启用").trim() === "是"; }
function activeException(record, userId, date) {
  const users = cellUsers(record, "人员").map((user) => user.userId);
  const type = cellText(record, "例外类型").trim();
  return users.includes(userId) && ["请假", "停用", "免打卡"].includes(type) && dateInRange(date, smartSheetDate(cellText(record, "开始日期")), smartSheetDate(cellText(record, "结束日期")));
}
function workday(records, date) {
  const row = records.find((record) => smartSheetDate(cellText(record, "日期")) === date);
  return row ? (cellBoolean(row, "是否工作日") || cellText(row, "是否工作日").trim() === "是") : false;
}
function activeConfigurations(records, date) {
  return records.filter((record) => enabled(record) && dateInRange(date, smartSheetDate(cellText(record, "生效开始日期")), smartSheetDate(cellText(record, "生效结束日期"))))
    .map((record) => ({ record, user: cellUsers(record, "人员")[0] }))
    .filter((entry) => entry.user?.userId);
}
function buildDailyTask({ date, period, config, user }) {
  const startAt = chinaDateTime(date, cellText(config, period.startField));
  const deadlineAt = chinaDateTime(date, cellText(config, period.deadlineField));
  if (!startAt || !deadlineAt || Date.parse(deadlineAt) <= Date.parse(startAt)) throw dailyError("DAILY_ATTENDANCE_WINDOW_INVALID", `“${user.name || user.userId}”的${period.label}打卡时间窗口无效`);
  const id = dailyTaskId(date, period.key, user.userId);
  return {
    _id: id, id, taskType: DAILY_TASK_TYPE, taskTypeName: "日常考勤", name: `${date} ${period.label}日常考勤`,
    targetType: "person", targetKey: `person:${user.userId}`, executorUserIds: [user.userId], executorNames: user.name || user.userId,
    executorSnapshot: [{ userId: user.userId, name: user.name || user.userId, recordId: "" }], startAt, deadlineAt,
    status: "pending", progress: 0, completedItemCount: 0, requiredItemCount: 1, requiresLocation: true, locationMode: "record_only", outOfRangePolicy: "warn",
    dailyAttendanceDate: date, dailyAttendancePeriod: period.key, dailyAttendancePeriodLabel: period.label, dailyConfigRecordId: config.record_id,
    dailyJurisdictionStatus: "pending", dailyJurisdictionReason: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    items: [{ id: `daily_photo_${period.key}`, configItemId: "", name: "正面照", renderer: "dynamic", required: true, order: 1, status: "pending", attendanceRole: "photo", autoAdvance: false, promptSubmitOnComplete: false, smartSheetItemExecutionRecordId: "", itemExecutionKey: "", schemaSnapshot: {
      itemName: "正面照", sectionName: "日常考勤", resultSheetTitle: "29_日常考勤结果", resultRelationField: "日常任务编号", requiresApproval: false, fields: [{ key: "daily_photo", label: "正面照", resultFieldTitle: "正面照片", required: true, inputType: "image", minImages: 1, maxImages: 1, cameraOnly: true, camera: "front", watermark: "attendance", visible: true }],
    }}],
  };
}
function jurisdictionResult(records, userId, location = {}) {
  const province = String(location.province || "").trim(); const city = String(location.city || "").trim(); const district = String(location.district || location.adcode || "").trim();
  const rules = records.filter((record) => enabled(record) && cellUsers(record, "人员").some((user) => user.userId === userId));
  if (!rules.length) return { status: "abnormal", reason: "未配置有效辖区" };
  if (!province || !city) return { status: "abnormal", reason: "定位地址缺少省市信息，无法完成辖区校验" };
  const matched = rules.some((record) => valueMatch(province, cellText(record, "省")) && valueMatch(city, cellText(record, "市")) && valueMatch(district, cellText(record, "区/县")));
  return matched ? { status: "normal", reason: "" } : { status: "abnormal", reason: `当前位置不在配置辖区内：${[province, city, district].filter(Boolean).join("")}` };
}

module.exports = { DAILY_TASK_TYPE, DAILY_SHEETS, PERIODS, chinaParts, chinaDateTime, smartSheetDate, dailyTaskId, readDailyConfiguration, activeException, workday, activeConfigurations, buildDailyTask, jurisdictionResult };
