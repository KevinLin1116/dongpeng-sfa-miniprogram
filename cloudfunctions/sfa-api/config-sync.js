const { sheetId, sheetTitle, cellText, cellBoolean, cellNumber } = require("./wecom");

const TASK_TYPE_SHEET = "01_任务类型";
const TONES = { STORE: "red", DAILY_ATTENDANCE: "orange", ATTENDANCE_CHECK: "blue", RETAIL_LEAD: "green" };
const SHORT_NAMES = { STORE: "店", DAILY_ATTENDANCE: "勤", ATTENDANCE_CHECK: "查", RETAIL_LEAD: "商" };

function mapTaskType(record) {
  const code = cellText(record, "类型编码").trim();
  const name = (cellText(record, "执行端展示名称") || cellText(record, "任务类型名称")).trim();
  return {
    id: record.record_id,
    code,
    shortName: SHORT_NAMES[code] || name.slice(0, 1) || "工",
    name,
    description: cellText(record, "执行端展示说明").trim(),
    order: cellNumber(record, "展示顺序"),
    objectType: cellText(record, "执行对象类型").trim(),
    defaultRequiresApproval: false,
    tone: TONES[code] || "red",
    enabled: cellBoolean(record, "执行端是否展示") && cellText(record, "状态") !== "停用",
  };
}

async function readTaskTypes(client) {
  const sheets = await client.getSheets();
  const target = sheets.find((sheet) => sheetTitle(sheet) === TASK_TYPE_SHEET);
  if (!target) throw new Error(`智能表格缺少子表：${TASK_TYPE_SHEET}`);
  const records = await client.getRecords(sheetId(target));
  return records.map(mapTaskType).filter((item) => item.code && item.name && item.enabled).sort((a, b) => a.order - b.order);
}

module.exports = { TASK_TYPE_SHEET, mapTaskType, readTaskTypes };
