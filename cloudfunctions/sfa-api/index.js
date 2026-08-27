const cloud = require("wx-server-sdk");
const crypto = require("crypto");
const { distanceMeters } = require("./location");
const { reverseGeocode } = require("./reverse-geocoder");
const { SmartSheetClient, sheetId, sheetTitle, cellReferences, textCell } = require("./wecom");
const { syncEnabledSchemas } = require("./schema-sync");
const { readTaskTypes, mapTaskType } = require("./config-sync");
const { schemaConfigId, schemaSnapshot, findReadySchema, formFromSchema, sanitizeValues } = require("./task-item-schema");
const { SHEETS, safeId, isConfirmedPublication, executionRecordValues, buildPublicationPlan } = require("./task-publisher");
const { preUploadTaskItemImages, syncExecutionRecord, syncTaskItemResult } = require("./smart-sheet-writeback");
const { ensureTaskItemExecutions, itemExecutionKey } = require("./task-item-execution");
const { loadItemExecutionContract, itemExecutionIdentity, itemExecutionCreateEntry, applyItemExecutionLink, syncTaskItemExecutionRecord } = require("./item-execution-writeback");
const { SamplingConfigRepository, SAMPLING_SHEETS, SAMPLING_SHEET_ALIASES } = require("./sampling-config");
const { sanitizeSamplingValues, validateSamplingSubmission, validateSamplingEditAccess, preUploadSamplingImages, samplingFormModel } = require("./sampling-validation");
const { ApprovalConfigRepository, APPROVAL_SHEETS, resolveNodeReviewer } = require("./reviewer-router");
const { desiredSamplingResults, writeSamplingResults, updateSamplingResultApprovalStatus, updateSamplingProductDecisions } = require("./sampling-writeback");
const { normalizeSamplingReview, normalizeProductDecisions, deriveProductReview, formatProductReviewOpinion, applyRejectedProductReview, scrubRejectedEvidence } = require("./product-review");
const { appendApprovalHistory, repairApprovalHistorySystemFields } = require("./approval-history-writeback");
const { buildApprovalRecord, runSubmissionOrchestrator } = require("./submission-orchestrator");
const { REGION_SHEET_TITLE, ensureRegionCodes } = require("./region-code-sync");
const { migrateSamplingRuleStructure, cleanupSamplingRuleStructure, repairSamplingGroupRuleLinks } = require("./sampling-structure-migration");
const { migrateSamplingProductReview } = require("./sampling-product-review-migration");
const {
  runtimeParameters,
  runtimeParametersFingerprint,
  runtimeParametersChanged,
  locationPolicyChanged,
  taskWindowAccess,
  taskExecutionAccess,
} = require("./task-runtime-policy");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const COLLECTIONS = { accounts: "sfa_account_bindings", tasks: "sfa_task_instances", drafts: "sfa_task_drafts", logs: "sfa_runtime_logs", approvals: "sfa_approvals", locations: "sfa_location_records", idempotency: "sfa_idempotency_records", cache: "sfa_cache", uploads: "sfa_upload_metadata" };
const smartSheet = new SmartSheetClient({ corpId: process.env.SFA_WECOM_CORP_ID, secret: process.env.SFA_WECOM_SECRET, docId: process.env.SFA_SMART_SHEET_DOC_ID, proxyUrl: process.env.SFA_PROXY_URL, proxySecret: process.env.SFA_PROXY_SECRET });
const samplingConfigRepository = new SamplingConfigRepository({ client: smartSheet });
const approvalConfigRepository = new ApprovalConfigRepository({ client: smartSheet });
const ADMIN_RETRY_CAPABILITY = Symbol("admin-retry-capability");

class ApiError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
const ok = (data) => ({ ok: true, data });
const fail = (error) => ({ ok: false, code: error.code || "INTERNAL_ERROR", message: error.message || "服务暂时不可用", details: error.details });
const now = () => new Date().toISOString();

function performanceLog(action, phase, startedAt, ok = true, code = "") {
  const payload = { type: "sfa-performance", action, phase, durationMs: Math.max(0, Date.now() - startedAt), ok };
  if (code) payload.code = String(code).slice(0, 80);
  const writer = ok ? console.info : console.warn;
  writer("[sfa-performance]", JSON.stringify(payload));
}

async function measurePhase(action, phase, operation) {
  const startedAt = Date.now();
  try {
    const result = await operation();
    performanceLog(action, phase, startedAt, true);
    return result;
  } catch (error) {
    performanceLog(action, phase, startedAt, false, error?.code || "ERROR");
    throw error;
  }
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

function callbackSystemAccount(event) {
  if (event.source !== "wecom-smart-sheet-callback") return null;
  const expected = Buffer.from(String(process.env.SFA_CALLBACK_BRIDGE_SECRET || ""));
  const provided = Buffer.from(String(event.bridgeSecret || ""));
  if (!expected.length || expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    throw new ApiError("UNAUTHENTICATED", "智能表格回调桥接鉴权失败");
  }
  return { system: true, roles: ["管理员"], wecomUserId: "WECOM_CALLBACK", name: "智能表格回调", dataScope: "all" };
}

async function tryQuery(collection, where = {}) {
  try { return (await db.collection(collection).where(where).limit(100).get()).data; } catch (_) { return []; }
}
async function strictQuery(collection, where = {}, limit = 100) {
  try {
    return (await db.collection(collection).where(where).limit(limit).get()).data || [];
  } catch (error) {
    throw new ApiError("DATABASE_READ_FAILED", "业务数据读取失败，请稍后重试", { collection });
  }
}
async function queryAll(collection, where = {}, maximum = 5000) {
  const records = [];
  for (let offset = 0; offset < maximum; offset += 100) {
    const page = (await db.collection(collection).where(where).skip(offset).limit(100).get()).data || [];
    records.push(...page);
    if (page.length < 100) break;
  }
  return records;
}
async function tryAdd(collection, data) { try { return await db.collection(collection).add({ data }); } catch (_) { return null; } }
async function tryUpdate(collection, id, data) { try { return await db.collection(collection).doc(id).update({ data }); } catch (_) { return null; } }
async function trySet(collection, id, data) { try { return await db.collection(collection).doc(id).set({ data }); } catch (_) { return null; } }
async function readCache(id) { try { return (await db.collection(COLLECTIONS.cache).doc(id).get()).data || null; } catch (_) { return null; } }
async function readDocument(collection, id) { try { return (await db.collection(collection).doc(id).get()).data || null; } catch (_) { return null; } }

function requestFingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value || {})).digest("hex");
}

function operationId(...parts) {
  return parts.map((part) => String(part || "")).join("_").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 240);
}

function isAuthorizedAdminRetry(event) {
  return event?._adminRetryCapability === ADMIN_RETRY_CAPABILITY && Boolean(event?._adminRetryOperationId);
}

function draftDocumentId(taskId, itemId) {
  return operationId("draft", taskId, itemId);
}

function isDuplicateDocumentError(error) {
  return /exist|duplicate|重复|已存在/i.test(String(error?.message || error?.errMsg || ""));
}

async function acquireCreateOnlyOperation({ id, action, resourceKey, requestId, input, forceTakeover = false }) {
  const ownerToken = crypto.randomBytes(16).toString("hex");
  const inputHash = requestFingerprint(input);
  const createdAt = now();
  try {
    await db.collection(COLLECTIONS.idempotency).add({ data: {
      _id: id,
      action,
      resourceKey,
      requestId,
      inputHash,
      actorUserId: input?.userId || "",
      round: Number(input?.round || 0),
      ownerToken,
      status: "processing",
      phase: "claimed",
      createdAt,
      updatedAt: createdAt,
    } });
    return { kind: "acquired", id, ownerToken, inputHash };
  } catch (error) {
    if (!isDuplicateDocumentError(error)) throw new ApiError("IDEMPOTENCY_ACQUIRE_FAILED", "操作防重校验失败，请稍后重试");
    const existing = await readDocument(COLLECTIONS.idempotency, id);
    if (!existing) throw new ApiError("IDEMPOTENCY_STATE_UNKNOWN", "操作状态暂时无法确认，请勿重复操作并联系管理员");
    if (existing.inputHash && existing.inputHash !== inputHash) throw new ApiError("IDEMPOTENCY_KEY_CONFLICT", "同一操作标识对应的内容不一致，请刷新后重试");
    if (existing.status === "completed") return { kind: "completed", response: existing.response };
    if (forceTakeover && existing.status === "processing") {
      const claimedAt = now();
      let claimed;
      try {
        claimed = await db.collection(COLLECTIONS.idempotency).where({ _id: id, status: "processing", ownerToken: existing.ownerToken }).update({ data: {
          ownerToken,
          previousOwnerToken: existing.ownerToken,
          retryCount: Number(existing.retryCount || 0) + 1,
          retriedAt: claimedAt,
          updatedAt: claimedAt,
        } });
      } catch (_) {
        throw new ApiError("IDEMPOTENCY_TAKEOVER_FAILED", "未完成操作接管失败，请刷新后重试");
      }
      if (Number(claimed?.stats?.updated || 0) !== 1) throw new ApiError("OPERATION_OWNERSHIP_LOST", "未完成操作已被其他请求接管，请稍后刷新");
      return { kind: "acquired", id, ownerToken, inputHash, resumed: true, existing };
    }
    throw new ApiError("OPERATION_IN_PROGRESS", "操作正在处理中，请稍后刷新；若长时间未完成请联系管理员");
  }
}

async function advanceCreateOnlyOperation(operation, phase, patch = {}) {
  const current = await readDocument(COLLECTIONS.idempotency, operation.id);
  if (!current || current.status !== "processing" || current.ownerToken !== operation.ownerToken) {
    throw new ApiError("OPERATION_OWNERSHIP_LOST", "操作执行权已失效，请停止重试并联系管理员");
  }
  const saved = await tryUpdate(COLLECTIONS.idempotency, operation.id, { ...patch, phase, updatedAt: now() });
  if (!saved) throw new ApiError("IDEMPOTENCY_WRITE_FAILED", "操作阶段保存失败，请勿重复操作并联系管理员");
}

async function completeCreateOnlyOperation(operation, response) {
  const current = await readDocument(COLLECTIONS.idempotency, operation.id);
  if (!current || current.status !== "processing" || current.ownerToken !== operation.ownerToken) {
    throw new ApiError("OPERATION_OWNERSHIP_LOST", "操作执行权已失效，请停止重试并联系管理员");
  }
  const saved = await tryUpdate(COLLECTIONS.idempotency, operation.id, { status: "completed", phase: "completed", response, completedAt: now(), updatedAt: now() });
  if (!saved) throw new ApiError("IDEMPOTENCY_WRITE_FAILED", "操作已完成，但防重结果保存失败；请勿重复操作并联系管理员");
  return response;
}

async function abandonCreateOnlyOperation(operation) {
  const current = await readDocument(COLLECTIONS.idempotency, operation.id);
  if (!current || current.status !== "processing" || current.ownerToken !== operation.ownerToken || current.phase !== "claimed") return false;
  try {
    const removed = await db.collection(COLLECTIONS.idempotency).doc(operation.id).remove();
    return Boolean(removed);
  } catch (_) {
    return false;
  }
}

function isPreSideEffectError(error) {
  return [
    "TASK_NOT_FOUND", "ITEM_NOT_FOUND", "TASK_LOCKED", "ITEM_LOCKED",
    "VALIDATION_FAILED", "TASK_INCOMPLETE", "REVIEWER_NOT_FOUND",
    "REVIEW_ROUTE_DIMENSION_MISSING", "INVALID_DECISION", "REASON_REQUIRED",
    "APPROVAL_ALREADY_HANDLED", "SAMPLING_SNAPSHOT_MISSING", "SAMPLING_PRODUCT_UNKNOWN",
    "SAMPLING_FILE_ID_INVALID", "SAMPLING_PLATFORM_PHOTO_LIMIT", "SAMPLING_VALIDATION_FAILED",
    "SAMPLING_QUALIFIED_PRODUCT_LOCKED", "PRODUCT_DECISIONS_REQUIRED", "PRODUCT_DECISIONS_INCOMPLETE",
    "PRODUCT_DECISION_INVALID", "PRODUCT_REASON_REQUIRED", "PRODUCT_DECISION_OUT_OF_SCOPE",
  ].includes(error?.code);
}

function assertProductionTaskItemSchema(item) {
  if (!schemaConfigId(item)) {
    throw new ApiError("TASK_ITEM_SCHEMA_NOT_READY", `任务项“${item.name}”缺少正式智能表格配置，请联系任务发布者`);
  }
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

async function resolveTaskItemForm(item) {
  const snapshot = schemaSnapshot(item);
  if (snapshot) return formFromSchema(item, snapshot);
  const configItemId = schemaConfigId(item);
  if (!configItemId) {
    assertProductionTaskItemSchema(item);
  }
  const cache = await readCache("config_task_item_schemas");
  const schema = findReadySchema(cache?.value, item);
  if (!schema) throw new ApiError("TASK_ITEM_SCHEMA_NOT_READY", `任务项“${item.name}”的执行表单尚未同步，请联系任务发布者`);
  return formFromSchema(item, schema);
}

async function authenticate() {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) throw new ApiError("UNAUTHENTICATED", "未获取到小程序身份");
  let bindings;
  try {
    bindings = (await db.collection(COLLECTIONS.accounts).where({ openId: OPENID, status: "active" }).limit(2).get()).data || [];
  } catch (error) {
    throw new ApiError("ACCOUNT_LOOKUP_FAILED", "账号绑定查询失败，请稍后重试");
  }
  if (bindings[0]) return bindings[0];
  throw new ApiError("ACCOUNT_NOT_BOUND", "当前微信账号尚未绑定企业微信人员，请联系管理员");
}

