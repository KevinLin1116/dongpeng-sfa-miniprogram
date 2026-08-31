const assert = require("assert");
const fs = require("fs");
const path = require("path");

const script = fs.readFileSync(path.resolve(__dirname, "../../../miniprogram/pages/dynamic-form/index.js"), "utf8");

assert.match(script, /saveItemDraft[\s\S]*preSyncImages: true/, "通用任务项自动保存必须预同步图片");
assert.match(script, /completeTaskItem[\s\S]*silent: true/, "任务项完成应保留显式进度反馈");
assert.match(script, /field\.cameraOnly \? \["camera"\]/, "考勤正面照必须禁用相册入口");
assert.match(script, /createAttendanceWatermark/, "考勤照片必须生成水印图");
assert.match(script, /originalFileIds[\s\S]*watermarkedFileIds/, "考勤照片必须同时保留原图和水印图证据");
assert.match(script, /field\.watermark === "attendance"\) await this\.save\(\)/, "考勤正面照拍摄完成后必须自动提交该任务项");
assert.match(script, /提交并完成考勤[\s\S]*submitTask/, "工作内容保存后必须支持统一提交并完成考勤");
assert.match(script, /正在提交考勤[\s\S]*正在写入考勤结果和照片/, "考勤提交必须展示分阶段进度反馈");
process.stdout.write("dynamic form page contract tests passed\n");
