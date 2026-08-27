const EMPTY_OPERATION_PROGRESS = Object.freeze({
  visible: false,
  status: "processing",
  title: "",
  message: "",
  hint: "",
  elapsedText: "",
});

function cloneEmptyOperationProgress() {
  return { ...EMPTY_OPERATION_PROGRESS };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startOperationFeedback(page, options = {}) {
  const stages = Array.isArray(options.stages) && options.stages.length
    ? options.stages
    : [{ after: 0, message: "正在处理，请稍候" }];
  const startedAt = Date.now();
  const timers = [];
  let disposed = false;
  let stageIndex = 0;

  function update(patch) {
    if (disposed || !page || typeof page.setData !== "function") return;
    page.setData({ operationProgress: { ...(page.data.operationProgress || cloneEmptyOperationProgress()), ...patch } });
  }

  function showStage(index) {
    stageIndex = index;
    const stage = stages[index] || stages[stages.length - 1];
    update({
      visible: true,
      status: "processing",
      title: stage.title || options.title || "正在处理",
      message: stage.message || "正在处理，请稍候",
      hint: stage.hint || options.hint || "请勿重复操作或退出当前页面",
      stageText: `${index + 1}/${stages.length}`,
    });
  }

  showStage(0);
  stages.slice(1).forEach((stage, index) => {
    timers.push(setTimeout(() => showStage(index + 1), Math.max(0, Number(stage.after) || 0)));
  });
  const elapsedTimer = setInterval(() => {
    const seconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    update({ elapsedText: `已处理 ${seconds} 秒` });
  }, 1000);

  function clearTimers() {
    timers.forEach(clearTimeout);
    clearInterval(elapsedTimer);
  }

  return {
    async succeed(message) {
      clearTimers();
      update({ visible: true, status: "success", title: "处理完成", message: message || "操作已完成", hint: "", stageText: "" });
      await wait(520);
      disposed = true;
      if (page && typeof page.setData === "function") page.setData({ operationProgress: cloneEmptyOperationProgress() });
    },
    fail() {
      clearTimers();
      disposed = true;
      if (page && typeof page.setData === "function") page.setData({ operationProgress: cloneEmptyOperationProgress() });
    },
    dispose() {
      clearTimers();
      disposed = true;
    },
    getStageIndex() { return stageIndex; },
  };
}

module.exports = { EMPTY_OPERATION_PROGRESS, cloneEmptyOperationProgress, startOperationFeedback };
