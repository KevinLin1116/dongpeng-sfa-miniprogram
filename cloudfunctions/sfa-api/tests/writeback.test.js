const assert = require("assert");
const {
  encodeValue,
  preUploadTaskItemImages,
  syncExecutionRecord,
  syncTaskItemResult,
  taskItemImageCacheKey,
  taskItemImageFromCache,
} = require("../smart-sheet-writeback");
const { ensureResultFields } = require("../schema-sync");
const { SmartSheetClient } = require("../wecom");

function field(title, type) { return { field_title: title, field_type: type }; }

async function testEncoders() {
  assert.deepStrictEqual(encodeValue({ label: "说明", inputType: "text" }, "完成", undefined, field("说明", "FIELD_TYPE_TEXT")), [{ type: "text", text: "完成" }]);
  assert.strictEqual(encodeValue({ label: "数量", inputType: "number" }, "3", undefined, field("数量", "FIELD_TYPE_NUMBER")), 3);
  assert.deepStrictEqual(encodeValue({ label: "状态", inputType: "singleChoice" }, "已完成", undefined, field("状态", "FIELD_TYPE_SINGLE_SELECT")), [{ text: "已完成" }]);
}

async function testExecutionWriteback() {
  const updates = [];
  const client = {
    configured: true,
    getSheets: async () => [{ title: "06_任务执行", sheet_id: "execution-sheet" }],
    getFields: async () => [field("当前状态", "FIELD_TYPE_SINGLE_SELECT"), field("已完成项数", "FIELD_TYPE_NUMBER"), field("必做项总数", "FIELD_TYPE_NUMBER"), field("最后保存人", "FIELD_TYPE_USER"), field("最后保存时间", "FIELD_TYPE_DATE_TIME"), field("提交人", "FIELD_TYPE_USER"), field("提交时间", "FIELD_TYPE_DATE_TIME"), field("审核状态", "FIELD_TYPE_SINGLE_SELECT")],
    updateRecords: async (sheetId, records) => { updates.push({ sheetId, records }); return { errcode: 0 }; },
  };
  await syncExecutionRecord({ client, task: { smartSheetExecutionRecordId: "exec-record" }, account: { wecomUserId: "LinWenKai", name: "林文凯" }, status: "review", progress: { completedCount: 2, requiredCount: 2 }, submittedAt: "2026-08-11T08:00:00.000Z", approvalStatus: "待审核" });
  assert.strictEqual(updates.length, 1);
  assert.deepStrictEqual(updates[0].records[0].values["当前状态"], [{ text: "待复核" }]);
  assert.strictEqual(updates[0].records[0].values["已完成项数"], 2);
  assert.deepStrictEqual(updates[0].records[0].values["提交人"], [{ user_id: "LinWenKai" }]);
}

async function testResultWriteback() {
  const adds = [];
  const client = {
    configured: true,
    getSheets: async () => [{ title: "12_物料打卡结果", sheet_id: "result-sheet" }],
    getFields: async () => [field("执行记录", "FIELD_TYPE_LINK"), field("物料类型", "FIELD_TYPE_SINGLE_SELECT"), field("完成数量", "FIELD_TYPE_NUMBER"), field("现场照片", "FIELD_TYPE_IMAGE"), field("保存状态", "FIELD_TYPE_SINGLE_SELECT"), field("提交时间", "FIELD_TYPE_DATE_TIME")],
    addFields: async () => ({ fields: [] }),
    uploadImage: async () => ({ url: "https://doc.weixin.qq.com/image/1", width: 1200, height: 900 }),
    getRecords: async () => [],
    addRecords: async (sheetId, records) => { adds.push({ sheetId, records }); return { records: [{ record_id: "result-record" }] }; },
    updateRecords: async () => ({ errcode: 0 }),
  };
  const cloud = { downloadFile: async () => ({ fileContent: Buffer.from("image") }) };
  const item = { id: "item-1", name: "物料打卡", schemaSnapshot: { resultSheetTitle: "12_物料打卡结果", resultRelationField: "执行记录", writeMode: "每次新增", fields: [{ key: "type", label: "物料类型", inputType: "singleChoice" }, { key: "quantity", label: "完成数量", inputType: "number" }, { key: "photos", label: "现场照片", inputType: "image" }] } };
  const result = await syncTaskItemResult({ client, cloud, task: { smartSheetExecutionRecordId: "exec-record" }, item, draft: { values: { type: "海报", quantity: "2", photos: ["cloud://photo-1"] } }, account: { wecomUserId: "LinWenKai" }, final: true });
  assert.strictEqual(result.recordId, "result-record");
  assert.deepStrictEqual(adds[0].records[0].values["执行记录"], ["exec-record"]);
  assert.strictEqual(adds[0].records[0].values["完成数量"], 2);
  assert.strictEqual(adds[0].records[0].values["现场照片"][0].image_url, "https://doc.weixin.qq.com/image/1");
  assert.deepStrictEqual(adds[0].records[0].values["保存状态"], [{ text: "已提交" }]);
}

