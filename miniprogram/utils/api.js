const FUNCTION_NAME = "sfa-api";
const SESSION_STORAGE_KEY = "sfa_session_token_v2";
let redirectingToLogin = false;

function readSessionToken() {
  return typeof wx !== "undefined" && typeof wx.getStorageSync === "function"
    ? wx.getStorageSync(SESSION_STORAGE_KEY) || ""
    : "";
}

function redirectToLogin(error) {
  if (!["ACCOUNT_NOT_BOUND", "SESSION_REQUIRED", "SESSION_EXPIRED", "ACCOUNT_DISABLED"].includes(error?.code) || redirectingToLogin) return;
  clearSession();
  const current = (typeof getCurrentPages === "function" ? getCurrentPages() : []).pop();
  if (current?.route === "pages/login/index") return;
  redirectingToLogin = true;
  wx.reLaunch({ url: "/pages/login/index", complete: () => { redirectingToLogin = false; } });
}

async function call(action, data = {}, options = {}) {
  try {
    const response = await wx.cloud.callFunction({ name: FUNCTION_NAME, data: { action, authVersion: 2, sessionToken: readSessionToken(), ...data } });
    const result = response.result || {};
    if (!result.ok) throw Object.assign(new Error(result.message || "服务暂时不可用"), { code: result.code, details: result.details });
    return result.data;
  } catch (error) {
    redirectToLogin(error);
    if (!options.silent) wx.showToast({ title: error.message || "请求失败", icon: "none" });
    throw error;
  }
}

function saveSession(token) { if (typeof wx.setStorageSync === "function") wx.setStorageSync(SESSION_STORAGE_KEY, token); }
function clearSession() { if (typeof wx.removeStorageSync === "function") wx.removeStorageSync(SESSION_STORAGE_KEY); }
function hasSession() { return Boolean(readSessionToken()); }

function compressImage(localPath, quality = 85) {
  if (typeof wx.compressImage !== "function") return Promise.resolve(localPath);
  return new Promise((resolve) => {
    wx.compressImage({
      src: localPath,
      quality,
      success: (result) => resolve(result.tempFilePath || localPath),
      fail: () => resolve(localPath),
    });
  });
}

async function uploadImage(localPath, folder = "task-images", options = {}) {
  const preparedPath = options.compress === false ? localPath : await compressImage(localPath, Number(options.quality || 85));
  const extension = (preparedPath.match(/\.([a-zA-Z0-9]+)$/) || [])[1] || "jpg";
  const cloudPath = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
  return wx.cloud.uploadFile({ cloudPath, filePath: preparedPath }).then((result) => result.fileID);
}

module.exports = { call, compressImage, uploadImage, saveSession, clearSession, hasSession };
