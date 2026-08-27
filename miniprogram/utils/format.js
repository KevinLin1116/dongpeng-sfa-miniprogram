const STATUS = {
  pending: { label: "待执行", className: "pending" },
  active: { label: "执行中", className: "active" },
  rectify: { label: "待整改", className: "rectify" },
  review: { label: "待复核", className: "review" },
  completed: { label: "已完成", className: "completed" },
};

function statusMeta(status) { return STATUS[status] || STATUS.pending; }
function dateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function timeRange(start, end) { return `${dateTime(start)} — ${dateTime(end)}`; }

module.exports = { statusMeta, dateTime, timeRange };
