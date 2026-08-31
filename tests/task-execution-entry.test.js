const assert = require("assert");
const path = require("path");
const fs = require("fs");

let page;
const modals = [];
const navigations = [];

global.Page = (definition) => { page = definition; };
global.wx = {
  showModal(options) { modals.push(options); },
  showToast() {},
  navigateTo(options) { navigations.push(options); },
};

require(path.resolve(__dirname, "../miniprogram/pages/task-execution/index.js"));

const source = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/task-execution/index.js"), "utf8");
assert.doesNotMatch(source, /onLoad\(query\)[\s\S]{0,160}checkIn\(true\)/, "进入考勤任务页不能自动签到");
assert.match(source, /await this\.load\(true\);[\s\S]{0,220}\["ATTENDANCE_CHECK", "DAILY_ATTENDANCE"\]\.includes\(task\.taskType\)[\s\S]{0,120}openFirstIncompleteAttendanceItem/, "考勤签到成功后必须自动进入第一个任务项");

function context(task) {
  const pageContext = {
    data: { task },
    taskId: "task-1",
  };
  pageContext.navigateToItem = (currentTask, currentItem) => page.navigateToItem.call(pageContext, currentTask, currentItem);
  return pageContext;
}

const item = { id: "item-1", renderer: "sampling", editable: true };

page.openItem.call(context({ readOnly: false, requiresLocation: true, location: {}, items: [item] }), { currentTarget: { dataset: { id: "item-1" } } });
assert.strictEqual(navigations.length, 0, "需要定位但未签到时不能进入任务项");
assert.strictEqual(modals.length, 1);
assert.match(modals[0].content, /签到成功后才能进入并执行任务项/);

page.openItem.call(context({ readOnly: false, requiresLocation: true, location: { checkedIn: true }, items: [item] }), { currentTarget: { dataset: { id: "item-1" } } });
assert.strictEqual(navigations.length, 1, "签到成功后应允许进入任务项");

page.openItem.call(context({ readOnly: false, requiresLocation: false, location: {}, items: [item] }), { currentTarget: { dataset: { id: "item-1" } } });
assert.strictEqual(navigations.length, 2, "无需定位的任务应直接允许执行");

page.openItem.call(context({ readOnly: true, requiresLocation: true, location: {}, items: [{ ...item, editable: false }] }), { currentTarget: { dataset: { id: "item-1" } } });
assert.strictEqual(navigations.length, 3, "已完成任务仍应允许只读查看详情");

process.stdout.write("task execution entry tests passed\n");
