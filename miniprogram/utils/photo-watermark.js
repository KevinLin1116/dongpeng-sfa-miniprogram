function canvasNode(page) {
  return new Promise((resolve, reject) => {
    const query = typeof page.createSelectorQuery === "function" ? page.createSelectorQuery() : wx.createSelectorQuery().in(page);
    query.select("#attendanceWatermarkCanvas").fields({ node: true, size: true }).exec((result) => {
      const entry = result && result[0];
      if (!entry?.node) reject(new Error("水印画布初始化失败"));
      else resolve(entry.node);
    });
  });
}

function loadCanvasImage(canvas, src) {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("正面照读取失败"));
    image.src = src;
  });
}

function exportCanvas(canvas, width, height) {
  return new Promise((resolve, reject) => wx.canvasToTempFilePath({
    canvas,
    x: 0,
    y: 0,
    width,
    height,
    destWidth: width,
    destHeight: height,
    fileType: "jpg",
    quality: 0.9,
    success: (result) => resolve(result.tempFilePath),
    fail: () => reject(new Error("水印照片生成失败")),
  }));
}

async function createAttendanceWatermark(page, localPath, { employeeName, capturedAt, address }) {
  const canvas = await canvasNode(page);
  const image = await loadCanvasImage(canvas, localPath);
  const width = Math.max(1, Number(image.width || 1080));
  const height = Math.max(1, Number(image.height || 1440));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  const fontSize = Math.max(24, Math.round(width * 0.032));
  const padding = Math.round(fontSize * 0.8);
  const lineHeight = Math.round(fontSize * 1.45);
  const lines = [employeeName || "业务员", capturedAt || "", address || "地址解析失败"].filter(Boolean);
  const panelHeight = padding * 2 + lineHeight * lines.length;
  context.fillStyle = "rgba(0,0,0,0.58)";
  context.fillRect(0, height - panelHeight, width, panelHeight);
  context.fillStyle = "#ffffff";
  context.font = `${fontSize}px sans-serif`;
  context.textBaseline = "top";
  lines.forEach((line, index) => context.fillText(String(line).slice(0, 80), padding, height - panelHeight + padding + lineHeight * index, width - padding * 2));
  return exportCanvas(canvas, width, height);
}

module.exports = { createAttendanceWatermark };
