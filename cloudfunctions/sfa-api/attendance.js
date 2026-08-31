const ATTENDANCE_TASK_TYPE = "ATTENDANCE_CHECK";
const ATTENDANCE_RESULT_SHEET = "13_考勤结果";
const ATTENDANCE_ITEM_NAMES = Object.freeze({ photo: "正面照", work: "工作内容收集" });
const ATTENDANCE_FIELDS = Object.freeze({ photo: "正面照", work: "工作内容", customer: "当前客户名称", place: "当前所在地" });
const ATTENDANCE_PLACE_OPTIONS = Object.freeze([
  "零售门店",
  "经销商办公室",
  "项目工地/楼盘",
  "项目方办公室/门店",
  "装企门店",
  "建材市场/商圈/家居城",
  "客户仓库",
  "佛山总部",
  "生产基地（含外协厂）",
  "活动/培训/会议现场",
  "在路上",
  "异常:非工作场所",
]);

function attendanceError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function fieldByLabel(fields, label) {
  return (fields || []).find((field) => field.label === label);
}

function decorateAttendanceSchema(schema) {
  if (!schema) return schema;
  const role = schema.itemName === ATTENDANCE_ITEM_NAMES.photo ? "photo"
    : schema.itemName === ATTENDANCE_ITEM_NAMES.work ? "work" : "";
  if (!role) return { ...schema, attendanceRole: "" };
  const fields = (schema.fields || []).map((field) => {
    if (role === "photo" && field.label === ATTENDANCE_FIELDS.photo) {
      // The established result sheet already uses “正面照片”; preserve the
      // product-facing label “正面照” while writing to that existing column.
      return { ...field, resultFieldTitle: "正面照片", required: true, inputType: "image", minImages: 1, maxImages: 1, cameraOnly: true, camera: "front", watermark: "attendance" };
    }
    if (role === "work" && field.label === ATTENDANCE_FIELDS.work) return { ...field, required: true, inputType: "textarea", maxLength: 500 };
    if (role === "work" && field.label === ATTENDANCE_FIELDS.customer) return { ...field, required: true, inputType: "text", maxLength: 100 };
    if (role === "work" && field.label === ATTENDANCE_FIELDS.place) return { ...field, required: true, inputType: "singleChoice", options: [...ATTENDANCE_PLACE_OPTIONS] };
    return field;
  });
  return { ...schema, required: true, requiresApproval: false, attendanceRole: role, autoAdvance: role === "photo", promptSubmitOnComplete: role === "work", fields };
}

function validateAttendanceSchemas(schemas, requiresLocation) {
  if (!requiresLocation) throw attendanceError("ATTENDANCE_LOCATION_REQUIRED", "考勤抽查必须启用定位签到");
  const byRole = new Map((schemas || []).map((schema) => [schema.attendanceRole, schema]));
  if ((schemas || []).length !== 2 || !byRole.get("photo") || !byRole.get("work")) {
    throw attendanceError("ATTENDANCE_ITEMS_INVALID", "考勤抽查必须且只能配置“正面照”和“工作内容收集”两个任务项");
  }
  for (const schema of schemas) {
    if (schema.resultSheetTitle !== ATTENDANCE_RESULT_SHEET) throw attendanceError("ATTENDANCE_RESULT_SHEET_INVALID", `任务项“${schema.itemName}”必须写入13_考勤结果`);
    if (schema.resultRelationField !== "执行记录") throw attendanceError("ATTENDANCE_RESULT_RELATION_INVALID", "13_考勤结果必须按执行记录更新");
    if (schema.requiresApproval) throw attendanceError("ATTENDANCE_APPROVAL_DISABLED", "考勤抽查不需要人工审批");
  }
  const photo = fieldByLabel(byRole.get("photo").fields, ATTENDANCE_FIELDS.photo);
  if (!photo) throw attendanceError("ATTENDANCE_PHOTO_FIELD_MISSING", "正面照任务项缺少“正面照”字段");
  const work = byRole.get("work");
  for (const label of [ATTENDANCE_FIELDS.work, ATTENDANCE_FIELDS.customer, ATTENDANCE_FIELDS.place]) {
    if (!fieldByLabel(work.fields, label)) throw attendanceError("ATTENDANCE_WORK_FIELD_MISSING", `工作内容收集缺少“${label}”字段`);
  }
  return schemas;
}

