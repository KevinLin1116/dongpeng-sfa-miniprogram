const assert = require("assert");
const { cloneEmptyOperationProgress, startOperationFeedback } = require("../miniprogram/utils/operation-feedback");

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  const page = {
    data: { operationProgress: cloneEmptyOperationProgress() },
    setData(patch) { Object.assign(this.data, patch); },
  };
  const feedback = startOperationFeedback(page, {
    title: "正在提交任务",
    stages: [
      { after: 0, message: "正在校验" },
      { after: 10, message: "正在同步" },
    ],
  });
  assert.strictEqual(page.data.operationProgress.visible, true);
  assert.strictEqual(page.data.operationProgress.message, "正在校验");
  assert.strictEqual(page.data.operationProgress.stageText, "1/2");
  await delay(20);
  assert.strictEqual(page.data.operationProgress.message, "正在同步");
  assert.strictEqual(page.data.operationProgress.stageText, "2/2");
  await feedback.succeed("提交完成");
  assert.strictEqual(page.data.operationProgress.visible, false);
  console.log("operation feedback tests passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
