const assert = require("assert");
const fs = require("fs");
const path = require("path");

const script = fs.readFileSync(path.resolve(__dirname, "../../../miniprogram/pages/dynamic-form/index.js"), "utf8");

assert.match(script, /saveItemDraft[\s\S]*preSyncImages: true/, "通用任务项自动保存必须预同步图片");
assert.match(script, /completeTaskItem[\s\S]*silent: true/, "任务项完成应保留显式进度反馈");
process.stdout.write("dynamic form page contract tests passed\n");
