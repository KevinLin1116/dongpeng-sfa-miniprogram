const assert = require("assert");
const { sortTasks } = require("../miniprogram/utils/task-sort");

const tasks = [
  { id: "completed", status: "completed", startAt: "2026-08-01T09:00:00+08:00", deadlineAt: "2026-08-04T18:00:00+08:00" },
  { id: "active-later", status: "active", startAt: "2026-08-03T09:00:00+08:00", deadlineAt: "2026-08-07T18:00:00+08:00" },
  { id: "pending", status: "pending", startAt: "2026-08-04T09:00:00+08:00", deadlineAt: "2026-08-08T18:00:00+08:00" },
  { id: "review", status: "review", startAt: "2026-08-02T09:00:00+08:00", deadlineAt: "2026-08-06T18:00:00+08:00" },
  { id: "active-earlier", status: "active", startAt: "2026-08-05T09:00:00+08:00", deadlineAt: "2026-08-05T18:00:00+08:00" },
];

assert.deepStrictEqual(sortTasks(tasks).map((task) => task.id), ["pending", "active-earlier", "active-later", "review", "completed"]);
assert.deepStrictEqual(sortTasks(tasks, "startAt", "asc").map((task) => task.id), ["completed", "review", "active-later", "pending", "active-earlier"]);
assert.deepStrictEqual(sortTasks(tasks, "deadlineAt", "desc").map((task) => task.id), ["pending", "active-later", "review", "active-earlier", "completed"]);
assert.deepStrictEqual(sortTasks(tasks, "status", "desc").map((task) => task.id), ["completed", "review", "active-later", "active-earlier", "pending"]);

process.stdout.write("task sort tests passed\n");
