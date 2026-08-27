const STATUS_ORDER = Object.freeze({
  pending: 0,
  active: 1,
  rectify: 2,
  review: 3,
  completed: 4,
});

function directionFactor(direction) {
  return direction === "desc" ? -1 : 1;
}

function compareKnownValues(left, right, direction) {
  const leftValid = Number.isFinite(left);
  const rightValid = Number.isFinite(right);
  if (!leftValid && !rightValid) return 0;
  if (!leftValid) return 1;
  if (!rightValid) return -1;
  return (left - right) * directionFactor(direction);
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function compareStatus(left, right, direction) {
  return compareKnownValues(STATUS_ORDER[left.status], STATUS_ORDER[right.status], direction);
}

function sortTasks(tasks, field = "status", direction = "asc") {
  return tasks.map((task, index) => ({ task, index })).sort((leftEntry, rightEntry) => {
    const left = leftEntry.task;
    const right = rightEntry.task;
    let compared = 0;
    if (field === "startAt") compared = compareKnownValues(timestamp(left.startAt), timestamp(right.startAt), direction);
    else if (field === "deadlineAt") compared = compareKnownValues(timestamp(left.deadlineAt), timestamp(right.deadlineAt), direction);
    else {
      compared = compareStatus(left, right, direction);
      if (!compared) compared = compareKnownValues(timestamp(left.deadlineAt), timestamp(right.deadlineAt), direction);
    }
    return compared || leftEntry.index - rightEntry.index;
  }).map((entry) => entry.task);
}

module.exports = { STATUS_ORDER, sortTasks };