function visibleTasks(account, tasks) {
  if (account.dataScope === "all" || account.roles.includes("管理员")) return tasks;
  return tasks.filter((task) => (task.executorUserIds || []).includes(account.wecomUserId));
}
async function loadTasks(account) {
  const records = await queryAll(COLLECTIONS.tasks, {});
  return visibleTasks(account, records);
}
async function loadTask(account, taskId) {
  const task = (await loadTasks(account)).find((entry) => (entry._id || entry.id) === taskId);
  if (!task) throw new ApiError("TASK_NOT_FOUND", "任务不存在或你无权查看");
  task.id = task._id || task.id;
  return task;
}
async function loadTaskForApproval(approval) {
  let task;
  try {
    task = (await db.collection(COLLECTIONS.tasks).doc(approval.taskId).get()).data || null;
  } catch (error) {
    if (!/not found|不存在/i.test(String(error?.message || error?.errMsg || ""))) {
      throw new ApiError("DATABASE_READ_FAILED", "审批任务读取失败，请稍后重试");
    }
  }
  if (!task) throw new ApiError("TASK_NOT_FOUND", "审批对应的任务不存在");
  task.id = task._id || task.id;
  return task;
}

function taskListItem(task) {
  return {
    id: task._id || task.id,
    taskType: task.taskType,
    name: task.name,
    storeName: task.storeName,
    storeCode: task.storeCode,
    executorNames: task.executorNames,
    startAt: task.startAt,
    deadlineAt: task.deadlineAt,
    submittedAt: task.submittedAt || "",
    status: task.status,
    progress: task.progress,
    itemSummary: (task.items || []).map((item) => item.name).join("、"),
  };
}
async function loadDraft(account, taskId, itemId) {
  const deterministicId = draftDocumentId(taskId, itemId);
  const deterministic = await readDocument(COLLECTIONS.drafts, deterministicId);
  if (deterministic) return deterministic;
  const records = await strictQuery(COLLECTIONS.drafts, { taskId, itemId }, 2);
  if (records.length > 1) throw new ApiError("DRAFT_DUPLICATE_EXISTING", "任务项存在重复草稿，请联系管理员处理后重试");
  return records[0] || { taskId, itemId, values: {}, completed: false };
}

function taskItemAccess(task, draft, currentTime = Date.now()) {
  const rejected = Boolean(draft && (draft.rectificationPending || draft.rejectionReason));
  const taskLocked = ["review", "completed"].includes(task.status);
  const executionAccess = taskExecutionAccess(task, currentTime);
  return {
    rejected,
    editable: !taskLocked && executionAccess.allowed && (task.status !== "rectify" || rejected),
    executionAccess,
  };
}

async function saveDraft(account, taskId, itemId, values, completed = false, options = {}) {
  const records = await strictQuery(COLLECTIONS.drafts, { taskId, itemId }, 2);
  const rectificationPending = Boolean(records[0]?.rectificationPending || records[0]?.rejectionReason);
  const payload = {
    taskId,
    itemId,
    values,
    completed,
    // A rejected item remains editable until the whole task is successfully
    // submitted again. Completing the local form must not consume the unlock.
    rejectionReason: rectificationPending ? (records[0]?.rejectionReason || "") : "",
    rectificationPending,
    unlockedAt: rectificationPending ? (records[0]?.unlockedAt || "") : "",
    pendingCompleteOperationId: options.pendingCompleteOperationId || "",
    samplingReview: normalizeSamplingReview(options.samplingReview || records[0]?.samplingReview),
    updatedBy: account.wecomUserId,
    updatedByName: account.name,
    updatedAt: now(),
  };
  if (records[0]) {
    const saved = await tryUpdate(COLLECTIONS.drafts, records[0]._id, payload);
    if (!saved) throw new ApiError("DRAFT_SAVE_FAILED", "任务项保存失败，请重试");
    return { ...records[0], ...payload, _id: records[0]._id };
  }
  const id = draftDocumentId(taskId, itemId);
  try {
    await db.collection(COLLECTIONS.drafts).add({ data: { ...payload, _id: id } });
    return { ...payload, _id: id };
  } catch (error) {
    if (isDuplicateDocumentError(error)) throw new ApiError("DRAFT_VERSION_CONFLICT", "任务项已在其他操作中更新，请刷新页面");
    throw new ApiError("DRAFT_SAVE_FAILED", "任务项保存失败，请重试");
  }
}

async function saveDraftIfCurrent(account, taskId, itemId, values, completed = false, options = {}) {
  const records = await strictQuery(COLLECTIONS.drafts, { taskId, itemId }, 2);
  if (records[0]?.pendingCompleteOperationId) throw new ApiError("OPERATION_IN_PROGRESS", "任务项正在处理中，请稍后刷新");
  if (records[0]?.completed && !options.allowCompletedOverwrite) throw new ApiError("DRAFT_ALREADY_COMPLETED", "任务项已经完成，请刷新页面");
  const rectificationPending = Boolean(records[0]?.rectificationPending || records[0]?.rejectionReason);
  const payload = {
    taskId,
    itemId,
    values,
    completed,
    rejectionReason: rectificationPending ? (records[0]?.rejectionReason || "") : "",
    rectificationPending,
    unlockedAt: rectificationPending ? (records[0]?.unlockedAt || "") : "",
    pendingCompleteOperationId: options.pendingCompleteOperationId || "",
    samplingReview: normalizeSamplingReview(options.samplingReview || records[0]?.samplingReview),
    updatedBy: account.wecomUserId,
    updatedByName: account.name,
    updatedAt: now(),
  };
  if (!records[0]) {
    const id = draftDocumentId(taskId, itemId);
    try {
      await db.collection(COLLECTIONS.drafts).add({ data: { ...payload, _id: id } });
      return { ...payload, _id: id };
    } catch (error) {
      if (isDuplicateDocumentError(error)) throw new ApiError("DRAFT_VERSION_CONFLICT", "任务项已在其他操作中更新，请刷新页面");
      throw new ApiError("DRAFT_SAVE_FAILED", "任务项保存失败，请重试");
    }
  }
  let updated;
  try {
    updated = await db.collection(COLLECTIONS.drafts).where({
      _id: records[0]._id,
      completed: records[0].completed === true,
      pendingCompleteOperationId: records[0].pendingCompleteOperationId || "",
      updatedAt: records[0].updatedAt,
    }).update({ data: payload });
  } catch (error) {
    throw new ApiError("DRAFT_SAVE_FAILED", "任务项保存失败，请重试");
  }
  const updatedCount = Number(updated?.stats?.updated ?? updated?.updated ?? 0);
  if (updatedCount !== 1) throw new ApiError("DRAFT_VERSION_CONFLICT", "任务项已在其他操作中更新，请刷新页面");
  return { ...records[0], ...payload, _id: records[0]._id };
}

async function writeBackTaskItem(task, item, draft, account, final = false, options = {}) {
  if (item.renderer === "sampling") throw new ApiError("SAMPLING_DEDICATED_WRITEBACK_REQUIRED", "产品上样必须使用逐产品结果回写，不能走普通表单结果回写");
  if (item.schemaSnapshot?.resultRelationField === "任务项执行" && !item.smartSheetItemExecutionRecordId) {
    const prelinked = await syncTaskItemExecutionRecord({
      client: smartSheet,
      task,
      item,
      draft,
      account,
      status: draft.completed ? "completed" : "active",
      latestRejectionReason: "",
      allowEdit: !final,
      resultSheetTitle: item.schemaSnapshot?.resultSheetTitle || item.resultSheetTitle || "",
    });
    if (!prelinked.skipped) await persistTaskItemExecutionLink(task, item, prelinked, draft.completed ? "completed" : "active");
  }
  const result = await syncTaskItemResult({ client: smartSheet, cloud, task, item, draft, account, final });
  if (result.skipped) return result;
  const resultLink = {
    smartSheetResultRecordId: result.recordId,
    smartSheetResultSheetId: result.sheetId,
    smartSheetImageCache: result.imageCache,
    smartSheetSyncedAt: result.syncedAt,
    smartSheetFinalizedAt: final ? result.syncedAt : (draft.smartSheetFinalizedAt || ""),
  };
  const saved = await tryUpdate(COLLECTIONS.drafts, draft._id, resultLink);
  if (!saved) throw new ApiError("RESULT_LINK_SAVE_FAILED", "执行结果已回写，但本地关联记录保存失败，请重试");
  Object.assign(draft, resultLink);
  if (options.skipItemExecutionSync) return result;
  const itemExecutionStatus = draft.completed ? "completed" : "active";
  const itemExecution = await syncTaskItemExecutionRecord({
    client: smartSheet,
    task,
    item,
    draft,
    account,
    status: final && (item.approvalTemplateCode || item.requiresApproval) ? "review" : itemExecutionStatus,
    submittedAt: final ? now() : undefined,
    approvalStatus: final ? ((item.approvalTemplateCode || item.requiresApproval) ? "pending" : "none") : undefined,
    latestRejectionReason: "",
    allowEdit: !final,
    resultRecordId: result.recordId,
    resultSheetTitle: item.schemaSnapshot?.resultSheetTitle || item.resultSheetTitle || "",
  });
  if (!itemExecution.skipped) {
    await persistTaskItemExecutionLink(task, item, itemExecution, itemExecutionStatus);
  }
  return result;
}

async function writeBackAllTaskResults(task, account, knownDrafts) {
  const drafts = knownDrafts || await strictQuery(COLLECTIONS.drafts, { taskId: task.id }, 100);
  const draftByItem = new Map(drafts.map((draft) => [draft.itemId, draft]));
  const items = task.items.filter((item) => item.renderer !== "sampling" && draftByItem.get(item.id)?.completed);
  const missingRequiredLink = items.some((item) => item.schemaSnapshot?.resultRelationField === "任务项执行" && !item.smartSheetItemExecutionRecordId);
  return mapWithConcurrency(items, missingRequiredLink ? 1 : 3, (item) => writeBackTaskItem(task, item, draftByItem.get(item.id), account, true, { skipItemExecutionSync: true }));
}

async function cleanupReplacedSamplingFiles(draft) {
  const review = normalizeSamplingReview(draft.samplingReview);
  const pending = review.pendingDeleteFileIds;
  if (!pending.length) return review;
  let failed = pending;
  try {
    if (typeof cloud.deleteFile !== "function") throw new Error("deleteFile unavailable");
    const response = await cloud.deleteFile({ fileList: pending });
    const results = Array.isArray(response?.fileList) ? response.fileList : [];
    failed = pending.filter((fileID) => {
      const result = results.find((entry) => entry.fileID === fileID || entry.fileId === fileID);
      return !result || Number(result.status) !== 0;
    });
  } catch (_) {
    failed = pending;
  }
  if (failed.length) await tryAdd(COLLECTIONS.logs, { action: "cleanupSamplingFiles", ok: false, code: "SAMPLING_FILE_CLEANUP_PENDING", failedCount: failed.length, taskId: draft.taskId, itemId: draft.itemId, createdAt: now() });
  return { ...review, pendingDeleteFileIds: failed };
}

async function synchronizeSamplingImages({ item, values, draft }) {
  const persistCache = async (cache) => {
    const saved = await tryUpdate(COLLECTIONS.drafts, draft._id, { smartSheetImageCache: cache, updatedAt: now() });
    if (!saved) throw new ApiError("SAMPLING_IMAGE_CACHE_SAVE_FAILED", "照片已同步，但缓存保存失败，请勿重复上传并联系管理员");
    draft.smartSheetImageCache = cache;
  };
  const imageCache = await preUploadSamplingImages({
    snapshot: item.samplingSnapshot,
    values,
    client: smartSheet,
    cloud,
    existingCache: draft.smartSheetImageCache || {},
    onCache: persistCache,
  });
  if (JSON.stringify(imageCache) !== JSON.stringify(draft.smartSheetImageCache || {})) await persistCache(imageCache);
  return imageCache;
}

async function preSyncSamplingDraftImages({ item, values, draft }) {
  try {
    const imageCache = await measurePhase("saveItemDraft", "sampling_images", () => synchronizeSamplingImages({ item, values, draft }));
    return { status: "ready", syncedCount: Object.keys(imageCache).length };
  } catch (error) {
    // 草稿已经安全写入云数据库。跨网图片预同步失败时不阻断业务员继续填写，
    // 正式保存会复用已成功的缓存并只重试尚未同步的照片。
    return { status: "pending", code: String(error?.code || "SAMPLING_IMAGE_PRE_SYNC_FAILED") };
  }
}

async function preSyncTaskItemDraftImages({ form, values, draft }) {
  try {
    const imageCache = await measurePhase("saveItemDraft", "dynamic_images", () => preUploadTaskItemImages({
      client: smartSheet,
      cloud,
      fields: form.fields,
      values,
      existingCache: draft.smartSheetImageCache || {},
    }));
    if (JSON.stringify(imageCache) !== JSON.stringify(draft.smartSheetImageCache || {})) {
      const saved = await tryUpdate(COLLECTIONS.drafts, draft._id, { smartSheetImageCache: imageCache, updatedAt: now() });
      if (!saved) throw new ApiError("TASK_ITEM_IMAGE_CACHE_SAVE_FAILED", "照片已同步，但缓存保存失败，请稍后重试");
      draft.smartSheetImageCache = imageCache;
    }
    return { status: "ready", syncedCount: Object.keys(imageCache).length };
  } catch (error) {
    return { status: "pending", code: String(error?.code || "TASK_ITEM_IMAGE_PRE_SYNC_FAILED") };
  }
}

