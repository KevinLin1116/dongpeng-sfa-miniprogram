const { call, saveSession, clearSession, hasSession } = require("../../utils/api");

Page({
  data: { checking: true, submitting: false, systemError: "", setupMode: false, setupName: "", loginDescription: "请输入管理员为您开通的手机号和密码。", mobile: "", password: "", confirmPassword: "", showPassword: false },
  onShow() { this.checkSession(); },
  async checkSession() {
    this.setData({ checking: true, systemError: "" });
    try {
      if (hasSession()) {
        const data = await call("bootstrap", {}, { silent: true });
        getApp().globalData.profile = data.profile;
        wx.reLaunch({ url: "/pages/home/index" });
        return;
      }
      const status = await call("getPasswordSetupStatus", {}, { silent: true });
      const setupMode = status.eligible === true;
      const setupName = status.name || "";
      this.setData({ checking: false, setupMode, setupName, loginDescription: setupMode ? `已识别到人员“${setupName}”，请补充手机号并设置登录密码。` : "请输入管理员为您开通的手机号和密码。", mobile: status.mobile || "" });
    } catch (error) {
      clearSession();
      this.setData({ checking: false, systemError: error.message || "账号服务暂时不可用" });
    }
  },
  onMobileInput(event) { this.setData({ mobile: event.detail.value.replace(/\D/g, "") }); },
  onPasswordInput(event) { this.setData({ password: event.detail.value }); },
  onConfirmInput(event) { this.setData({ confirmPassword: event.detail.value }); },
  togglePassword() { this.setData({ showPassword: !this.data.showPassword }); },
  async submit() {
    const { mobile, password, confirmPassword, setupMode, submitting } = this.data;
    if (submitting) return;
    if (!mobile || !password) { wx.showToast({ title: "请填写手机号和密码", icon: "none" }); return; }
    if (setupMode && password !== confirmPassword) { wx.showToast({ title: "两次输入的密码不一致", icon: "none" }); return; }
    this.setData({ submitting: true });
    try {
      const data = await call(setupMode ? "setupInitialPassword" : "loginWithPassword", { mobile, password }, { silent: true });
      saveSession(data.sessionToken);
      getApp().globalData.profile = data.profile;
      wx.showToast({ title: setupMode ? "设置成功" : "登录成功", icon: "success" });
      setTimeout(() => wx.reLaunch({ url: "/pages/home/index" }), 350);
    } catch (error) {
      wx.showModal({ title: "登录失败", content: error.message || "请检查填写内容后重试", showCancel: false });
    } finally { this.setData({ submitting: false }); }
  },
});
