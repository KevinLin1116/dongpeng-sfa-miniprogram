const crypto = require("crypto");

const DEFAULT_ALLOWED_DISTANCE_METERS = 500;

function allowedDistanceMeters(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0
    ? normalized
    : DEFAULT_ALLOWED_DISTANCE_METERS;
}

function runtimeParameters(task = {}) {
  return {
    startAt: String(task.startAt || ""),
    deadlineAt: String(task.deadlineAt || ""),
    requiresLocation: task.requiresLocation === true,
    locationMode: task.locationMode === "record_only" ? "record_only" : "distance",
    allowedDistanceMeters: allowedDistanceMeters(task.allowedDistanceMeters),
    outOfRangePolicy: task.outOfRangePolicy === "block" ? "block" : "warn",
  };
}

function runtimeParametersFingerprint(instances = []) {
  const normalized = instances
    .map((instance) => ({
      id: String(instance.id || instance.targetKey || instance.storeRecordId || ""),
      ...runtimeParameters(instance),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function runtimeParametersChanged(current = {}, next = {}) {
  return JSON.stringify(runtimeParameters(current)) !== JSON.stringify(runtimeParameters(next));
}

function locationPolicyChanged(current = {}, next = {}) {
  const before = runtimeParameters(current);
  const after = runtimeParameters(next);
  return before.requiresLocation !== after.requiresLocation
    || before.locationMode !== after.locationMode
    || before.allowedDistanceMeters !== after.allowedDistanceMeters
    || before.outOfRangePolicy !== after.outOfRangePolicy;
}

function taskWindowAccess(task = {}, currentTime = Date.now()) {
  const startAt = Date.parse(task.startAt || "");
  const deadlineAt = Date.parse(task.deadlineAt || "");
  if (Number.isFinite(startAt) && currentTime < startAt) {
    return { allowed: false, code: "TASK_NOT_STARTED", message: "任务尚未到开始时间" };
  }
  if (Number.isFinite(deadlineAt) && currentTime > deadlineAt) {
    return { allowed: false, code: "TASK_EXPIRED", message: "任务已超过截止时间" };
  }
  return { allowed: true, code: "", message: "" };
}

function taskExecutionAccess(task = {}, currentTime = Date.now()) {
  const windowAccess = taskWindowAccess(task, currentTime);
  if (!windowAccess.allowed) return windowAccess;
  if (task.requiresLocation !== true) return windowAccess;
  if (!task.location?.checkedIn) {
    return { allowed: false, code: "LOCATION_REQUIRED", message: "请先完成任务签到" };
  }
  if (task.locationMode === "record_only") return windowAccess;
  const distance = Number(task.location.distanceMeters);
  const allowed = allowedDistanceMeters(task.allowedDistanceMeters);
  if (task.outOfRangePolicy === "block" && Number.isFinite(distance) && distance > allowed) {
    return {
      allowed: false,
      code: "LOCATION_OUT_OF_RANGE",
      message: `签到位置距离门店约 ${Math.round(distance)} 米，超过允许范围 ${allowed} 米，请重新签到`,
    };
  }
  return windowAccess;
}

module.exports = {
  DEFAULT_ALLOWED_DISTANCE_METERS,
  allowedDistanceMeters,
  runtimeParameters,
  runtimeParametersFingerprint,
  runtimeParametersChanged,
  locationPolicyChanged,
  taskWindowAccess,
  taskExecutionAccess,
};