async function completeSamplingDraft({ task, item, account, values, operation }) {
  let workingDraft = await saveDraft(account, task.id, item.id, values, false, { pendingCompleteOperationId: operation.id });
  try {
    const imageCache = await measurePhase("completeTaskItem", "sampling_images", () => synchronizeSamplingImages({ item, values, draft: workingDraft }));
    const completedAt = now();
    const completedPayload = { values, completed: true, smartSheetImageCache: imageCache, samplingReview: normalizeSamplingReview(workingDraft.samplingReview), completedAt, updatedAt: completedAt };
    const completedSaved = await tryUpdate(COLLECTIONS.drafts, workingDraft._id, completedPayload);
    if (!completedSaved) throw new ApiError("DRAFT_SAVE_FAILED", "照片已同步，但任务项完成状态保存失败；请勿重复上传并联系管理员");
    workingDraft = { ...workingDraft, ...completedPayload };
    const cleanedReview = await cleanupReplacedSamplingFiles(workingDraft);
    if (cleanedReview.pendingDeleteFileIds.length !== completedPayload.samplingReview.pendingDeleteFileIds.length) {
      const cleanupSaved = await tryUpdate(COLLECTIONS.drafts, workingDraft._id, { samplingReview: cleanedReview, updatedAt: now() });
      if (cleanupSaved) workingDraft.samplingReview = cleanedReview;
    }
    await measurePhase("completeTaskItem", "item_execution_writeback", () => syncTaskItemExecutionRecord({
      client: smartSheet,
      task,
      item,
      draft: workingDraft,
      account,
      status: "completed",
      latestRejectionReason: "",
      allowEdit: false,
      resultSheetTitle: item.schemaSnapshot?.resultSheetTitle || item.resultSheetTitle || "24_产品上样结果",
    }));
    // syncTaskItemExecutionRecord 已把记录 ID 写回当前 item 引用；紧接着的
    // refreshTaskProgress 会一次性持久化 items 和完成进度，避免重复更新任务文档。
    return workingDraft;
  } catch (error) {
    await tryUpdate(COLLECTIONS.drafts, workingDraft._id, { completed: false, pendingCompleteOperationId: "", updatedAt: now() });
    throw error;
  }
}

async function assertItemEditable(task, itemId) {
  if (["review", "completed"].includes(task.status)) throw new ApiError("TASK_LOCKED", "任务已提交，当前不可修改");
  const executionAccess = taskExecutionAccess(task);
  if (!executionAccess.allowed) throw new ApiError(executionAccess.code, executionAccess.message);
  if (task.status !== "rectify") return;
  const drafts = await strictQuery(COLLECTIONS.drafts, { taskId: task.id, itemId }, 2);
  if (!drafts[0]?.rectificationPending && !drafts[0]?.rejectionReason) throw new ApiError("ITEM_LOCKED", "整改期间只能修改被退回的任务项");
}

async function persistTaskItemExecutionLink(task, item, synced, status) {
  if (!synced?.recordId) return;
  const items = applyItemExecutionLink(task, item, synced, status);
  const saved = await tryUpdate(COLLECTIONS.tasks, task.id, { items, itemExecutionSyncedAt: synced.syncedAt || now() });
  if (!saved) throw new ApiError("ITEM_EXECUTION_LINK_SAVE_FAILED", "任务项执行已写入智能表格，但本地关联保存失败，请重试");
  task.items = items;
}

async function createApprovalOnce(record) {
  try {
    await db.collection(COLLECTIONS.approvals).add({ data: record });
    return { record, created: true };
  } catch (error) {
    if (!isDuplicateDocumentError(error)) throw new ApiError("APPROVAL_CREATE_FAILED", `任务项“${record.itemName}”的审批记录创建失败`);
    const existing = await readDocument(COLLECTIONS.approvals, record._id);
    if (!existing || existing.taskId !== record.taskId || existing.itemId !== record.itemId || Number(existing.itemSubmissionRound) !== Number(record.itemSubmissionRound)) {
      throw new ApiError("APPROVAL_ID_CONFLICT", `任务项“${record.itemName}”的审批唯一标识发生冲突，请联系管理员对账`);
    }
    return { record: existing, created: false };
  }
}

function latestApprovalsByItem(approvals) {
  return approvals.reduce((latest, approval) => {
    const current = latest[approval.itemId];
    const approvalTime = approval.submittedAt || approval.createdAt || "";
    const currentTime = current?.submittedAt || current?.createdAt || "";
    if (!current || approvalTime >= currentTime) latest[approval.itemId] = approval;
    return latest;
  }, {});
}

function normalizeLegacySamplingApproval(approval) {
  if (approval.reviewMode === "product" || !Array.isArray(approval.evidenceGroups) || !approval.evidenceGroups.length) return approval;
  const allProducts = approval.evidenceGroups.flatMap((group) => group.products || []);
  const uploadedProducts = allProducts.filter((product) => product.selected !== false && (product.images || []).length > 0);
  const rawIds = (approval.resultRecordIds || []).filter((entry) => typeof entry === "string" && entry);
  let mapped = [];
  if (rawIds.length === allProducts.length) mapped = allProducts.map((product, index) => ({ productRecordId: product.productRecordId, recordId: rawIds[index], resultKey: "" }));
  else if (rawIds.length === uploadedProducts.length) mapped = uploadedProducts.map((product, index) => ({ productRecordId: product.productRecordId, recordId: rawIds[index], resultKey: "" }));
  const mappedByProduct = new Map(mapped.map((entry) => [entry.productRecordId, entry]));
  const compatibilityError = uploadedProducts.length && mappedByProduct.size < uploadedProducts.length
    ? "旧版待审批记录无法确认产品与表24结果的一一对应关系，请管理员先对账后再审核"
    : "";
  const evidenceGroups = approval.evidenceGroups.map((group) => ({
    ...group,
    products: (group.products || []).filter((product) => uploadedProducts.includes(product)).map((product) => ({
      ...product,
      reviewRequired: true,
      sourceKind: "current_new",
      currentStatus: "pending",
      resultRecordId: mappedByProduct.get(product.productRecordId)?.recordId || "",
    })),
  })).filter((group) => group.products.length);
  return { ...approval, reviewMode: "product", reviewProductIds: uploadedProducts.map((product) => product.productRecordId), inheritedQualifiedProductIds: [], resultRecordIds: mapped, evidenceGroups, compatibilityError };
}

async function recomputeApprovalTaskState(task, currentApproval, decision) {
  const approvals = await strictQuery(COLLECTIONS.approvals, { taskId: task.id }, 100);
  const latest = latestApprovalsByItem(approvals.map((entry) => entry._id === currentApproval.id ? { ...entry, status: decision } : entry));
  const requiredApprovalItemIds = (task.items || []).filter((entry) => entry.approvalTemplateCode || entry.requiresApproval).map((entry) => entry.id);
  const allRequiredItemsApproved = requiredApprovalItemIds.length > 0 && requiredApprovalItemIds.every((itemId) => latest[itemId]?.status === "approved");
  return { allRequiredItemsApproved, approvals, latest };
}

async function decideFormalApproval({ approval, task, item, event, account, operation }) {
  const decision = event.decision;
  const isProductReview = item.renderer === "sampling" && approval.reviewMode === "product";
  const currentNodeIndex = Number(approval.currentNodeIndex || 0);
  let nextRoute;
  if (decision === "approved" && item.approvalStructureSnapshot?.nodes?.[currentNodeIndex + 1]) {
    const configuration = await approvalConfigRepository.load();
    nextRoute = resolveNodeReviewer({ configuration, task, item, nodeIndex: currentNodeIndex + 1 });
  }
  if (item.renderer === "sampling") {
    if (isProductReview && decision === "rejected") {
      await updateSamplingProductDecisions({ client: smartSheet, productDecisions: event.productDecisions, resultRecordIds: approval.resultRecordIds });
    } else {
      await updateSamplingResultApprovalStatus({
        client: smartSheet,
        resultRecordIds: approval.resultRecordIds,
        approvalStatus: nextRoute ? "待审批" : "已通过",
      });
    }
  }
  await advanceCreateOnlyOperation(operation, "result_status_ready", { status: "processing" });
  await appendApprovalHistory({
    client: smartSheet,
    approvalId: approval.id,
    nodeRecordId: approval.currentNodeRecordId,
    action: decision === "approved" ? "审核通过" : "审核退回",
    itemExecutionRecordId: item.smartSheetItemExecutionRecordId,
    templateRecordId: approval.templateRecordId,
    regionRecordId: approval.matchedRegionRecordId,
    round: Number(approval.itemSubmissionRound),
    operatorUserId: account.wecomUserId,
    operatorName: account.name,
    opinion: event.reason || "",
  });
  await advanceCreateOnlyOperation(operation, "audit_ready", { status: "processing" });
  const progress = { completedCount: task.completedItemCount || 0, requiredCount: task.requiredItemCount || (task.items || []).filter((entry) => entry.required !== false).length };
  if (nextRoute) {
    const [itemExecution] = await Promise.all([
      syncTaskItemExecutionRecord({
        client: smartSheet, task, item, account, status: "review", approvalStatus: "pending",
        latestRejectionReason: "", allowEdit: false, touchSavedBy: false,
      }),
      syncExecutionRecord({ client: smartSheet, task, account, status: "review", progress, approvalStatus: "待审核", touchSavedBy: false }),
    ]);
    if (!itemExecution.skipped) await persistTaskItemExecutionLink(task, item, itemExecution, "review");
    const transition = {
      currentNodeIndex: nextRoute.nodeIndex,
      currentNodeRecordId: nextRoute.nodeRecordId,
      currentNodeName: nextRoute.nodeName,
      currentNodeDuty: nextRoute.nodeDuty,
      routeRecordId: nextRoute.routeRecordId,
      matchedRegionRecordId: nextRoute.regionRecordId,
      matchedRegionCode: nextRoute.regionCode,
      matchedRegionName: nextRoute.regionName,
      routeResolvedAt: nextRoute.resolvedAt,
      currentReviewerRecordId: nextRoute.reviewerRecordId,
      currentReviewerUserId: nextRoute.userId,
      currentReviewerName: nextRoute.name,
      status: "pending",
      statusLabel: "待审核",
      history: [...(approval.history || []), { nodeRecordId: approval.currentNodeRecordId, action: "审核通过", reason: event.reason || "", decidedAt: now(), decidedBy: account.wecomUserId, decidedByName: account.name }],
      productDecisionHistory: [...(approval.productDecisionHistory || []), ...(isProductReview ? [{ nodeRecordId: approval.currentNodeRecordId, decidedAt: now(), decidedBy: account.wecomUserId, decidedByName: account.name, decisions: event.productDecisions }] : [])],
      updatedAt: now(),
    };
    const saved = await tryUpdate(COLLECTIONS.approvals, approval.id, transition);
    if (!saved) throw new ApiError("APPROVAL_NEXT_NODE_SAVE_FAILED", "下一审批节点已解析，但审批状态保存失败，请勿重复操作并联系管理员");
    await advanceCreateOnlyOperation(operation, "business_state_ready", { status: "processing" });
    return completeCreateOnlyOperation(operation, { status: "pending", nextNodeName: nextRoute.nodeName });
  }

  let nextTaskStatus = task.status;
  let parentApprovalStatus = "审核中";
  if (decision === "rejected") {
    nextTaskStatus = "rectify";
    parentApprovalStatus = "已驳回";
  } else {
    const state = await recomputeApprovalTaskState(task, approval, "approved");
    if (state.allRequiredItemsApproved) {
      nextTaskStatus = "completed";
      parentApprovalStatus = "已通过";
    }
  }
  const [itemExecution] = await Promise.all([
    syncTaskItemExecutionRecord({
      client: smartSheet,
      task,
      item,
      account,
      status: decision === "approved" ? "completed" : "rectify",
      approvalStatus: decision,
      latestRejectionReason: decision === "rejected" ? event.reason : "",
      allowEdit: decision === "rejected",
      touchSavedBy: false,
    }),
    syncExecutionRecord({ client: smartSheet, task, account, status: nextTaskStatus, progress, approvalStatus: parentApprovalStatus, touchSavedBy: false }),
  ]);
  if (!itemExecution.skipped) await persistTaskItemExecutionLink(task, item, itemExecution, decision === "approved" ? "completed" : "rectify");
  await advanceCreateOnlyOperation(operation, "external_state_ready", { status: "processing" });

  if (decision === "rejected") {
    const drafts = await strictQuery(COLLECTIONS.drafts, { taskId: approval.taskId, itemId: approval.itemId }, 2);
    const existingDraft = drafts[0] || { values: {}, samplingReview: {} };
    const samplingReview = isProductReview
      ? applyRejectedProductReview({ current: existingDraft.samplingReview, review: event.productReview, approval, values: existingDraft.values, decidedAt: now() })
      : existingDraft.samplingReview;
    const nextValues = { ...(existingDraft.values || {}) };
    if (isProductReview) for (const product of event.productReview.unqualified) nextValues[product.productRecordId] = [];
    const rejection = { taskId: approval.taskId, itemId: approval.itemId, values: nextValues, samplingReview, completed: false, rejectionReason: event.reason, rectificationPending: true, unlockedAt: now(), updatedAt: now() };
    const rejectionSaved = drafts[0]
      ? await tryUpdate(COLLECTIONS.drafts, drafts[0]._id, rejection)
      : await tryAdd(COLLECTIONS.drafts, { ...rejection, values: {}, updatedBy: approval.submitterUserId || "", updatedByName: approval.submitterName || "" });
    if (!rejectionSaved) throw new ApiError("REJECTION_SAVE_FAILED", "整改信息保存失败，请重试审批操作");
    const taskSaved = await tryUpdate(COLLECTIONS.tasks, approval.taskId, { status: "rectify", latestRejectionReason: event.reason, updatedAt: now() });
    if (!taskSaved) throw new ApiError("TASK_APPROVAL_STATUS_SAVE_FAILED", "任务整改状态保存失败，请重试审批操作");
  } else if (nextTaskStatus === "completed") {
    const taskSaved = await tryUpdate(COLLECTIONS.tasks, approval.taskId, { status: "completed", progress: 100, completedAt: now(), updatedAt: now() });
    if (!taskSaved) throw new ApiError("TASK_APPROVAL_STATUS_SAVE_FAILED", "任务完成状态保存失败，请重试审批操作");
  }
  const retainedEvidenceGroups = isProductReview && decision === "rejected" ? scrubRejectedEvidence(approval.evidenceGroups, event.productReview) : approval.evidenceGroups;
  const retainedImages = Array.isArray(retainedEvidenceGroups) ? retainedEvidenceGroups.flatMap((group) => (group.products || []).flatMap((product) => product.images || [])) : approval.images;
  const approvalSaved = await tryUpdate(COLLECTIONS.approvals, approval.id, {
    status: decision,
    statusLabel: decision === "approved" ? "已通过" : "已退回",
    reason: event.reason || "",
    decidedAt: now(),
    decidedBy: account.wecomUserId,
    decidedByName: account.name,
    history: [...(approval.history || []), { nodeRecordId: approval.currentNodeRecordId, action: decision === "approved" ? "审核通过" : "审核退回", reason: event.reason || "", decidedAt: now(), decidedBy: account.wecomUserId, decidedByName: account.name }],
    productDecisionHistory: [...(approval.productDecisionHistory || []), ...(isProductReview ? [{ nodeRecordId: approval.currentNodeRecordId, decidedAt: now(), decidedBy: account.wecomUserId, decidedByName: account.name, decisions: event.productDecisions }] : [])],
    evidenceGroups: retainedEvidenceGroups,
    images: retainedImages,
  });
  if (!approvalSaved) throw new ApiError("APPROVAL_SAVE_FAILED", "审批状态保存失败，请重试；此前写入均可安全回查");
  await advanceCreateOnlyOperation(operation, "business_state_ready", { status: "processing" });
  return completeCreateOnlyOperation(operation, { status: decision });
}

