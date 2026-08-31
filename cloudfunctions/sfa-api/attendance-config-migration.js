const { sheetId, sheetTitle, cellText, cellReferences, textCell } = require("./wecom");
const { ATTENDANCE_TASK_TYPE, ATTENDANCE_PLACE_OPTIONS } = require("./attendance");

const SHEETS = Object.freeze({ taskTypes: "01_任务类型", results: "02_结果表目录", items: "05_任务项设置", fields: "15_任务项字段设置" });

const ITEM_SPECS = Object.freeze([
  {
    name: "正面照", order: 1, instructions: "完成定位签到后，使用前置摄像头拍摄一张带水印的正面照。", fields: [
      { name: "正面照", inputType: "图片", order: 1, minImages: 1, maxImages: 1 },
    ],
  },
  {
    name: "工作内容收集", order: 2, instructions: "填写当前工作内容、客户名称和所在地。", fields: [
      { name: "工作内容", inputType: "多行文本", order: 1, maxLength: 500 },
      { name: "当前客户名称", inputType: "单行文本", order: 2, maxLength: 100 },
      { name: "当前所在地", inputType: "单选", order: 3, options: ATTENDANCE_PLACE_OPTIONS },
    ],
  },
]);

function getSheet(sheets, title) {
  const sheet = sheets.find((item) => sheetTitle(item) === title);
  if (!sheet) throw new Error(`智能表格缺少子表：${title}`);
  return sheet;
}

function findAttendanceType(records) {
  const record = records.find((item) => cellText(item, "类型编码").trim() === ATTENDANCE_TASK_TYPE);
  if (!record) throw new Error("01_任务类型缺少 ATTENDANCE_CHECK");
  return record;
}

function findAttendanceResultDirectory(records) {
  const record = records.find((item) => cellText(item, "子表标识").trim() === "13_考勤结果");
  if (!record) throw new Error("02_结果表目录缺少 13_考勤结果");
  if (cellText(record, "主关联字段").trim() !== "执行记录") throw new Error("13_考勤结果主关联字段必须为执行记录");
  return record;
}

function itemValues(spec, taskTypeId, resultDirectoryId) {
  return { values: {
    "任务项名称": textCell(spec.name),
    "写入结果表": [resultDirectoryId],
    "展示顺序": spec.order,
    "是否启用": true,
    "是否必做": true,
    "适用任务类型": [taskTypeId],
    "需要审批": false,
    "执行要求": textCell(spec.instructions),
    "允许多次提交": false,
    "最少提交次数": 1,
  } };
}

function fieldValues(spec, itemId) {
  return { values: {
    "字段名称": textCell(spec.name),
    "展示顺序": spec.order,
    "所属任务项": [itemId],
    "执行端展示": true,
    "是否必填": true,
    "输入类型": [{ text: spec.inputType }],
    "最小图片数": spec.minImages || 0,
    "最大图片数": spec.maxImages || 0,
    "最大字数": spec.maxLength || 0,
    "选项（每行一个）": spec.options ? textCell(spec.options.join("\n")) : textCell(""),
  } };
}

async function migrateAttendanceTaskConfiguration(client) {
  const sheets = await client.getSheets({ forceRefresh: true });
  const taskTypeSheet = getSheet(sheets, SHEETS.taskTypes);
  const resultsSheet = getSheet(sheets, SHEETS.results);
  const itemsSheet = getSheet(sheets, SHEETS.items);
  const fieldsSheet = getSheet(sheets, SHEETS.fields);
  const [taskTypes, resultDirectory, currentItems] = await Promise.all([
    client.getRecords(sheetId(taskTypeSheet)), client.getRecords(sheetId(resultsSheet)), client.getRecords(sheetId(itemsSheet)),
  ]);
  const taskType = findAttendanceType(taskTypes);
  const result = findAttendanceResultDirectory(resultDirectory);
  const itemIds = new Map();
  const missingItems = [];
  for (const spec of ITEM_SPECS) {
    const matches = currentItems.filter((item) => cellText(item, "任务项名称").trim() === spec.name && cellReferences(item, "适用任务类型").includes(taskType.record_id));
    if (matches.length > 1) throw new Error(`05_任务项设置存在重复考勤任务项：${spec.name}`);
    if (matches[0]) {
      if (cellReferences(matches[0], "写入结果表")[0] !== result.record_id) throw new Error(`任务项“${spec.name}”写入结果表不正确`);
      itemIds.set(spec.name, matches[0].record_id);
    } else missingItems.push(spec);
  }
  if (missingItems.length) {
    await client.addRecords(sheetId(itemsSheet), missingItems.map((spec) => itemValues(spec, taskType.record_id, result.record_id)));
    const refreshed = await client.getRecords(sheetId(itemsSheet));
    for (const spec of missingItems) {
      const matches = refreshed.filter((item) => cellText(item, "任务项名称").trim() === spec.name && cellReferences(item, "适用任务类型").includes(taskType.record_id));
      if (matches.length !== 1) throw new Error(`任务项“${spec.name}”新增后回读失败`);
      itemIds.set(spec.name, matches[0].record_id);
    }
  }
  const currentFields = await client.getRecords(sheetId(fieldsSheet));
  const missingFields = [];
  for (const item of ITEM_SPECS) {
    for (const spec of item.fields) {
      const matches = currentFields.filter((field) => cellReferences(field, "所属任务项").includes(itemIds.get(item.name)) && cellText(field, "字段名称").trim() === spec.name);
      if (matches.length > 1) throw new Error(`15_任务项字段设置存在重复字段：${item.name}/${spec.name}`);
      if (!matches.length) missingFields.push({ itemId: itemIds.get(item.name), spec });
    }
  }
  if (missingFields.length) await client.addRecords(sheetId(fieldsSheet), missingFields.map(({ itemId, spec }) => fieldValues(spec, itemId)));
  return {
    taskTypeId: taskType.record_id,
    resultDirectoryId: result.record_id,
    createdItems: missingItems.map((item) => item.name),
    createdFields: missingFields.map(({ itemId, spec }) => ({ itemId, name: spec.name })),
    itemIds: Object.fromEntries(itemIds),
  };
}

module.exports = { migrateAttendanceTaskConfiguration };
