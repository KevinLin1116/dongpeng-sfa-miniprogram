const crypto = require("crypto");
const { sheetId, sheetTitle, cellReferences, textCell } = require("./wecom");
const { ensureResultFields, isCompatibleResultField } = require("./schema-sync");

const STATUS_LABELS = Object.freeze({
  pending: "待执行",
  active: "执行中",
  rectify: "待整改",
  review: "待复核",
  completed: "已完成",
});

function fieldKind(field) {
  return String((field && (field.field_type || field.type)) || "").toUpperCase();
}

function optionCell(value) {
  return [{ text: String(value || "") }];
}

function writableField(field) {
  const kind = fieldKind(field);
  return !["CREATED", "MODIFIED", "CREATOR", "MODIFIER", "FORMULA", "LOOKUP"].some((token) => kind.includes(token));
}

function scalarCell(field, value) {
  const kind = fieldKind(field);
  if (kind.includes("SINGLE_SELECT") || kind.endsWith("SELECT")) return optionCell(value);
  if (kind.includes("NUMBER") || kind.includes("PROGRESS") || kind.includes("CURRENCY") || kind.includes("PERCENTAGE")) return Number(value);
  if (kind.includes("DATE")) return String(value);
  return textCell(value);
}

function personCell(field, account, task) {
  const kind = fieldKind(field);
  if (kind.includes("USER")) return [{ user_id: account.wecomUserId }];
  if (["LINK", "RELATION", "ASSOCIAT", "RECORD"].some((token) => kind.includes(token))) {
    const person = (task.executorSnapshot || []).find((item) => item.userId === account.wecomUserId);
    if (person && person.recordId) return [person.recordId];
  }
  return textCell(account.name || account.wecomUserId);
}

function encodeValue(fieldConfig, value, uploadedImages, tableField) {
  const kind = fieldKind(tableField);
  if (fieldConfig.inputType === "image") {
    if (!kind.includes("IMAGE")) throw new Error(`字段“${fieldConfig.label}”不是图片字段`);
    return uploadedImages || [];
  }
  if (kind) return scalarCell(tableField, value);
  if (fieldConfig.inputType === "number") return Number(value);
  if (fieldConfig.inputType === "singleChoice") return optionCell(value);
  return textCell(value);
}

function hasValue(fieldConfig, value) {
  if (fieldConfig.inputType === "image") return Array.isArray(value) && value.length > 0;
  return value !== undefined && value !== null && value !== "";
}

async function sheetContext(client, title) {
  const sheets = await client.getSheets();
  const sheet = sheets.find((item) => sheetTitle(item) === title);
  if (!sheet) throw new Error(`智能表格缺少结果子表：${title}`);
  const id = sheetId(sheet);
  const fields = await client.getFields(id);
  const fieldsByTitle = new Map(fields.map((field) => [field.field_title || field.title, field]));
  return { id, sheet, fields, fieldsByTitle };
}