async function idempotentSubmit(event, account, currentTask, operation) {
  const requestId = String(event.requestId || "").trim();
  if (!requestId) throw new ApiError("REQUEST_ID_REQUIRED", "提交请求缺少幂等标识，请返回后重试");
  const round = Number(currentTask.submissionRound || 0) + 1;
  const claimed = await acquireCreateOnlyOperation({
    id: operationId("submit", event.taskId, round),
    action: "submitTask",
    resourceKey: event.taskId,
    requestId,
    input: { taskId: event.taskId, round, requestId, userId: account.wecomUserId },
    forceTakeover: isAuthorizedAdminRetry(event) && event._adminRetryOperationId === operationId("submit", event.taskId, round),
  });
  if (claimed.kind === "completed") return claimed.response;
  try {
    const response = await operation(claimed, currentTask, round);
    return completeCreateOnlyOperation(claimed, response);
  } catch (error) {
    if (isPreSideEffectError(error)) await abandonCreateOnlyOperation(claimed);
    throw error;
  }
}

async function replaySubmittedRequest(event, account) {
  const requestId = String(event.requestId || "").trim();
  if (!requestId) throw new ApiError("REQUEST_ID_REQUIRED", "提交请求缺少幂等标识，请返回后重试");
  await loadTask(account, event.taskId);
  const records = await strictQuery(COLLECTIONS.idempotency, { action: "submitTask", resourceKey: event.taskId, requestId }, 2);
  if (records.length > 1) throw new ApiError("IDEMPOTENCY_KEY_CONFLICT", "同一提交请求存在多条防重记录，请联系管理员对账");
  if (!records.length) return undefined;
  if (records[0].status === "completed") return records[0].response;
  if (isAuthorizedAdminRetry(event) && event._adminRetryOperationId === records[0]._id) return undefined;
  throw new ApiError("OPERATION_IN_PROGRESS", "任务提交正在处理中，请稍后刷新；若长时间未完成请联系管理员");
}
async function refreshTaskProgress(task) {
  const drafts = await strictQuery(COLLECTIONS.drafts, { taskId: task.id }, 100); const requiredItems = task.items.filter((item) => item.required !== false); const completedCount = requiredItems.filter((item) => drafts.some((draft) => draft.itemId === item.id && draft.completed)).length; const progress = requiredItems.length ? Math.round(completedCount * 100 / requiredItems.length) : 100;
  const status = progress > 0 && task.status === "pending" ? "active" : task.status;
  const items = task.items.map((item) => {
    const draft = drafts.find((entry) => entry.itemId === item.id);
    if (!draft) return item;
    const itemStatus = draft.completed ? "completed" : (draft.rejectionReason ? "rectify" : "active");
    return { ...item, status: itemStatus };
  });
  const saved = await tryUpdate(COLLECTIONS.tasks, task.id, { items, progress, completedItemCount: completedCount, requiredItemCount: requiredItems.length, status, updatedAt: now() });
  if (!saved) throw new ApiError("TASK_PROGRESS_SAVE_FAILED", "任务进度保存失败，请重试");
  task.items = items;
  return { progress, completedCount, requiredCount: requiredItems.length, status };
}
function validateFields(fields, values) {
  const missing = fields.filter((field) => field.required && field.visible !== false).filter((field) => {
    const value = values[field.key]; if (field.inputType === "image") return !Array.isArray(value) || value.length < (field.minImages || 1); return value === undefined || value === null || String(value).trim() === "";
  });
  if (missing.length) throw new ApiError("VALIDATION_FAILED", `请完成：${missing.map((field) => field.label).join("、")}`, { fields: missing.map((field) => field.key) });
  for (const field of fields.filter((entry) => entry.visible !== false)) {
    const value = values[field.key];
    if (value === undefined || value === null || value === "") continue;
    if (field.inputType === "image") {
      const images = Array.isArray(value) ? value : [];
      if (field.maxImages > 0 && images.length > field.maxImages) throw new ApiError("VALIDATION_FAILED", `${field.label}最多上传 ${field.maxImages} 张图片`, { fields: [field.key] });
    }
    if (field.inputType === "singleChoice" && field.options?.length && !field.options.includes(value)) throw new ApiError("VALIDATION_FAILED", `${field.label}的选项无效，请重新选择`, { fields: [field.key] });
    if (field.inputType === "number" && !Number.isFinite(Number(value))) throw new ApiError("VALIDATION_FAILED", `${field.label}必须填写数字`, { fields: [field.key] });
    if (field.maxLength > 0 && String(value).length > field.maxLength) throw new ApiError("VALIDATION_FAILED", `${field.label}不能超过 ${field.maxLength} 个字`, { fields: [field.key] });
  }
}

async function createPublishedInstance(instance, existingByStore) {
  const existing = existingByStore.get(instance.storeRecordId);
  if (existing) {
    const id = existing._id || existing.id;
    const itemsChanged = (instance.items || []).some((item) => {
      const stored = (existing.items || []).find((entry) => (entry.configItemId || entry.id) === (item.configItemId || item.id));
      return item.smartSheetItemExecutionRecordId && stored?.smartSheetItemExecutionRecordId !== item.smartSheetItemExecutionRecordId;
    });
    const mergedItems = (existing.items || []).length ? (existing.items || []).map((stored) => {
      const linked = (instance.items || []).find((entry) => (entry.configItemId || entry.id) === (stored.configItemId || stored.id));
      return linked ? {
        ...stored,
        smartSheetItemExecutionRecordId: linked.smartSheetItemExecutionRecordId,
        itemExecutionKey: linked.itemExecutionKey,
      } : stored;
    }) : instance.items;
    const runtimeMutable = !["review", "completed"].includes(existing.status);
    const executionParametersChanged = runtimeMutable && runtimeParametersChanged(existing, instance);
    const resetLocation = runtimeMutable && locationPolicyChanged(existing, instance);
    const linkChanged = instance.smartSheetExecutionRecordId && existing.smartSheetExecutionRecordId !== instance.smartSheetExecutionRecordId;
    if (linkChanged || itemsChanged || executionParametersChanged) {
      const data = { updatedAt: now() };
      if (linkChanged || itemsChanged) Object.assign(data, {
        smartSheetExecutionRecordId: instance.smartSheetExecutionRecordId,
        items: mergedItems,
        itemExecutionSyncedAt: now(),
      });
      if (executionParametersChanged) Object.assign(data, {
        ...runtimeParameters(instance),
        runtimeParametersSyncedAt: now(),
      });
      if (resetLocation) data.location = {};
      await db.collection(COLLECTIONS.tasks).doc(id).update({ data });
    }
    return { id, storeRecordId: instance.storeRecordId, created: false, updated: Boolean(linkChanged || itemsChanged || executionParametersChanged) };
  }
  try {
    await db.collection(COLLECTIONS.tasks).add({ data: { ...instance, _id: instance.id } });
    return { id: instance.id, storeRecordId: instance.storeRecordId, created: true };
  } catch (error) {
    if (/exist|duplicate|重复|已存在/i.test(error.message || "")) return { id: instance.id, storeRecordId: instance.storeRecordId, created: false };
    throw error;
  }
}

function assertPublishedPlanImmutable(instances, existing) {
  if (!existing.length) return;
  const plannedStores = new Set(instances.map((instance) => instance.storeRecordId));
  const existingStores = new Set(existing.map((task) => task.storeRecordId));
  if (plannedStores.size !== existingStores.size || Array.from(plannedStores).some((storeId) => !existingStores.has(storeId))) {
    throw new ApiError("PUBLISHED_TASK_IMMUTABLE", "任务已生成执行清单，不能再增删任务门店；请新建一条任务发布记录");
  }
  const existingByStore = new Map(existing.map((task) => [task.storeRecordId, task]));
  for (const instance of instances) {
    const stored = existingByStore.get(instance.storeRecordId);
    const plannedItems = (instance.items || []).map((item) => item.configItemId || item.id).filter(Boolean).sort();
    const storedItems = (stored?.items || []).map((item) => item.configItemId || item.id).filter(Boolean).sort();
    if (plannedItems.length !== storedItems.length || plannedItems.some((itemId, index) => itemId !== storedItems[index])) {
      throw new ApiError("PUBLISHED_TASK_IMMUTABLE", "任务已生成执行清单，不能再增删任务项；请新建一条任务发布记录");
    }
  }
}

async function ensureSmartSheetItemExecutionRecords(contract, instances) {
  const result = await ensureTaskItemExecutions({
    parentExecutions: instances,
    loadExisting: () => smartSheet.getRecords(contract.sheetId),
    identityOfExisting: itemExecutionIdentity,
    serializeRecord: (record) => itemExecutionCreateEntry(record, contract),
    addBatch: async (entries) => {
      const response = await smartSheet.addRecords(contract.sheetId, entries.map((entry) => entry.record));
      const added = response.records || [];
      if (added.length !== entries.length || added.some((record) => !record.record_id)) {
        throw new ApiError("ITEM_EXECUTION_RECORD_WRITE_FAILED", "16_任务项执行新增记录数量与计划数量不一致");
      }
      return entries.map((entry, index) => ({ key: entry.key, recordId: added[index].record_id }));
    },
  });
  const recordsByKey = new Map();
  for (const existing of await smartSheet.getRecords(contract.sheetId)) {
    const identity = itemExecutionIdentity(existing);
    if (identity.parentExecutionRecordId && identity.taskItemRecordId) {
      const key = itemExecutionKey(identity.parentExecutionRecordId, identity.taskItemRecordId);
      if (recordsByKey.has(key)) throw new ApiError("TASK_ITEM_EXECUTION_DUPLICATE_EXISTING", `16_任务项执行存在重复记录：${key}`);
      recordsByKey.set(key, existing.record_id);
    }
  }
  const relevantRecordIds = [];
  for (const instance of instances) {
    for (const item of instance.items || []) {
      const key = itemExecutionKey(instance.smartSheetExecutionRecordId, item.configItemId || item.id);
      const recordId = recordsByKey.get(key);
      if (!recordId) throw new ApiError("ITEM_EXECUTION_RECONCILE_FAILED", `16_任务项执行缺少记录：${key}`);
      item.smartSheetItemExecutionRecordId = recordId;
      item.itemExecutionKey = key;
      relevantRecordIds.push(recordId);
    }
  }
  return {
    created: result.stats.toCreate,
    reused: result.stats.skipped,
    count: result.stats.desired,
    recordIds: relevantRecordIds,
  };
}

async function ensureSmartSheetExecutionRecords(executionSheetId, instances) {
  const missing = instances.filter((instance) => !instance.smartSheetExecutionRecordId);
  if (!missing.length) return { created: 0, reused: instances.length };
  const added = [];
  for (let offset = 0; offset < missing.length; offset += 500) {
    const chunk = missing.slice(offset, offset + 500);
    const response = await smartSheet.addRecords(executionSheetId, chunk.map((instance) => ({ values: executionRecordValues(instance) })));
    added.push(...(response.records || []));
  }
  if (added.length !== missing.length || added.some((record) => !record.record_id)) {
    throw new ApiError("EXECUTION_RECORD_WRITE_FAILED", "06_任务执行新增记录数量与任务门店数量不一致");
  }
  missing.forEach((instance, index) => { instance.smartSheetExecutionRecordId = added[index].record_id; });
  return { created: missing.length, reused: instances.length - missing.length };
}