async function testTaskItemImagesUploadConcurrentlyAndReuseCache() {
  let active = 0;
  let maximumActive = 0;
  const uploaded = [];
  const client = { uploadImage: async (buffer) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    uploaded.push(buffer.toString());
    active -= 1;
    return { url: `https://doc.weixin.qq.com/${encodeURIComponent(buffer.toString())}` };
  } };
  const cloud = { downloadFile: async ({ fileID }) => ({ fileContent: Buffer.from(fileID) }) };
  const fields = [
    { key: "single", label: "单页", inputType: "image" },
    { key: "flag", label: "吊旗", inputType: "image" },
  ];
  const cachedFileId = "cloud://cloudbase.env/material/cached.jpg";
  const existing = { [cachedFileId]: { id: "cached", image_url: "https://doc.weixin.qq.com/cached" } };
  const newFileIds = [
    "cloud://cloudbase.env/material/one.jpg",
    "cloud://cloudbase.env/material/two.jpg",
    "cloud://cloudbase.env/material/three.jpg",
    "cloud://cloudbase.env/material/four.jpg",
    "cloud://cloudbase.env/material/five.jpg",
  ];
  const cache = await preUploadTaskItemImages({
    client,
    cloud,
    fields,
    values: { single: [cachedFileId, ...newFileIds.slice(0, 2)], flag: newFileIds.slice(2) },
    existingCache: existing,
  });
  assert.strictEqual(maximumActive, 5, "5 张物料照片应在同一批并发同步");
  assert.strictEqual(uploaded.length, 5, "已缓存照片不能重复上传");
  assert.strictEqual(taskItemImageFromCache(cache, cachedFileId).id, "cached");
  assert.ok(taskItemImageFromCache(cache, newFileIds[4]).image_url);
  assert.ok(Object.keys(cache).every((key) => key.startsWith("file_")), "新缓存必须使用安全哈希键");
  assert.ok(cache[taskItemImageCacheKey(newFileIds[0])]);

  const persistedCache = JSON.parse(JSON.stringify(cache));
  await preUploadTaskItemImages({
    client,
    cloud,
    fields,
    values: { single: [cachedFileId, ...newFileIds.slice(0, 2)], flag: newFileIds.slice(2) },
    existingCache: persistedCache,
  });
  assert.strictEqual(uploaded.length, 5, "缓存持久化后再次保存不应重复上传图片");
}

async function testTaskItemImagesReuseLegacyNestedCache() {
  const fileId = "cloud://cloudbase.env/material/legacy.photo.jpg";
  const legacyImage = { id: "legacy", image_url: "https://doc.weixin.qq.com/legacy" };
  const legacyCache = {};
  const segments = fileId.split(".");
  let cursor = legacyCache;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) cursor[segment] = legacyImage;
    else cursor = cursor[segment] = {};
  });
  let uploadCount = 0;
  const cache = await preUploadTaskItemImages({
    client: { uploadImage: async () => { uploadCount += 1; return { image_url: "unexpected" }; } },
    cloud: { downloadFile: async () => ({ fileContent: Buffer.from("unexpected") }) },
    fields: [{ key: "photos", label: "现场照片", inputType: "image" }],
    values: { photos: [fileId] },
    existingCache: legacyCache,
  });
  assert.strictEqual(uploadCount, 0, "历史嵌套缓存应被兼容读取");
  assert.deepStrictEqual(taskItemImageFromCache(cache, fileId), legacyImage);
  assert.ok(cache[taskItemImageCacheKey(fileId)], "历史缓存应在本次保存时迁移为安全键");
}