function attendancePlaceValue(items, drafts) {
  const workItem = (items || []).find((item) => item.attendanceRole === "work" || item.schemaSnapshot?.attendanceRole === "work");
  const draft = (drafts || []).find((entry) => entry.itemId === workItem?.id);
  const placeField = (workItem?.schemaSnapshot?.fields || []).find((field) => field.label === ATTENDANCE_FIELDS.place);
  return String(draft?.values?.[placeField?.key] || "").trim();
}

function validateAttendanceEvidence(item, values, evidence) {
  const role = item?.attendanceRole || item?.schemaSnapshot?.attendanceRole;
  if (role !== "photo") return;
  const photoField = (item?.schemaSnapshot?.fields || []).find((field) => field.label === ATTENDANCE_FIELDS.photo);
  const photoValue = Array.isArray(values?.[photoField?.key]) ? values[photoField.key] : [];
  const proof = evidence?.[photoField?.key] || {};
  if (photoValue.length !== 1 || proof.originalFileIds?.length !== 1 || proof.watermarkedFileIds?.length !== 1 || photoValue[0] !== proof.watermarkedFileIds[0]) {
    throw attendanceError("ATTENDANCE_PHOTO_EVIDENCE_INVALID", "正面照必须同时保存原图和水印图，请重新拍摄");
  }
  if (!proof.capturedAt || !proof.address) throw attendanceError("ATTENDANCE_PHOTO_EVIDENCE_INVALID", "正面照水印信息不完整，请重新拍摄");
}

function followUpTaskId(taskId) {
  return `attendance_followup_${String(taskId || "").replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 240);
}

function buildAttendanceFollowUp(task, submittedAt) {
  const submittedMs = Date.parse(submittedAt);
  if (!Number.isFinite(submittedMs)) throw attendanceError("ATTENDANCE_SUBMITTED_AT_INVALID", "考勤提交时间无效");
  // Cloud functions may run in UTC. Calculate 23:59 explicitly in China
  // Standard Time so the business deadline never depends on host timezone.
  const chinaDate = new Date(submittedMs + 8 * 60 * 60 * 1000);
  const deadlineMs = Date.UTC(chinaDate.getUTCFullYear(), chinaDate.getUTCMonth(), chinaDate.getUTCDate(), 15, 59, 0, 0);
  return {
    ...task,
    id: followUpTaskId(task.id),
    _id: followUpTaskId(task.id),
    name: `${task.name}（在路上复查）`,
    startAt: new Date(submittedMs + 15 * 60 * 1000).toISOString(),
    deadlineAt: new Date(deadlineMs).toISOString(),
    status: "pending",
    progress: 0,
    completedItemCount: 0,
    submittedAt: "",
    completedAt: "",
    location: {},
    smartSheetExecutionRecordId: "",
    sourceAttendanceTaskId: task.id,
    attendanceGeneration: 1,
    autoGenerated: true,
    attendancePlace: "",
    attendanceAbnormal: false,
    attendanceFollowUpPending: false,
    attendanceFollowUpTaskId: "",
    reminderSentAt: "",
    startNoticeSentAt: "",
    extensionHistory: [],
    items: (task.items || []).map((item) => ({ ...item, status: "pending", smartSheetItemExecutionRecordId: "", itemExecutionKey: "" })),
    createdAt: submittedAt,
    updatedAt: submittedAt,
  };
}

module.exports = {
  ATTENDANCE_TASK_TYPE,
  ATTENDANCE_RESULT_SHEET,
  ATTENDANCE_ITEM_NAMES,
  ATTENDANCE_FIELDS,
  ATTENDANCE_PLACE_OPTIONS,
  decorateAttendanceSchema,
  validateAttendanceSchemas,
  attendancePlaceValue,
  validateAttendanceEvidence,
  followUpTaskId,
  buildAttendanceFollowUp,
};