async function syncSmartSheetExecutionParameters(executionSheetId, instances) {
  const linked = instances.filter((instance) => instance.smartSheetExecutionRecordId);
  if (!linked.length) return { updated: 0 };
  for (let offset = 0; offset < linked.length; offset += 500) {
    const chunk = linked.slice(offset, offset + 500);
    await smartSheet.updateRecords(executionSheetId, chunk.map((instance) => ({
      record_id: instance.smartSheetExecutionRecordId,
      values: {
        "开始时间": String(Date.parse(instance.startAt)),
        "截止时间": String(Date.parse(instance.deadlineAt)),
      },
    })));
  }
  return { updated: linked.length };
}

async function publishSmartSheetTasks(target = {}) {
  const sheets = await smartSheet.getSheets();
  const byTitle = Object.fromEntries(sheets.map((sheet) => [sheetTitle(sheet), sheet]));
  for (const title of Object.values(SHEETS)) if (!byTitle[title]) throw new ApiError("SMART_SHEET_STRUCTURE_INVALID", `智能表格缺少子表：${title}`);

  // Validate 16 -> 06 and 16 -> 05 before creating any 06/16 record.
  const itemExecutionContract = await loadItemExecutionContract(smartSheet, sheets);

  const publicationSheetId = sheetId(byTitle[SHEETS.publications]);
  if (target.docId && target.docId !== smartSheet.docId) throw new ApiError("SMART_SHEET_EVENT_IGNORED", "回调文档不是当前SFA智能表格");
  if (target.sheetId && target.sheetId !== publicationSheetId) throw new ApiError("SMART_SHEET_EVENT_IGNORED", "回调子表不是04_任务发布");
  const targetRecordIds = new Set((target.recordIds || []).map(String).filter(Boolean));
  const publications = (await smartSheet.getRecords(publicationSheetId, targetRecordIds.size ? { recordIds: [...targetRecordIds] } : {}))
    .filter((record) => !targetRecordIds.size || targetRecordIds.has(record.record_id))
    .filter(isConfirmedPublication);
  const [executionRecords, people, stores, typeRecords] = await Promise.all([
    smartSheet.getRecords(sheetId(byTitle[SHEETS.executions])),
    smartSheet.getRecords(sheetId(byTitle[SHEETS.people])),
    smartSheet.getRecords(sheetId(byTitle[SHEETS.stores])),
    smartSheet.getRecords(sheetId(byTitle[SHEETS.taskTypes])),
  ]);
  const schemaCache = await readCache("config_task_item_schemas");
  const schemas = schemaCache?.value || [];
  if (!schemas.length) throw new ApiError("TASK_ITEM_SCHEMA_NOT_READY", "任务项配置缓存为空，请先同步智能表格配置");
  const taskTypes = typeRecords.map(mapTaskType).filter((item) => item.code && item.name);
  const skipped = [];
  const publicationResults = [];
  let samplingConfiguration;
  let approvalConfiguration;
  for (const publication of publications) {
    let plan;
    try {
      const selectedItemIds = new Set(cellReferences(publication, "任务项"));
      const needsSamplingConfiguration = schemas.some((schema) => selectedItemIds.has(schema.itemId) && schema.renderer === "产品上样");
      const needsApprovalConfiguration = schemas.some((schema) => selectedItemIds.has(schema.itemId) && schema.requiresApproval);
      if (needsSamplingConfiguration && !samplingConfiguration) samplingConfiguration = await samplingConfigRepository.load();
      if (needsApprovalConfiguration && !approvalConfiguration) approvalConfiguration = await approvalConfigRepository.load();
      plan = buildPublicationPlan({
        publication,
        stores,
        people,
        taskTypes,
        schemas,
        executionRecords,
        samplingConfiguration: needsSamplingConfiguration ? samplingConfiguration : undefined,
        approvalConfiguration: needsApprovalConfiguration ? approvalConfiguration : undefined,
      });
      const existing = await queryAll(COLLECTIONS.tasks, { sourceTaskRecordId: plan.sourceTaskRecordId });
      assertPublishedPlanImmutable(plan.instances, existing);
      plan.existing = existing;
    } catch (error) {
      const message = `生成失败：${error.message || "未知错误"}`.slice(0, 500);
      try { await smartSheet.updateRecords(publicationSheetId, [{ record_id: publication.record_id, values: { "发布校验（自动）": textCell(message) } }]); } catch (_) {}
      skipped.push({ sourceTaskRecordId: publication.record_id, reason: "validation_failed", message });
      continue;
    }
    const existingByStoreForRevision = new Map((plan.existing || []).map((task) => [task.storeRecordId, task]));
    const runtimeNeedsSync = plan.instances.some((instance) => {
      const stored = existingByStoreForRevision.get(instance.storeRecordId);
      return !stored || (!["review", "completed"].includes(stored.status) && runtimeParametersChanged(stored, instance));
    });
    const runtimeRevision = runtimeParametersFingerprint(plan.instances).slice(0, 24);
    // Initial publishing keeps the stable legacy ledger. Parameter changes use
    // the source update time as their revision so a publisher can also change
    // values back to a previously used combination. The callback caused by our
    // own write-back sees matching task parameters and falls back to the stable
    // completed ledger, which stops callback loops.
    const revisionIdentity = safeId(publication.update_time || plan.sourceUpdatedAt || runtimeRevision);
    const ledgerId = runtimeNeedsSync && (plan.existing || []).length
      ? operationId("publish_update", safeId(publication.record_id), revisionIdentity, runtimeRevision)
      : operationId("publish", safeId(publication.record_id));
    const ledger = await readDocument(COLLECTIONS.idempotency, ledgerId);
    if (ledger?.status === "completed") {
      skipped.push({ sourceTaskRecordId: publication.record_id, reason: "already_completed" });
      continue;
    }
    if (ledger) {
      skipped.push({ sourceTaskRecordId: publication.record_id, reason: ledger.status || "manual_review" });
      continue;
    }
    try {
      const operation = await acquireCreateOnlyOperation({
        id: ledgerId,
        action: "publishTask",
        resourceKey: publication.record_id,
        requestId: `${publication.record_id}:${publication.update_time || ""}`,
        input: { sourceTaskRecordId: publication.record_id, updateTime: publication.update_time || "" },
      });
      if (operation.kind === "completed") {
        skipped.push({ sourceTaskRecordId: publication.record_id, reason: "already_completed" });
        continue;
      }
      try {
        const existing = plan.existing || [];
        const existingByStore = new Map(existing.map((task) => [task.storeRecordId, task]));
        const runtimeMutableInstances = plan.instances.filter((instance) => {
          const stored = existingByStore.get(instance.storeRecordId);
          return !stored || !["review", "completed"].includes(stored.status);
        });
        const executionLinkResult = await ensureSmartSheetExecutionRecords(sheetId(byTitle[SHEETS.executions]), plan.instances);
        const executionParameterSync = await syncSmartSheetExecutionParameters(sheetId(byTitle[SHEETS.executions]), runtimeMutableInstances);
        await advanceCreateOnlyOperation(operation, "parent_records_ready", {
          sourceTaskRecordId: plan.sourceTaskRecordId,
          taskNumber: plan.taskNumber,
          targetStoreRecordIds: plan.storeRecordIds,
          executionRecordsCreated: executionLinkResult.created,
        });
        const itemExecutionLinkResult = await ensureSmartSheetItemExecutionRecords(itemExecutionContract, plan.instances);
        await advanceCreateOnlyOperation(operation, "item_records_ready", {
          sourceTaskRecordId: plan.sourceTaskRecordId,
          taskNumber: plan.taskNumber,
          targetStoreRecordIds: plan.storeRecordIds,
          executionRecordsCreated: executionLinkResult.created,
          itemExecutionCount: itemExecutionLinkResult.count,
          itemExecutionRecordIds: itemExecutionLinkResult.recordIds,
          itemExecutionRecordsCreated: itemExecutionLinkResult.created,
        });
        const knownExecutionRecordIds = new Set(executionRecords.map((record) => record.record_id));
        plan.instances.forEach((instance) => {
          if (knownExecutionRecordIds.has(instance.smartSheetExecutionRecordId)) return;
          executionRecords.push({ record_id: instance.smartSheetExecutionRecordId, values: { "来源任务": [instance.sourceTaskRecordId], "执行门店": [instance.storeRecordId] } });
          knownExecutionRecordIds.add(instance.smartSheetExecutionRecordId);
        });
        const instanceResults = await mapLimit(plan.instances, 10, (instance) => createPublishedInstance(instance, existingByStore));
        const generated = instanceResults.filter((item) => item.created).length;
        const updated = instanceResults.filter((item) => item.updated).length;
        const reused = instanceResults.length - generated;
        const linkedExecutionCount = plan.instances.filter((instance) => instance.smartSheetExecutionRecordId).length;
        const validationText = updated > 0
          ? `参数同步成功：已更新 ${updated} 条未提交任务的执行时间和定位规则`
          : (linkedExecutionCount === plan.instances.length ? `生成成功：${plan.instances.length} 条任务清单已进入小程序并关联06表` : `小程序已生成 ${plan.instances.length} 条任务清单；06表已关联 ${linkedExecutionCount} 条`);
        await smartSheet.updateRecords(publicationSheetId, [{ record_id: plan.sourceTaskRecordId, values: { "发布校验（自动）": textCell(validationText), "执行总数（自动）": plan.instances.length, "任务编号（自动）": textCell(plan.taskNumber), "发布时间": String(Date.now()) } }]);
        const response = { sourceTaskRecordId: plan.sourceTaskRecordId, taskNumber: plan.taskNumber, generated, updated, reused, instanceCount: instanceResults.length, linkedExecutionCount, executionRecordsCreated: executionLinkResult.created, executionParametersUpdated: executionParameterSync.updated, itemExecutionCount: itemExecutionLinkResult.count, itemExecutionRecordsCreated: itemExecutionLinkResult.created, status: "completed" };
        await completeCreateOnlyOperation(operation, response);
        publicationResults.push(response);
      } catch (error) {
        const message = `生成失败：${error.message || "未知错误"}`.slice(0, 500);
        try { await smartSheet.updateRecords(publicationSheetId, [{ record_id: publication.record_id, values: { "发布校验（自动）": textCell(message) } }]); } catch (_) {}
        try { await advanceCreateOnlyOperation(operation, "manual_review", { status: "manual_review", message, failedAt: now() }); } catch (_) {}
        publicationResults.push({ sourceTaskRecordId: publication.record_id, status: "failed", message });
      }
    } catch (error) {
      if (error.code === "OPERATION_IN_PROGRESS") skipped.push({ sourceTaskRecordId: publication.record_id, reason: "processing" });
      else throw error;
    }
  }

  return {
    scanned: publications.length,
    generated: publicationResults.reduce((sum, item) => sum + (item.generated || 0), 0),
    reused: publicationResults.reduce((sum, item) => sum + (item.reused || 0), 0),
    failed: publicationResults.filter((item) => item.status === "failed").length,
    skipped,
    publications: publicationResults,
  };
}