async function ensureWritebackFields(client, context, fieldConfigs) {
  const ensured = await ensureResultFields(client, context.sheet, fieldConfigs);
  context.fields = ensured.fields;
  context.fieldsByTitle = new Map(ensured.fields.map((field) => [field.field_title || field.title, field]));
  return ensured;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const values = Array.from(items || []);
  if (!values.length) return [];
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(values.length, Math.max(1, Number(concurrency) || 1)) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function uploadTaskItemImage(client, cloud, fieldConfig, fileId, index) {
  const downloaded = await cloud.downloadFile({ fileID: fileId });
  const buffer = downloaded && downloaded.fileContent;
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error(`无法读取图片：${fieldConfig.label}`);
  if (buffer.length > 8 * 1024 * 1024) throw new Error(`${fieldConfig.label}中的单张图片不能超过 8MB`);
  const uploaded = await client.uploadImage(buffer);
  return {
    id: crypto.createHash("sha1").update(fileId).digest("hex").slice(0, 20),
    title: `${fieldConfig.label}${index + 1}`,
    image_url: uploaded.url,
    width: Number(uploaded.width || 0),
    height: Number(uploaded.height || 0),
  };
}

function taskItemImageCacheKey(fileId) {
  return `file_${crypto.createHash("sha256").update(String(fileId || "")).digest("hex")}`;
}

function taskItemImageFromCache(cache, fileId) {
  if (!cache || typeof cache !== "object") return null;

  const direct = cache[fileId];
  if (direct?.image_url) return direct;
  if (direct?.fileId === fileId && direct?.image?.image_url) return direct.image;

  const safeEntry = cache[taskItemImageCacheKey(fileId)];
  if (safeEntry?.image_url) return safeEntry;
  if (safeEntry?.fileId === fileId && safeEntry?.image?.image_url) return safeEntry.image;

  let legacyEntry = cache;
  for (const segment of String(fileId || "").split(".")) {
    legacyEntry = legacyEntry && typeof legacyEntry === "object" ? legacyEntry[segment] : null;
    if (!legacyEntry) break;
  }
  if (legacyEntry?.image_url) return legacyEntry;
  if (legacyEntry?.image?.image_url) return legacyEntry.image;
  return null;
}

function putTaskItemImageInCache(cache, fileId, image) {
  cache[taskItemImageCacheKey(fileId)] = { fileId, image };
  return cache;
}

async function preUploadTaskItemImages({ client, cloud, fields, values, existingCache = {}, concurrency = 5 }) {
  const nextCache = {};
  const jobs = [];
  const queuedFileIds = new Set();
  for (const fieldConfig of fields || []) {
    if (fieldConfig.inputType !== "image") continue;
    const fileIds = Array.isArray(values?.[fieldConfig.key]) ? values[fieldConfig.key] : [];
    fileIds.forEach((fileId, index) => {
      const cachedImage = taskItemImageFromCache(existingCache, fileId);
      if (cachedImage) {
        putTaskItemImageInCache(nextCache, fileId, cachedImage);
      } else if (!queuedFileIds.has(fileId)) {
        queuedFileIds.add(fileId);
        jobs.push({ fieldConfig, fileId, index });
      }
    });
  }
  const uploadConcurrency = Math.min(5, Math.max(1, Number(concurrency) || 5));
  const uploaded = await mapWithConcurrency(jobs, uploadConcurrency, async (job) => ({
    fileId: job.fileId,
    image: await uploadTaskItemImage(client, cloud, job.fieldConfig, job.fileId, job.index),
  }));
  for (const entry of uploaded) putTaskItemImageInCache(nextCache, entry.fileId, entry.image);
  return nextCache;
}

async function syncExecutionRecord({ client, task, account, status, progress, submittedAt, approvalStatus, touchSavedBy = true }) {
  if (!client.configured || !task.smartSheetExecutionRecordId) return { skipped: true };
  const context = await sheetContext(client, "06_任务执行");
  const values = {};
  const setIfPresent = (title, value) => {
    const field = context.fieldsByTitle.get(title);
    if (field && writableField(field) && value !== undefined) values[title] = value;
  };
  const setScalarIfPresent = (title, value) => {
    const field = context.fieldsByTitle.get(title);
    if (field && writableField(field) && value !== undefined) values[title] = scalarCell(field, value);
  };
  const statusField = context.fieldsByTitle.get("当前状态");
  if (statusField && writableField(statusField)) setIfPresent("当前状态", scalarCell(statusField, STATUS_LABELS[status] || STATUS_LABELS.pending));
  if (progress) {
    setScalarIfPresent("已完成项数", progress.completedCount);
    setScalarIfPresent("必做项总数", progress.requiredCount);
  }
  const savedAt = new Date().toISOString();
  const savedByField = context.fieldsByTitle.get("最后保存人");
  if (touchSavedBy && savedByField && writableField(savedByField) && account) values["最后保存人"] = personCell(savedByField, account, task);
  if (touchSavedBy) setScalarIfPresent("最后保存时间", Date.parse(savedAt));
  if (submittedAt) {
    const submitterField = context.fieldsByTitle.get("提交人");
    if (submitterField && writableField(submitterField) && account) values["提交人"] = personCell(submitterField, account, task);
    setScalarIfPresent("提交时间", Date.parse(submittedAt));
  }
  if (approvalStatus) {
    const approvalField = context.fieldsByTitle.get("审核状态");
    if (approvalField && writableField(approvalField)) setIfPresent("审核状态", scalarCell(approvalField, approvalStatus));
  }
  await client.updateRecords(context.id, [{ record_id: task.smartSheetExecutionRecordId, values }]);
  return { skipped: false, syncedAt: savedAt };
}

async function syncTaskItemResult({ client, cloud, task, item, draft, account, final }) {
  if (!client.configured || !task.smartSheetExecutionRecordId) return { skipped: true };
  const schema = item.schemaSnapshot || {};
  const title = schema.resultSheetTitle || item.resultSheetTitle;
  if (!title) throw new Error(`任务项“${item.name}”未配置写入结果表`);
  const context = await sheetContext(client, title);
  const relationTitle = schema.resultRelationField || item.resultRelationField || "执行记录";
  if (!context.fieldsByTitle.has(relationTitle)) throw new Error(`结果表“${title}”缺少关联字段“${relationTitle}”`);
  if (relationTitle === "任务项执行" && !item.smartSheetItemExecutionRecordId) {
    const error = new Error(`结果表“${title}”要求关联16_任务项执行，但当前任务项尚未生成16记录`);
    error.code = "RESULT_ITEM_EXECUTION_LINK_MISSING";
    throw error;
  }

  const fields = Array.isArray(schema.fields) ? schema.fields : [];
  await ensureWritebackFields(client, context, fields);

  const relationRecordId = relationTitle === "任务项执行" ? item.smartSheetItemExecutionRecordId : task.smartSheetExecutionRecordId;
  const values = { [relationTitle]: [relationRecordId] };
  if (context.fieldsByTitle.has("任务项") && (item.configItemId || item.id)) values["任务项"] = [item.configItemId || item.id];
  for (const fieldConfig of fields) {
    const value = (draft.values || {})[fieldConfig.key];
    if (!hasValue(fieldConfig, value)) continue;
    const tableField = context.fieldsByTitle.get(fieldConfig.label);
    if (!isCompatibleResultField(fieldConfig, tableField)) throw new Error(`结果表“${title}”字段“${fieldConfig.label}”类型与表15配置不一致`);
    if (!writableField(tableField)) throw new Error(`结果表字段“${fieldConfig.label}”是只读字段，不能接收小程序填写结果`);
  }
  const imageCache = await preUploadTaskItemImages({
    client,
    cloud,
    fields,
    values: draft.values || {},
    existingCache: draft.smartSheetImageCache || {},
  });
  for (const fieldConfig of fields) {
    const value = (draft.values || {})[fieldConfig.key];
    if (!hasValue(fieldConfig, value)) continue;
    const tableField = context.fieldsByTitle.get(fieldConfig.label);
    if (fieldConfig.inputType === "image") {
      values[fieldConfig.label] = encodeValue(fieldConfig, value, value.map((fileId) => taskItemImageFromCache(imageCache, fileId)).filter(Boolean), tableField);
    } else {
      values[fieldConfig.label] = encodeValue(fieldConfig, value, undefined, tableField);
    }
  }
  const saveStatusField = context.fieldsByTitle.get("保存状态");
  if (saveStatusField && writableField(saveStatusField)) values["保存状态"] = scalarCell(saveStatusField, final ? "已提交" : "已保存");
  const submittedAtField = context.fieldsByTitle.get("提交时间");
  if (final && submittedAtField && writableField(submittedAtField)) values["提交时间"] = scalarCell(submittedAtField, Date.now());

  let recordId = draft.smartSheetResultRecordId || "";
  if (!recordId) {
    const records = await client.getRecords(context.id);
    const itemReferenceId = item.configItemId || item.id;
    const existing = records.find((record) => {
      if (!cellReferences(record, relationTitle).includes(relationRecordId)) return false;
      if (!context.fieldsByTitle.has("任务项") || !itemReferenceId) return true;
      return cellReferences(record, "任务项").includes(itemReferenceId);
    });
    recordId = (existing && existing.record_id) || "";
  }
  if (recordId) {
    await client.updateRecords(context.id, [{ record_id: recordId, values }]);
  } else {
    const response = await client.addRecords(context.id, [{ values }]);
    recordId = response.records && response.records[0] && response.records[0].record_id;
    if (!recordId) throw new Error(`结果表“${title}”新增记录后未返回记录ID`);
  }
  return { skipped: false, recordId, sheetId: context.id, imageCache, syncedAt: new Date().toISOString() };
}

module.exports = {
  STATUS_LABELS,
  encodeValue,
  preUploadTaskItemImages,
  syncExecutionRecord,
  syncTaskItemResult,
  taskItemImageCacheKey,
  taskItemImageFromCache,
};
