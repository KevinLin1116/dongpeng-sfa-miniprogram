const assert = require("assert");
const {
  runtimeParametersFingerprint,
  runtimeParametersChanged,
  locationPolicyChanged,
  taskWindowAccess,
  taskExecutionAccess,
} = require("../task-runtime-policy");

const base = {
  id: "task-1",
  startAt: "2026-08-20T01:00:00.000Z",
  deadlineAt: "2026-08-20T10:00:00.000Z",
  requiresLocation: true,
  allowedDistanceMeters: 500,
  outOfRangePolicy: "block",
};

assert.strictEqual(runtimeParametersFingerprint([base]), runtimeParametersFingerprint([{ ...base, name: "系统回写不影响版本" }]));
assert.notStrictEqual(runtimeParametersFingerprint([base]), runtimeParametersFingerprint([{ ...base, deadlineAt: "2026-08-20T11:00:00.000Z" }]));
assert.strictEqual(runtimeParametersChanged(base, { ...base }), false);
assert.strictEqual(runtimeParametersChanged(base, { ...base, allowedDistanceMeters: 300 }), true);
assert.strictEqual(locationPolicyChanged(base, { ...base, deadlineAt: "2026-08-20T11:00:00.000Z" }), false);
assert.strictEqual(locationPolicyChanged(base, { ...base, requiresLocation: false }), true);

assert.deepStrictEqual(taskWindowAccess(base, Date.parse("2026-08-20T00:59:59.000Z")), {
  allowed: false,
  code: "TASK_NOT_STARTED",
  message: "任务尚未到开始时间",
});
assert.deepStrictEqual(taskWindowAccess(base, Date.parse("2026-08-20T10:00:01.000Z")), {
  allowed: false,
  code: "TASK_EXPIRED",
  message: "任务已超过截止时间",
});
assert.strictEqual(taskExecutionAccess(base, Date.parse("2026-08-20T02:00:00.000Z")).code, "LOCATION_REQUIRED");
assert.strictEqual(taskExecutionAccess({ ...base, location: { checkedIn: true, distanceMeters: 600 } }, Date.parse("2026-08-20T02:00:00.000Z")).code, "LOCATION_OUT_OF_RANGE");
assert.strictEqual(taskExecutionAccess({ ...base, location: { checkedIn: true, distanceMeters: 120 } }, Date.parse("2026-08-20T02:00:00.000Z")).allowed, true);
assert.strictEqual(taskExecutionAccess({ ...base, requiresLocation: false }, Date.parse("2026-08-20T02:00:00.000Z")).allowed, true);

process.stdout.write("task runtime policy tests passed\n");
