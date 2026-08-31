const { call } = require("../../utils/api");

const ROLES = ["业务员", "任务审核者", "管理员"];

Page({
  data: { mobile: "", wecomUserId: "", name: "", password: "", confirmPassword: "", showPassword: false, roles: ROLES, roleIndex: 0, submitting: false, savedAccount: null },
  onMobileInput(event) { this.setData({ mobile: event.detail.value.replace(/\D/g, "") }); },
  onUserIdInput(event) { this.setData({ wecomUserId: event.detail.value.trim() }); },
  onNameInput(event) { this.setData({ name: event.detail.value.trim() }); },
  onPasswordInput(event) { this.setData({ password: event.detail.value }); },
  onConfirmInput(event) { this.setData({ confirmPassword: event.detail.value }); },
  togglePassword() { this.setData({ showPassword: !this.data.showPassword }); },
  chooseRole(event) { this.setData({ roleIndex: Number(event.detail.value) || 0 }); },
  async save() {
    const { mobile, wecomUserId, name, password, confirmPassword, roles, roleIndex, submitting } = this.data;
    if (submitting) return;
    if (!mobile || !wecomUserId || !name || !password) { wx.showToast({ title: "请完整填写账号信息", icon: "none" }); return; }
    if (password !== confirmPassword) { wx.showToast({ title: "两次输入的密码不一致", icon: "none" }); return; }
    this.setData({ submitting: true });
    try {
      const account = await call("savePasswordAccount", { mobile, wecomUserId, name, password, role: roles[roleIndex] }, { silent: true });
      this.setData({ mobile: "", wecomUserId: "", name: "", password: "", confirmPassword: "", roleIndex: 0, savedAccount: account });
      wx.showToast({ title: account.created ? "账号已开通" : "密码已重置", icon: "success" });
    } catch (error) {
      wx.showModal({ title: "保存失败", content: error.message || "请稍后重试", showCancel: false });
    } finally { this.setData({ submitting: false }); }
  },
  goBack() { wx.navigateBack(); },
});