async function testResultWritebackReusesExistingRecord() {
  const updates = [];
  const client = {
    configured: true,
    getSheets: async () => [{ title: "12_物料打卡结果", sheet_id: "result-sheet" }],
    getFields: async () => [field("执行记录", "FIELD_TYPE_LINK"), field("任务项", "FIELD_TYPE_LINK"), field("说明", "FIELD_TYPE_TEXT")],
    addFields: async () => ({ fields: [] }),
    getRecords: async () => [{ record_id: "existing-result", values: { "执行记录": ["exec-record"], "任务项": ["item-config"] } }],
    addRecords: async () => { throw new Error("不应重复新增"); },
    updateRecords: async (sheetId, records) => { updates.push({ sheetId, records }); return { errcode: 0 }; },
  };
  const item = { id: "item-1", configItemId: "item-config", name: "物料打卡", schemaSnapshot: { resultSheetTitle: "12_物料打卡结果", resultRelationField: "执行记录", fields: [{ key: "note", label: "说明", inputType: "text" }] } };
  const result = await syncTaskItemResult({ client, cloud: {}, task: { smartSheetExecutionRecordId: "exec-record" }, item, draft: { values: { note: "完成" } }, account: { wecomUserId: "LinWenKai" }, final: false });
  assert.strictEqual(result.recordId, "existing-result");
  assert.strictEqual(updates[0].records[0].record_id, "existing-result");
}

async function testResultWritebackAddsMissingConfiguredField() {
  const addedFields = [];
  const addedRecords = [];
  let tableFields = [field("执行记录", "FIELD_TYPE_LINK")];
  const client = {
    configured: true,
    getSheets: async () => [{ title: "12_物料打卡结果", sheet_id: "result-sheet" }],
    getFields: async () => tableFields,
    addFields: async (sheetId, fields) => {
      addedFields.push({ sheetId, fields });
      tableFields = tableFields.concat(fields.map((item) => field(item.field_title, item.field_type)));
      return { fields: tableFields };
    },
    getRecords: async () => [],
    addRecords: async (sheetId, records) => { addedRecords.push({ sheetId, records }); return { records: [{ record_id: "dynamic-result" }] }; },
    updateRecords: async () => ({ errcode: 0 }),
  };
  const item = { id: "item-1", name: "物料打卡", schemaSnapshot: { resultSheetTitle: "12_物料打卡结果", resultRelationField: "执行记录", fields: [{ key: "page", label: "单页", inputType: "singleChoice", options: ["是", "否"] }] } };
  const result = await syncTaskItemResult({ client, cloud: {}, task: { smartSheetExecutionRecordId: "exec-record" }, item, draft: { values: { page: "是" } }, account: { wecomUserId: "LinWenKai" }, final: false });
  assert.strictEqual(result.recordId, "dynamic-result");
  assert.strictEqual(addedFields.length, 1);
  assert.deepStrictEqual(addedFields[0].fields, [{ field_title: "单页", field_type: "FIELD_TYPE_SINGLE_SELECT", property_single_select: { is_quick_add: true, options: [] } }]);
  assert.deepStrictEqual(addedRecords[0].records[0].values["单页"], [{ text: "是" }]);
}

async function testResultWritebackRejectsTypeConflict() {
  const client = {
    configured: true,
    getSheets: async () => [{ title: "12_物料打卡结果", sheet_id: "result-sheet" }],
    getFields: async () => [field("执行记录", "FIELD_TYPE_LINK"), field("单页", "FIELD_TYPE_NUMBER")],
    addFields: async () => { throw new Error("不应新增字段"); },
  };
  const item = { id: "item-1", name: "物料打卡", schemaSnapshot: { resultSheetTitle: "12_物料打卡结果", resultRelationField: "执行记录", fields: [{ key: "page", label: "单页", inputType: "singleChoice" }] } };
  await assert.rejects(
    () => syncTaskItemResult({ client, cloud: {}, task: { smartSheetExecutionRecordId: "exec-record" }, item, draft: { values: { page: "是" } }, account: { wecomUserId: "LinWenKai" }, final: false }),
    /类型冲突/,
  );
}

