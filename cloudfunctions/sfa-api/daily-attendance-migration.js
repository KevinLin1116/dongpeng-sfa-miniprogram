const { sheetId, sheetTitle } = require("./wecom");

const text = (field_title) => ({ field_title, field_type: "FIELD_TYPE_TEXT" });
const user = (field_title) => ({ field_title, field_type: "FIELD_TYPE_USER", property_user: { is_multiple: false, is_notified: false } });
const checkbox = (field_title) => ({ field_title, field_type: "FIELD_TYPE_CHECKBOX", property_checkbox: { checked: false } });
const dateTime = (field_title) => ({ field_title, field_type: "FIELD_TYPE_DATE_TIME", property_date_time: { format: "yyyy-mm-dd hh:mm", auto_fill: false } });
const select = (field_title, options) => ({ field_title, field_type: "FIELD_TYPE_SINGLE_SELECT", property_single_select: { is_quick_add: false, options: options.map((text) => ({ text })) } });
const location = (field_title) => ({ field_title, field_type: "FIELD_TYPE_LOCATION", property_location: { input_type: "LOCATION_INPUT_TYPE_MANUAL" } });

const DEFINITIONS = Object.freeze({
  "25_日常考勤配置": [user("人员"), checkbox("是否启用"), dateTime("生效开始日期"), dateTime("生效结束日期"), text("上午开始时间"), text("上午截止时间"), text("下午开始时间"), text("下午截止时间"), text("每日打卡次数"), text("备注")],
  "26_考勤日历": [dateTime("日期"), checkbox("是否工作日"), text("说明")],
  "27_人员考勤例外": [user("人员"), select("例外类型", ["请假", "停用", "免打卡"]), dateTime("开始日期"), dateTime("结束日期"), text("备注")],
  "28_人员考勤辖区": [user("人员"), text("省"), text("市"), text("区/县"), checkbox("是否启用"), text("备注")],
  "29_日常考勤结果": [text("日常任务编号"), text("考勤日期"), select("考勤时段", ["上午", "下午"]), user("执行人员"), location("签到位置"), text("签到详细地址"), dateTime("签到时间"), { field_title: "正面照片", field_type: "FIELD_TYPE_IMAGE" }, select("辖区校验", ["正常", "异常"]), text("辖区异常说明"), select("保存状态", ["已保存", "已提交"]), dateTime("提交时间")],
});

async function inspect(client) {
  const sheets = await client.getSheets({ forceRefresh: true }); const byTitle = new Map(sheets.map((sheet) => [sheetTitle(sheet), sheet]));
  const result = {};
  for (const [title, fields] of Object.entries(DEFINITIONS)) {
    const sheet = byTitle.get(title);
    result[title] = sheet ? { sheetId: sheetId(sheet), exists: true, fields: await client.getFields(sheetId(sheet), { forceRefresh: true }) } : { exists: false, fields: [] };
  }
  return result;
}

async function migrateDailyAttendanceStructure(client) {
  let before = await inspect(client); const createdSheets = []; const addedFields = [];
  for (const title of Object.keys(DEFINITIONS)) if (!before[title].exists) { await client.addSheet(title); createdSheets.push(title); }
  if (createdSheets.length) before = await inspect(client);
  for (const [title, definitions] of Object.entries(DEFINITIONS)) {
    const current = before[title].fields; const titles = new Set(current.map((field) => field.field_title));
    const missing = definitions.filter((field) => !titles.has(field.field_title));
    if (missing.length) { await client.addFields(before[title].sheetId, missing); addedFields.push({ title, fields: missing.map((field) => field.field_title) }); }
  }
  const after = await inspect(client);
  const stillMissing = Object.entries(DEFINITIONS).flatMap(([title, definitions]) => definitions.filter((field) => !after[title].fields.some((current) => current.field_title === field.field_title)).map((field) => `${title}.${field.field_title}`));
  if (stillMissing.length) { const error = new Error(`日常考勤结构迁移未完成：${stillMissing.join("、")}`); error.code = "DAILY_ATTENDANCE_STRUCTURE_INCOMPLETE"; throw error; }
  return { createdSheets, addedFields, sheets: Object.fromEntries(Object.entries(after).map(([title, entry]) => [title, { sheetId: entry.sheetId, fields: entry.fields.map((field) => ({ id: field.field_id, title: field.field_title, type: field.field_type })) }])) };
}
module.exports = { DEFINITIONS, inspect, migrateDailyAttendanceStructure };