const handlers = {
  async testSmartSheetConnection(_, account) {
    if (!account.roles.includes("管理员")) throw new ApiError("FORBIDDEN", "只有管理员可以测试智能表格连接");
    if (!smartSheet.configured) throw new ApiError("SMART_SHEET_NOT_CONFIGURED", "云函数尚未配置企业微信智能表格凭证");
    const sheets = await smartSheet.getSheets();
    return { connected: true, viaProxy: smartSheet.proxyConfigured, sheetCount: sheets.length, sheetTitles: sheets.map((sheet) => sheet.title || sheet.properties?.title).filter(Boolean), checkedAt: now() };
  },
  async inspectSmartSheetConfig(event, account) {
    if (!account.roles.includes("管理员")) throw new ApiError("FORBIDDEN", "只有管理员可以检查智能表格配置");
    const requested = Array.isArray(event.sheetTitles) ? event.sheetTitles.slice(0, 12) : [];
    const sheets = await smartSheet.getSheets();
    const result = {};
    for (const sheet of sheets) {
      const title = sheet.title || sheet.properties?.title;
      if (!requested.includes(title)) continue;
      const id = sheet.sheet_id || sheet.properties?.sheet_id;
      const [fields, records] = await Promise.all([smartSheet.getFields(id), smartSheet.getRecords(id)]);
      result[title] = { sheetId: id, fields: fields.map((field) => ({
        id: field.field_id,
        title: field.field_title,
        type: field.field_type,
        property: Object.fromEntries(Object.entries(field).filter(([key]) => key.startsWith("property_"))),
      })), records: records.slice(0, 20) };
    }
    return result;
  },
  async validateTaskApprovalRoute(event, account) {
    if (!account.roles.includes("管理员") && !account.system) throw new ApiError("FORBIDDEN", "只有管理员可以校验审批路由");
    const task = await loadTask(account, event.taskId);
    const items = (task.items || []).filter((item) => item.requiresApproval || item.approvalTemplateCode);
    if (!items.length) throw new ApiError("APPROVAL_NOT_REQUIRED", "该任务没有需要审批的任务项");
    const configuration = await approvalConfigRepository.load();
    const routes = items.map((item) => {
      const resolved = resolveNodeReviewer({ configuration, task, item, nodeIndex: 0 });
      return {
        itemId: item.id,
        itemName: item.name,
        templateName: resolved.templateName,
        nodeName: resolved.nodeName,
        regionName: resolved.regionName,
        duty: resolved.nodeDuty,
        reviewerUserId: resolved.userId,
        reviewerName: resolved.name,
        routeRecordId: resolved.routeRecordId,
      };
    });
    return { taskId: task.id, taskName: task.name, routes, checkedAt: now() };
  },
  async repairApprovalHistorySystemFields(event, account) {
    if (!account.roles.includes("管理员")) throw new ApiError("FORBIDDEN", "只有管理员可以修复审核记录系统字段");
    if (!smartSheet.configured) throw new ApiError("SMART_SHEET_NOT_CONFIGURED", "云函数尚未配置企业微信智能表格凭证");
    return repairApprovalHistorySystemFields(smartSheet, event.confirmation);
  },
  async migrateSamplingRuleStructure(event, account) {
    if (!account.roles.includes("管理员")) throw new ApiError("FORBIDDEN", "只有管理员可以迁移产品上样结构");
    if (!smartSheet.configured) throw new ApiError("SMART_SHEET_NOT_CONFIGURED", "云函数尚未配置企业微信智能表格凭证");
    const result = await migrateSamplingRuleStructure(smartSheet, event.confirmation);
    samplingConfigRepository.invalidate();
    return result;
  },
  async cleanupSamplingRuleStructure(event, account) {
    if (!account.roles.includes("管理员")) throw new ApiError("FORBIDDEN", "只有管理员可以精简产品上样结构");
    if (!smartSheet.configured) throw new ApiError("SMART_SHEET_NOT_CONFIGURED", "云函数尚未配置企业微信智能表格凭证");
    const result = await cleanupSamplingRuleStructure(smartSheet, event.confirmation);
    samplingConfigRepository.invalidate();
    return result;
  },
  async repairSamplingGroupRuleLinks(event, account) {
    if (!account.roles.includes("管理员")) throw new ApiError("FORBIDDEN", "只有管理员可以恢复产品规则关联");
    if (!smartSheet.configured) throw new ApiError("SMART_SHEET_NOT_CONFIGURED", "云函数尚未配置企业微信智能表格凭证");
    const result = await repairSamplingGroupRuleLinks(smartSheet, event.confirmation, event.links);
    samplingConfigRepository.invalidate();
    return result;
  },
  async migrateSamplingProductReview(event, account) {
    if (!account.roles.includes("管理员")) throw new ApiError("FORBIDDEN", "只有管理员可以迁移产品上样逐产品审核结构");
    if (!smartSheet.configured) throw new ApiError("SMART_SHEET_NOT_CONFIGURED", "云函数尚未配置企业微信智能表格凭证");
    return migrateSamplingProductReview(smartSheet, event.confirmation);
  },
  async refreshTaskTypes(_, account) {
    if (!account.roles.includes("管理员")) throw new ApiError("FORBIDDEN", "只有管理员可以刷新任务类型");
    if (!smartSheet.configured) throw new ApiError("SMART_SHEET_NOT_CONFIGURED", "云函数尚未配置企业微信智能表格凭证");
    const modules = await readTaskTypes(smartSheet);
    const refreshedAt = now();
    const saved = await trySet(COLLECTIONS.cache, "config_task_types", { key: "config:task-types", value: modules, source: "01_任务类型", refreshedAt });
    if (!saved) throw new ApiError("CACHE_WRITE_FAILED", "任务类型已读取，但写入云数据库缓存失败");
    return { modules, count: modules.length, refreshedAt };
  },
  async getWriteQueueStatus(event) {
    const jobIds = Array.isArray(event.jobIds) ? event.jobIds.map(String).filter(Boolean).slice(0, 50) : [];
    if (!jobIds.length) throw new ApiError("JOB_IDS_REQUIRED", "缺少写入任务编号");
    const result = await smartSheet.getQueueJobs(jobIds);
    if (!result.ok) throw new ApiError("GATEWAY_QUEUE_UNAVAILABLE", "写入队列暂时不可用");
    return { jobs: result.jobs || [] };
  },
  async syncSmartSheet(_, account) {
    if (!smartSheet.configured) throw new ApiError("SMART_SHEET_NOT_CONFIGURED", "云函数尚未配置企业微信智能表格凭证");
    if (!account.roles.includes("管理员") && !account.system) throw new ApiError("FORBIDDEN", "只有管理员可以同步配置");
    const schemas = await syncEnabledSchemas(smartSheet);
    const syncedAt = now();
    const saved = await trySet(COLLECTIONS.cache, "config_task_item_schemas", { key: "config:task-item-schemas", value: schemas, source: "05_任务项设置+15_任务项字段设置", syncedAt });
    if (!saved) throw new ApiError("CACHE_WRITE_FAILED", "任务项配置已读取，但写入云数据库缓存失败");
    return { schemas, cacheUpdated: true, syncedAt };
  },
  async syncPublishedTasks(event, account) {
    if (!smartSheet.configured) throw new ApiError("SMART_SHEET_NOT_CONFIGURED", "云函数尚未配置企业微信智能表格凭证");
    if (!account.roles.includes("管理员") && !account.system) throw new ApiError("FORBIDDEN", "只有管理员可以生成任务清单");
    const callback = event.smartSheetEvent || {};
    if (callback.event && callback.event !== "smart_sheet_change") throw new ApiError("SMART_SHEET_EVENT_IGNORED", "不是智能表格变更事件");
    if (callback.sheetId) {
      const sheets = await smartSheet.getSheets();
      const changedSheet = sheets.find((sheet) => sheetId(sheet) === callback.sheetId);
      const changedTitle = changedSheet && sheetTitle(changedSheet);
      const samplingChanged = Object.values(SAMPLING_SHEETS).includes(changedTitle) || Object.values(SAMPLING_SHEET_ALIASES).flat().includes(changedTitle);
      const approvalChanged = Object.values(APPROVAL_SHEETS).includes(changedTitle) && /^((17|18|19|20)_)/.test(changedTitle || "");
      if (samplingChanged || approvalChanged) {
        const regionCodeSync = changedTitle === REGION_SHEET_TITLE
          ? await ensureRegionCodes(smartSheet, { recordIds: callback.recordIds || event.recordIds })
          : undefined;
        if (samplingChanged) samplingConfigRepository.invalidate(callback.sheetId);
        if (approvalChanged) approvalConfigRepository.invalidate(callback.sheetId);
        smartSheet.invalidateFieldContract(callback.sheetId);
        return { ignored: true, reason: `${changedTitle}配置已更新，后续发布或审批将读取最新配置`, regionCodeSync };
      }
    }
    if (callback.changeType && !["add_record", "update_record"].includes(callback.changeType)) {
      return { ignored: true, reason: "记录删除事件不生成任务" };
    }
    return publishSmartSheetTasks({
      docId: callback.docId,
      sheetId: callback.sheetId,
      recordIds: callback.recordIds || event.recordIds,
    });
  },
  async retryTaskItemExecutionSync(event, account) {
    if (!smartSheet.configured) throw new ApiError("SMART_SHEET_NOT_CONFIGURED", "云函数尚未配置企业微信智能表格凭证");
    const task = await loadTask(account, event.taskId);
    const item = task.items.find((entry) => entry.id === event.itemId);
    if (!item) throw new ApiError("ITEM_NOT_FOUND", "任务项不存在");
    const draft = await loadDraft(account, task.id, item.id);
    const rejected = Boolean(draft?.rejectionReason);
    const requiresApproval = Boolean(item.approvalTemplateCode || item.requiresApproval);
    let status = rejected ? "rectify" : draft?.completed ? "completed" : draft?.values && Object.keys(draft.values).length ? "active" : "pending";
    let approvalStatus;
    let allowEdit = !["review", "completed"].includes(task.status) && (task.status !== "rectify" || rejected);
    if (task.status === "review" && requiresApproval) {
      status = "review";
      approvalStatus = "pending";
      allowEdit = false;
    } else if (task.status === "completed") {
      status = "completed";
      approvalStatus = requiresApproval ? "approved" : "none";
      allowEdit = false;
    } else if (!requiresApproval && draft?.completed) {
      approvalStatus = "none";
    }
    const synced = await syncTaskItemExecutionRecord({
      client: smartSheet,
      task,
      item,
      draft,
      account,
      status,
      approvalStatus,
      latestRejectionReason: draft?.rejectionReason || "",
      allowEdit,
      resultRecordId: draft?.smartSheetResultRecordId,
      resultSheetTitle: item.schemaSnapshot?.resultSheetTitle || item.resultSheetTitle || "",
    });
    if (!synced.skipped) await persistTaskItemExecutionLink(task, item, synced, status);
    return { taskId: task.id, itemId: item.id, status, recordId: synced.recordId || "", syncedAt: synced.syncedAt || "" };
  },
  async bootstrap(_, account) {
    const tasks = await loadTasks(account); const counts = (status) => tasks.filter((task) => task.status === status).length;
    const taskTypeCache = await readCache("config_task_types");
    return { profile: { name: account.name, roleLabel: account.roles[0] || "业务员", userId: account.wecomUserId }, metrics: { pending: counts("pending"), active: counts("active"), rectify: counts("rectify"), weekCompleted: counts("completed") }, modules: taskTypeCache?.value || [], config: { taskTypesReady: Boolean(taskTypeCache?.value?.length), taskTypesRefreshedAt: taskTypeCache?.refreshedAt || "" } };
  },
  async listTasks(event, account) { return (await loadTasks(account)).filter((task) => !event.taskType || task.taskType === event.taskType).map(taskListItem); },
  async getTask(event, account) {
    const task = await loadTask(account, event.taskId); const drafts = await strictQuery(COLLECTIONS.drafts, { taskId: task.id }, 100);
    const items = task.items.map((item) => {
      const draft = drafts.find((entry) => entry.itemId === item.id);
      const access = taskItemAccess(task, draft);
      const requiresApproval = Boolean(item.approvalTemplateCode || item.requiresApproval);
      const locallyCompleted = draft ? draft.completed === true : item.status === "completed";
      const status = task.status === "review" && requiresApproval && item.status === "review"
        ? "review"
        : (locallyCompleted ? "completed" : (access.rejected ? "rectify" : (item.status === "completed" ? "active" : item.status)));
      return { ...item, status, editable: access.editable, rejectionReason: draft?.rejectionReason || "" };
    });
    const required = items.filter((item) => item.required !== false);
    const windowAccess = taskWindowAccess(task);
    const executionAccess = taskExecutionAccess(task);
    const readOnly = ["review", "completed"].includes(task.status);
    return {
      ...task,
      readOnly,
      items,
      windowAccess,
      executionAccess,
      canCheckIn: !readOnly && task.requiresLocation === true && windowAccess.allowed,
      canSubmit: required.every((item) => item.status === "completed") && !readOnly && executionAccess.allowed,
    };
  },
  async getTaskItemForm(event, account) { const task = await loadTask(account, event.taskId); const item = task.items.find((entry) => entry.id === event.itemId); if (!item) throw new ApiError("ITEM_NOT_FOUND", "任务项不存在"); const draft = await loadDraft(account, task.id, item.id); const form = await resolveTaskItemForm(item); const access = taskItemAccess(task, draft); return { item: { ...form, editable: access.editable }, values: sanitizeValues(form.fields, draft.values), readOnly: !access.editable }; },
  async getSamplingForm(event, account) {
    const task = await loadTask(account, event.taskId);
    const item = task.items.find((entry) => entry.id === event.itemId);
    if (!item) throw new ApiError("ITEM_NOT_FOUND", "任务项不存在");
    if (item.renderer !== "sampling") throw new ApiError("ITEM_RENDERER_INVALID", "当前任务项不是产品上样任务");
    if (!item.samplingSnapshot) throw new ApiError("SAMPLING_SNAPSHOT_MISSING", "产品上样任务缺少发布快照，请联系任务发布者重新发布任务");
    const draft = await loadDraft(account, task.id, item.id);
    const approvals = await strictQuery(COLLECTIONS.approvals, { taskId: task.id, itemId: item.id }, 100);
    const latestApproval = approvals.sort((a, b) => String(b.submittedAt || "").localeCompare(String(a.submittedAt || "")))[0];
    const access = taskItemAccess(task, draft);
    return samplingFormModel(item.samplingSnapshot, draft.values || {}, {
      readOnly: !access.editable,
      currentRound: Number(draft.lastSubmittedRound || draft.itemSubmissionRound || 0),
      rejectionReason: draft.rejectionReason || "",
      approvalStatus: latestApproval?.statusLabel || item.approvalStatus || "",
      samplingReview: draft.samplingReview,
    });
  },
  async saveItemDraft(event, account) {
    const task = await loadTask(account, event.taskId);
    const item = task.items.find((entry) => entry.id === event.itemId);
    if (!item) throw new ApiError("ITEM_NOT_FOUND", "任务项不存在");
    await assertItemEditable(task, item.id);
    const existingDraft = await loadDraft(account, task.id, item.id);
    if (existingDraft.pendingCompleteOperationId) throw new ApiError("OPERATION_IN_PROGRESS", "任务项正在处理中，请稍后刷新");
    const form = item.renderer === "sampling" ? null : await resolveTaskItemForm(item);
    const values = item.renderer === "sampling"
      ? validateSamplingEditAccess(item.samplingSnapshot, existingDraft.values || {}, event.values, existingDraft.samplingReview)
      : sanitizeValues(form.fields, event.values);
    const draft = await saveDraftIfCurrent(account, task.id, item.id, values, false, { allowCompletedOverwrite: true, samplingReview: existingDraft.samplingReview });
    const [taskProgress, imagePreSync] = await Promise.all([
      measurePhase("saveItemDraft", "task_progress", () => refreshTaskProgress(task)),
      item.renderer === "sampling" && event.preSyncImages === true
        ? preSyncSamplingDraftImages({ item, values, draft })
        : item.renderer !== "sampling" && event.preSyncImages === true
          ? preSyncTaskItemDraftImages({ form, values, draft })
          : Promise.resolve({ status: "deferred", syncedCount: 0 }),
    ]);
    task.status = taskProgress.status;
    return { ...draft, taskProgress, imagePreSync, syncDeferred: true };
  },
  async completeTaskItem(event, account) {
    const requestId = String(event.requestId || "").trim();
    if (!requestId) throw new ApiError("REQUEST_ID_REQUIRED", "任务项提交缺少幂等标识，请返回后重试");
    const task = await loadTask(account, event.taskId);
    const item = task.items.find((entry) => entry.id === event.itemId);
    if (!item) throw new ApiError("ITEM_NOT_FOUND", "任务项不存在");
    await assertItemEditable(task, item.id);
    const existingDraft = await loadDraft(account, task.id, item.id);
    if (existingDraft.pendingCompleteOperationId) throw new ApiError("OPERATION_IN_PROGRESS", "任务项正在处理中，请稍后刷新");
    let values = event.values || {};
    if (item.renderer === "sampling") {
      validateSamplingEditAccess(item.samplingSnapshot, existingDraft.values || {}, values, existingDraft.samplingReview);
      values = validateSamplingSubmission(item.samplingSnapshot, values, { samplingReview: existingDraft.samplingReview }).values;
    }
    else {
      const form = await resolveTaskItemForm(item);
      values = sanitizeValues(form.fields, values);
      validateFields(form.fields, values);
    }
    const round = Number(existingDraft.completionRound || 0) + 1;
    const operation = await acquireCreateOnlyOperation({
      id: operationId("complete", event.taskId, event.itemId, round),
      action: "completeTaskItem",
      resourceKey: `${event.taskId}:${event.itemId}:${round}`,
      requestId,
      input: { taskId: event.taskId, itemId: event.itemId, round, requestId, values: event.values || {}, userId: account.wecomUserId },
    });
    if (operation.kind === "completed") return operation.response;
    try {
    const draft = item.renderer === "sampling"
      ? await completeSamplingDraft({ task, item, account, values, operation })
      : await saveDraft(account, task.id, item.id, values, true, { pendingCompleteOperationId: operation.id });
    if (item.renderer !== "sampling") await measurePhase("completeTaskItem", "dynamic_result_writeback", () => writeBackTaskItem(task, item, draft, account, false));
    const taskProgress = await measurePhase("completeTaskItem", "task_progress", () => refreshTaskProgress(task));
    await measurePhase("completeTaskItem", "parent_execution_writeback", () => syncExecutionRecord({ client: smartSheet, task, account, status: taskProgress.status, progress: taskProgress, approvalStatus: "待提交" }));
    const response = { ...draft, pendingCompleteOperationId: "", completionRound: round, taskProgress };
    const draftSaved = await tryUpdate(COLLECTIONS.drafts, draft._id, { pendingCompleteOperationId: "", completionRound: round, updatedAt: now() });
    if (!draftSaved) throw new ApiError("DRAFT_SAVE_FAILED", "任务项已回写，但完成状态保存失败；请勿重复提交并联系管理员");
    return completeCreateOnlyOperation(operation, response);
    } catch (error) {
      if (isPreSideEffectError(error) || ["SAMPLING_IMAGE_DOWNLOAD_FAILED", "SAMPLING_IMAGE_UPLOAD_FAILED"].includes(error?.code)) await abandonCreateOnlyOperation(operation);
      throw error;
    }
  },
  async checkIn(event, account) {
    const task = await loadTask(account, event.taskId);
    if (task.requiresLocation !== true) throw new ApiError("LOCATION_NOT_REQUIRED", "该任务无需定位签到");
    const windowAccess = taskWindowAccess(task);
    if (!windowAccess.allowed) throw new ApiError(windowAccess.code, windowAccess.message);
    const distance = distanceMeters(event.latitude, event.longitude, task.storeLocation.latitude, task.storeLocation.longitude);
    const allowed = task.allowedDistanceMeters || 500;
    if (distance > allowed && task.outOfRangePolicy === "block") throw new ApiError("OUT_OF_RANGE", `距离门店约 ${Math.round(distance)} 米，超过允许范围 ${allowed} 米`);
    let geocoded = { address: "", resolved: false, reason: "NOT_REQUESTED" };
    try { geocoded = await reverseGeocode(event.latitude, event.longitude); }
    catch (error) {
      geocoded = { address: "", resolved: false, reason: "REVERSE_GEOCODE_FAILED" };
      console.warn("check-in reverse geocode failed", error.message || error);
    }
    const location = { checkedIn: true, latitude: event.latitude, longitude: event.longitude, accuracy: event.accuracy, distanceMeters: Math.round(distance), address: geocoded.address, addressResolved: geocoded.resolved, addressResolveReason: geocoded.reason, checkedAt: now(), checkedBy: account.wecomUserId };
    await tryAdd(COLLECTIONS.locations, { taskId: task.id, ...location });
    const status = task.status === "pending" ? "active" : task.status;
    const saved = await tryUpdate(COLLECTIONS.tasks, task.id, { location, status, updatedAt: now() });
    if (!saved) throw new ApiError("CHECK_IN_SAVE_FAILED", "签到位置保存失败，请重试");
    await syncExecutionRecord({ client: smartSheet, task, account, status, progress: { completedCount: task.completedItemCount || 0, requiredCount: task.requiredItemCount || (task.items || []).filter((item) => item.required !== false).length }, approvalStatus: "待提交" });
    return location;
  },
  async retrySamplingSubmission(event, account) {
    if (!account.roles.includes("管理员")) throw new ApiError("FORBIDDEN", "只有管理员可以继续未完成的产品上样提交");
    const taskId = String(event.taskId || "").trim();
    const requestId = String(event.requestId || "").trim();
    if (!taskId || !requestId) throw new ApiError("RETRY_TARGET_REQUIRED", "请提供任务编号和原提交请求编号");
    const operations = await strictQuery(COLLECTIONS.idempotency, { action: "submitTask", resourceKey: taskId, requestId }, 2);
    if (!operations.length) throw new ApiError("RETRY_OPERATION_NOT_FOUND", "未找到对应的未完成提交记录");
    if (operations.length > 1) throw new ApiError("IDEMPOTENCY_KEY_CONFLICT", "同一提交请求存在多条防重记录，请先人工对账");
    const existing = operations[0];
    if (existing.status === "completed") return { ...existing.response, replayed: true };
    if (existing.status !== "processing") throw new ApiError("RETRY_OPERATION_INVALID", "该提交记录当前不允许继续执行");
    const task = await loadTask(account, taskId);
    if (!(task.items || []).some((item) => item.renderer === "sampling")) throw new ApiError("RETRY_NOT_SAMPLING_TASK", "该任务不包含产品上样任务项");
    const actorUserId = String(existing.actorUserId || "").trim();
    if (!actorUserId || !Number(existing.round)) throw new ApiError("RETRY_OPERATION_INCOMPLETE", "原提交记录缺少执行人或轮次，需人工对账后再处理");
    const actors = await strictQuery(COLLECTIONS.accounts, { wecomUserId: actorUserId, status: "active" }, 2);
    if (actors.length !== 1) throw new ApiError("RETRY_ACTOR_INVALID", "原提交人的账号绑定不存在或不唯一，请先修复账号绑定");
    if (existing.phase === "parent_state_ready") {
      const claimed = await acquireCreateOnlyOperation({
        id: existing._id,
        action: "submitTask",
        resourceKey: taskId,
        requestId,
        input: { taskId, round: Number(existing.round), requestId, userId: actorUserId },
        forceTakeover: true,
      });
      const response = { status: task.status, approvalCount: (task.items || []).filter((item) => item.approvalTemplateCode || item.requiresApproval).length };
      await completeCreateOnlyOperation(claimed, response);
      return { ...response, recoveredFromPhase: "parent_state_ready" };
    }
    const expectedOperationId = operationId("submit", taskId, Number(existing.round));
    if (existing._id !== expectedOperationId) throw new ApiError("RETRY_OPERATION_CONFLICT", "提交记录编号与任务轮次不一致，请先人工对账");
    return handlers.submitTask({ taskId, requestId, _adminRetryOperationId: existing._id, _adminRetryCapability: ADMIN_RETRY_CAPABILITY }, actors[0]);
  },
  async submitTask(event, account) {
    const replay = await replaySubmittedRequest(event, account);
    if (replay) return replay;
    const task = await handlers.getTask(event, account);
    if (!task.executionAccess?.allowed) throw new ApiError(task.executionAccess?.code || "TASK_NOT_EXECUTABLE", task.executionAccess?.message || "当前不能提交任务");
    if (!task.canSubmit) throw new ApiError("TASK_INCOMPLETE", "请先完成全部必做任务项");
    const approvalItems = task.items.filter((item) => item.approvalTemplateCode || item.requiresApproval).map((item) => ({ ...item, approvalTemplateCode: item.approvalTemplateCode || (item.approvalTemplateIds || [])[0] || "CONFIGURED_APPROVAL" }));
    const drafts = await strictQuery(COLLECTIONS.drafts, { taskId: task.id }, 100);
    const draftByItem = new Map(drafts.map((draft) => [draft.itemId, draft]));
    for (const item of task.items) {
      const draft = draftByItem.get(item.id);
      if (item.required !== false && !draft?.completed) throw new ApiError("TASK_INCOMPLETE", `请先完成任务项“${item.name}”`);
      if (item.renderer === "sampling") {
        validateSamplingSubmission(item.samplingSnapshot, draft?.values || {}, { samplingReview: draft?.samplingReview });
        const itemRound = Number(draft?.lastSubmittedRound || 0) + 1;
        desiredSamplingResults({
          snapshot: item.samplingSnapshot,
          values: draft?.values || {},
          imageCache: draft?.smartSheetImageCache || {},
          itemExecutionRecordId: item.smartSheetItemExecutionRecordId,
          round: itemRound,
          requiresApproval: approvalItems.some((candidate) => candidate.id === item.id),
          samplingReview: draft?.samplingReview,
        });
      }
    }
    const resolvedReviewers = new Map();
    const retryOperation = isAuthorizedAdminRetry(event) ? await readDocument(COLLECTIONS.idempotency, event._adminRetryOperationId) : null;
    const frozenReviewerRoutes = retryOperation?.context?.reviewerRoutes || {};
    if (approvalItems.length) {
      const itemsNeedingResolution = approvalItems.filter((item) => !frozenReviewerRoutes[item.id]);
      const approvalConfiguration = itemsNeedingResolution.length ? await approvalConfigRepository.load() : null;
      for (const item of approvalItems) {
        resolvedReviewers.set(item.id, frozenReviewerRoutes[item.id] || resolveNodeReviewer({ configuration: approvalConfiguration, task, item, nodeIndex: 0 }));
      }
    }
    return idempotentSubmit(event, account, task, async (operation, loadedTask, round) => {
      const status = approvalItems.length ? "review" : "completed";
      const submittedAt = operation.existing?.submittedAt || now();
      const progress = { completedCount: task.items.filter((item) => item.required !== false && item.status === "completed").length, requiredCount: task.items.filter((item) => item.required !== false).length };
      const resultByItem = new Map();
      const approvalByItem = new Map();
      const frozenItemRounds = operation.existing?.context?.itemRounds || {};
      const itemRoundById = new Map(task.items.map((item) => [item.id, Number(frozenItemRounds[item.id] || 0) || Number(draftByItem.get(item.id)?.lastSubmittedRound || 0) + 1]));
      await runSubmissionOrchestrator({
        advance: async (phase, context) => advanceCreateOnlyOperation(operation, phase, { status: "processing", submittedAt, context }),
        onPhaseComplete: ({ phase, durationMs, ok, code }) => {
          const startedAt = Date.now() - durationMs;
          performanceLog("submitTask", phase, startedAt, ok, code);
        },
        hooks: {
          reviewer_ready: async () => ({ reviewerCount: resolvedReviewers.size, reviewerRoutes: Object.fromEntries(resolvedReviewers), itemRounds: Object.fromEntries(itemRoundById) }),
          images_ready: async () => ({ samplingItemCount: task.items.filter((item) => item.renderer === "sampling").length }),
          results_ready: async () => {
            await writeBackAllTaskResults(task, account, drafts);
            const samplingItems = task.items.filter((entry) => entry.renderer === "sampling");
            const samplingResults = await mapWithConcurrency(samplingItems, 3, async (item) => {
              const draft = draftByItem.get(item.id);
              const requiresApproval = approvalItems.some((candidate) => candidate.id === item.id);
              const result = await writeSamplingResults({
                client: smartSheet,
                snapshot: item.samplingSnapshot,
                values: draft.values,
                imageCache: draft.smartSheetImageCache,
                itemExecutionRecordId: item.smartSheetItemExecutionRecordId,
                round: itemRoundById.get(item.id),
                requiresApproval,
                samplingReview: draft.samplingReview,
              });
              return { itemId: item.id, result };
            });
            for (const entry of samplingResults) resultByItem.set(entry.itemId, entry.result);
            return { resultCount: [...resultByItem.values()].reduce((sum, result) => sum + result.resultCount, 0) };
          },
          approval_ready: async () => {
            const approvals = await mapWithConcurrency(approvalItems, 3, async (item) => {
              const route = resolvedReviewers.get(item.id);
              const draft = draftByItem.get(item.id);
              const resultRecordIds = resultByItem.get(item.id)?.recordIds || (draft.smartSheetResultRecordId ? [draft.smartSheetResultRecordId] : []);
              const record = buildApprovalRecord({ task, item, draft, account, route, round: itemRoundById.get(item.id), resultRecordIds, submittedAt });
              const created = await createApprovalOnce(record);
              return { itemId: item.id, record: created.record };
            });
            for (const entry of approvals) approvalByItem.set(entry.itemId, entry.record);
            return { approvalCount: approvalByItem.size };
          },
          audit_ready: async () => {
            const action = task.status === "rectify" ? "整改重提" : "提交审批";
            await mapWithConcurrency(approvalItems, 3, async (item) => {
              const route = resolvedReviewers.get(item.id);
              const approval = approvalByItem.get(item.id);
              await appendApprovalHistory({
                client: smartSheet,
                approvalId: approval.id || approval._id,
                nodeRecordId: route.nodeRecordId,
                action,
                itemExecutionRecordId: item.smartSheetItemExecutionRecordId,
                templateRecordId: route.templateRecordId,
                regionRecordId: route.regionRecordId,
                round: itemRoundById.get(item.id),
                operatorUserId: account.wecomUserId,
                operatorName: account.name,
              });
            });
            return { auditCount: approvalItems.length };
          },
          item_state_ready: async () => {
            const itemStates = await mapWithConcurrency(task.items, 3, async (item) => {
              const requiresApproval = approvalItems.some((candidate) => candidate.id === item.id);
              const draft = draftByItem.get(item.id);
              const resultIds = resultByItem.get(item.id)?.recordIds.map((entry) => entry.recordId) || [];
              const samplingResultEntries = resultByItem.get(item.id)?.recordIds || [];
              const previousReview = normalizeSamplingReview(draft.samplingReview);
              const currentResultByProduct = { ...previousReview.currentResultByProduct };
              for (const entry of samplingResultEntries) currentResultByProduct[entry.productRecordId] = { recordId: entry.recordId, resultKey: entry.resultKey };
              const synced = await syncTaskItemExecutionRecord({
                client: smartSheet,
                task,
                item,
                draft,
                account,
                status: requiresApproval ? "review" : "completed",
                submittedAt,
                approvalStatus: requiresApproval ? "pending" : "none",
                latestRejectionReason: "",
                allowEdit: false,
                resultRecordId: resultIds.length ? resultIds.join(",") : draft.smartSheetResultRecordId,
                resultSheetTitle: item.schemaSnapshot?.resultSheetTitle || item.resultSheetTitle || "",
              });
              if (!synced.skipped) {
                item.status = requiresApproval ? "review" : "completed";
              }
              const draftSaved = await tryUpdate(COLLECTIONS.drafts, draft._id, {
                lastSubmittedRound: itemRoundById.get(item.id),
                itemSubmissionRound: itemRoundById.get(item.id),
                lastSubmittedAt: submittedAt,
                lastResultRecordIds: resultIds,
                rectificationPending: false,
                rejectionReason: "",
                unlockedAt: "",
                samplingReview: item.renderer === "sampling" ? {
                  ...previousReview,
                  currentResultByProduct,
                  rejectedProducts: {},
                  pendingDeleteFileIds: [],
                } : draft.samplingReview,
                updatedAt: now(),
              });
              if (!draftSaved) throw new ApiError("ITEM_SUBMISSION_STATE_SAVE_FAILED", `任务项“${item.name}”已写入外部结果，但本地提交轮次保存失败，请勿重复提交并联系管理员`);
              return !synced.skipped;
            });
            if (itemStates.some(Boolean)) {
              const linksSaved = await tryUpdate(COLLECTIONS.tasks, task.id, { items: task.items, itemExecutionSyncedAt: now(), updatedAt: now() });
              if (!linksSaved) throw new ApiError("ITEM_EXECUTION_LINK_SAVE_FAILED", "任务项执行已写入智能表格，但本地关联记录保存失败，请重试");
            }
            return { itemCount: task.items.length };
          },
          parent_state_ready: async () => {
            await syncExecutionRecord({ client: smartSheet, task, account, status, progress, submittedAt, approvalStatus: approvalItems.length ? "待审核" : "无需审批" });
            const saved = await tryUpdate(COLLECTIONS.tasks, task.id, { status, submissionRound: round, progress: 100, completedItemCount: progress.completedCount, requiredItemCount: progress.requiredCount, submittedAt, submittedBy: account.wecomUserId, latestRejectionReason: "", completedAt: status === "completed" ? submittedAt : "" });
            if (!saved) throw new ApiError("TASK_SUBMIT_SAVE_FAILED", "任务提交状态保存失败，请重试");
            return { status };
          },
        },
      });
      return { status, approvalCount: approvalByItem.size };
    });
  },
  async listApprovals(event, account) {
    const pending = event.status === "pending";
    const where = pending ? { status: "pending" } : {};
    if (!account.roles.includes("管理员")) where.currentReviewerUserId = account.wecomUserId;
    const approvals = await queryAll(COLLECTIONS.approvals, where);
    return approvals.filter((item) => pending ? item.status === "pending" : item.status !== "pending");
  },
  async getApproval(event, account) {
    const approvalId = String(event.approvalId || "").trim();
    if (!approvalId) throw new ApiError("APPROVAL_NOT_FOUND", "审核记录不存在或审核人已变更");
    const source = await readDocument(COLLECTIONS.approvals, approvalId);
    const allowed = source && (source.currentReviewerUserId === account.wecomUserId || account.roles.includes("管理员"));
    if (!allowed) throw new ApiError("APPROVAL_NOT_FOUND", "审核记录不存在或审核人已变更");
    const approval = normalizeLegacySamplingApproval({ ...source, id: source._id || source.id });
    return { ...approval, canDecide: !approval.compatibilityError && approval.status === "pending" };
  },
  async decideApproval(event, account) {
    const requestId = String(event.requestId || "").trim();
    if (!requestId) throw new ApiError("REQUEST_ID_REQUIRED", "审批请求缺少幂等标识，请刷新后重试");
    const approval = await handlers.getApproval(event, account);
    if (!approval.canDecide) throw new ApiError("APPROVAL_ALREADY_HANDLED", "该审批已处理，请刷新列表");
    let decisionEvent = event;
    if (approval.reviewMode === "product") {
      const productDecisions = normalizeProductDecisions(event.productDecisions, approval.reviewProductIds);
      const productReview = deriveProductReview(productDecisions);
      decisionEvent = { ...event, decision: productReview.decision, reason: formatProductReviewOpinion(productReview, approval.evidenceGroups), productDecisions, productReview };
    }
    if (!["approved", "rejected"].includes(decisionEvent.decision)) throw new ApiError("INVALID_DECISION", "无效的审核动作");
    if (decisionEvent.decision === "rejected" && !String(decisionEvent.reason || "").trim()) throw new ApiError("REASON_REQUIRED", "退回时必须填写整改原因");
    const operation = await acquireCreateOnlyOperation({
      // Each node is a separate business decision. Reusing one operation id for
      // the whole approval would make node 2 replay node 1's completed result.
      id: operationId("approval", approval.id, approval.currentNodeRecordId || "legacy"),
      action: "decideApproval",
      resourceKey: approval.id,
      requestId,
      input: { approvalId: approval.id, decision: decisionEvent.decision, reason: decisionEvent.reason || "", productDecisions: decisionEvent.productDecisions || [], userId: account.wecomUserId },
    });
    if (operation.kind === "completed") return operation.response;
    const task = await loadTaskForApproval(approval);
    const item = task.items.find((entry) => entry.id === approval.itemId);
    if (!item) throw new ApiError("ITEM_NOT_FOUND", "审批对应的任务项不存在");
    if (approval.itemSubmissionRound && approval.currentNodeRecordId && approval.templateRecordId && approval.matchedRegionRecordId) {
      return decideFormalApproval({ approval, task, item, event: decisionEvent, account, operation });
    }
    const progress = { completedCount: task.completedItemCount || 0, requiredCount: task.requiredItemCount || (task.items || []).filter((item) => item.required !== false).length };
    let nextTaskStatus = task.status;
    let approvalStatus = "审核中";
    if (event.decision === "rejected") {
      nextTaskStatus = "rectify";
      approvalStatus = "已驳回";
    } else {
      const { allRequiredItemsApproved } = await recomputeApprovalTaskState(task, approval, "approved");
      if (allRequiredItemsApproved) {
        nextTaskStatus = "completed";
        approvalStatus = "已通过";
      }
    }
    const [itemExecutionSynced] = await Promise.all([
      syncTaskItemExecutionRecord({
        client: smartSheet,
        task,
        item,
        account,
        status: event.decision === "approved" ? "completed" : "rectify",
        approvalStatus: event.decision,
        latestRejectionReason: event.decision === "rejected" ? event.reason : "",
        allowEdit: event.decision === "rejected",
        touchSavedBy: false,
      }),
      syncExecutionRecord({ client: smartSheet, task, account, status: nextTaskStatus, progress, approvalStatus, touchSavedBy: false }),
    ]);
    if (!itemExecutionSynced.skipped) await persistTaskItemExecutionLink(task, item, itemExecutionSynced, event.decision === "approved" ? "completed" : "rectify");
    if (event.decision === "rejected") {
      const drafts = await strictQuery(COLLECTIONS.drafts, { taskId: approval.taskId, itemId: approval.itemId }, 2);
      const rejection = { taskId: approval.taskId, itemId: approval.itemId, completed: false, rejectionReason: event.reason, rectificationPending: true, unlockedAt: now(), updatedAt: now() };
      const rejectionSaved = drafts[0]
        ? await tryUpdate(COLLECTIONS.drafts, drafts[0]._id, rejection)
        : await tryAdd(COLLECTIONS.drafts, { ...rejection, values: {}, updatedBy: approval.submitterUserId || "", updatedByName: approval.submitterName || "" });
      if (!rejectionSaved) throw new ApiError("REJECTION_SAVE_FAILED", "整改信息保存失败，请重试审批操作");
      const taskSaved = await tryUpdate(COLLECTIONS.tasks, approval.taskId, { status: "rectify", latestRejectionReason: event.reason });
      if (!taskSaved) throw new ApiError("TASK_APPROVAL_STATUS_SAVE_FAILED", "任务整改状态保存失败，请重试审批操作");
    } else if (nextTaskStatus === "completed") {
      const taskSaved = await tryUpdate(COLLECTIONS.tasks, approval.taskId, { status: "completed", progress: 100, completedAt: now() });
      if (!taskSaved) throw new ApiError("TASK_APPROVAL_STATUS_SAVE_FAILED", "任务完成状态保存失败，请重试审批操作");
    }
    // Mark the approval handled only after every child, parent and local state
    // update succeeds. Until then the same approval remains safely replayable.
    const approvalSaved = await tryUpdate(COLLECTIONS.approvals, approval.id, { status: event.decision, statusLabel: event.decision === "approved" ? "已通过" : "已退回", reason: event.reason || "", decidedAt: now(), decidedBy: account.wecomUserId, decidedByName: account.name });
    if (!approvalSaved) throw new ApiError("APPROVAL_SAVE_FAILED", "审批状态保存失败，请重试；此前写入均可安全重放");
    if (event.decision === "approved" && nextTaskStatus !== "completed") {
      const { allRequiredItemsApproved } = await recomputeApprovalTaskState(task, approval, "approved");
      if (allRequiredItemsApproved) {
        const finalized = await tryUpdate(COLLECTIONS.tasks, approval.taskId, { status: "completed", progress: 100, completedAt: now() });
        if (!finalized) throw new ApiError("TASK_APPROVAL_STATUS_SAVE_FAILED", "审批已通过，但任务汇总状态保存失败，请联系管理员对账");
        await syncExecutionRecord({ client: smartSheet, task, account, status: "completed", progress, approvalStatus: "已通过", touchSavedBy: false });
      }
    }
    return completeCreateOnlyOperation(operation, { status: event.decision });
  },
  async getMyStats(_, account) { const tasks = await loadTasks(account); const count = (status) => tasks.filter((task) => task.status === status).length; const completed = count("completed"); return { pending: count("pending"), active: count("active"), rectify: count("rectify"), completed, completionRate: tasks.length ? Math.round(completed * 100 / tasks.length) : 0 }; },
  async getProfile(_, account) { const pending = await handlers.listApprovals({ status: "pending" }, account); return { profile: { name: account.name, roleLabel: account.roles[0] || "业务员", userId: account.wecomUserId, scopeLabel: account.scopeLabel }, approvalCount: pending.length }; },
};

exports.main = async (event = {}) => {
  const startedAt = Date.now();
  try { const account = callbackSystemAccount(event) || await authenticate(); const handler = handlers[event.action]; if (!handler) throw new ApiError("ACTION_NOT_FOUND", "不支持的操作"); const data = await handler(event, account); await tryAdd(COLLECTIONS.logs, { action: event.action, userId: account.wecomUserId, ok: true, durationMs: Date.now() - startedAt, createdAt: now() }); return ok(data); }
  catch (error) { await tryAdd(COLLECTIONS.logs, { action: event.action, ok: false, code: error.code || "INTERNAL_ERROR", message: error.message, durationMs: Date.now() - startedAt, createdAt: now() }); console.error(error); return fail(error); }
};