async function testItemExecutionRelationRequiresChildRecordId() {
  const client = {
    configured: true,
    getSheets: async () => [{ title: "12_物料打卡结果", sheet_id: "result-sheet" }],
    getFields: async () => [field("任务项执行", "FIELD_TYPE_LINK")],
  };
  const item = { id: "item-1", name: "物料打卡", schemaSnapshot: { resultSheetTitle: "12_物料打卡结果", resultRelationField: "任务项执行", fields: [] } };
  await assert.rejects(
    () => syncTaskItemResult({ client, cloud: {}, task: { smartSheetExecutionRecordId: "execution-06" }, item, draft: { values: {} }, account: {}, final: false }),
    (error) => error.code === "RESULT_ITEM_EXECUTION_LINK_MISSING",
  );
}

async function testDynamicFieldsProtectReservedColumns() {
  const client = { getFields: async () => [], addFields: async () => { throw new Error("不应新增保留字段"); } };
  await assert.rejects(
    () => ensureResultFields(client, { title: "12_物料打卡结果", sheet_id: "result-sheet" }, [{ label: "提交时间", inputType: "text" }]),
    /保留字段/,
  );
}

async function testDynamicFieldsRejectCrossItemTypeConflict() {
  const client = { getFields: async () => [], addFields: async () => { throw new Error("不应新增冲突字段"); } };
  await assert.rejects(
    () => ensureResultFields(client, { title: "12_物料打卡结果", sheet_id: "result-sheet" }, [{ label: "数量", inputType: "number" }, { label: "数量", inputType: "text" }]),
    /互相冲突/,
  );
}

async function testFieldQueryReadsAllPages() {
  const client = new SmartSheetClient({ corpId: "corp", secret: "secret", docId: "doc" });
  const calls = [];
  client.call = async (endpoint, body) => {
    calls.push({ endpoint, body });
    if (body.offset === 0) return { fields: Array.from({ length: 100 }, (_, index) => field(`字段${index + 1}`, "FIELD_TYPE_TEXT")) };
    return { fields: [field("单页", "FIELD_TYPE_IMAGE"), field("吊旗", "FIELD_TYPE_IMAGE")] };
  };
  const fields = await client.getFields("result-sheet");
  assert.strictEqual(fields.length, 102);
  assert.strictEqual(fields[100].field_title, "单页");
  assert.deepStrictEqual(calls.map((call) => call.body.offset), [0, 100]);
}

async function testRecordQueryReadsAllPages() {
  const client = new SmartSheetClient({ corpId: "corp", secret: "secret", docId: "doc" });
  const calls = [];
  client.call = async (endpoint, body) => {
    calls.push({ endpoint, body });
    if (body.offset === 0) return { records: Array.from({ length: 1000 }, (_, index) => ({ record_id: `row-${index + 1}` })) };
    return { records: [{ record_id: "row-1001" }] };
  };
  const records = await client.getRecords("item-execution-sheet");
  assert.strictEqual(records.length, 1001);
  assert.strictEqual(records[1000].record_id, "row-1001");
  assert.deepStrictEqual(calls.map((call) => call.body.offset), [0, 1000]);
}

async function main() {
  await testEncoders();
  await testExecutionWriteback();
  await testResultWriteback();
  await testTaskItemImagesUploadConcurrentlyAndReuseCache();
  await testTaskItemImagesReuseLegacyNestedCache();
  await testResultWritebackReusesExistingRecord();
  await testResultWritebackAddsMissingConfiguredField();
  await testResultWritebackRejectsTypeConflict();
  await testItemExecutionRelationRequiresChildRecordId();
  await testDynamicFieldsProtectReservedColumns();
  await testDynamicFieldsRejectCrossItemTypeConflict();
  await testFieldQueryReadsAllPages();
  await testRecordQueryReadsAllPages();
  process.stdout.write("writeback tests passed\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
