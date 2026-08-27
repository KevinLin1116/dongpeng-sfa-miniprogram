# 鹏程 SFA 微信小程序

鹏程 SFA 是面向终端业务执行、任务审批和结果分析的微信小程序。当前首稿以微信云开发为运行底座，通过 CloudBase 云函数连接企业微信智能表格，实现任务配置、门店执行、定位签到、动态表单、产品上样和逐产品审批的业务闭环。

## 核心能力

- 任务发布后按执行门店和执行人生成任务清单
- 业务员仅查看和执行本人任务，管理员可查看全量数据
- 任务时间、定位要求和定位范围从任务发布配置实时生效
- 门店签到、距离校验和腾讯位置服务逆地址解析
- 基于智能表格字段配置动态生成任务表单
- 现场照片先上传云存储，再同步到企业微信智能表格
- 产品上样按一级/二级规则分组执行并校验达标情况
- 审核人按产品逐项判定合格或退回，支持整改后重新提交
- 幂等、防重复提交、运行日志和图片缓存

## 技术架构

```text
微信小程序
  -> 微信云开发 / CloudBase 云函数 sfa-api
  -> 固定出口代理
  -> 企业微信智能表格

CloudBase 文档数据库：账号绑定、任务实例、草稿、幂等、审批、定位和运行日志
CloudBase 云存储：现场照片、产品上样照片及附件
```

## 目录结构

```text
miniprogram/                         小程序客户端
  pages/                             首页、任务、执行、动态表单、产品上样、审批等页面
  utils/                             API、排序、定位展示和操作反馈工具
cloudfunctions/
  sfa-api/                           正式业务云函数
  sfa-readonly-diagnostic/           只读诊断云函数
tests/                               小程序页面与工具函数回归测试
project.config.json                  微信开发者工具项目配置
```

## 本地开发

1. 使用微信开发者工具导入本目录。
2. 确认 `project.config.json` 中的 AppID 与目标小程序一致。
3. 在 CloudBase 控制台为 `sfa-api` 配置服务端环境变量：
   - `SFA_WECOM_CORP_ID`
   - `SFA_WECOM_SECRET`
   - `SFA_SMART_SHEET_DOC_ID`
   - `SFA_PROXY_URL`
   - `SFA_PROXY_SECRET`
   - `SFA_CALLBACK_BRIDGE_SECRET`
   - `SFA_TENCENT_MAP_KEY`
4. 部署 `cloudfunctions/sfa-api`，入口为 `index.main`。
5. 在微信开发者工具中编译并使用体验版进行真机测试。

所有 Secret 仅允许配置在云函数运行环境中，禁止写入小程序前端、仓库或提交记录。

## 测试

云函数完整回归测试：

```bash
cd cloudfunctions/sfa-api
npm install
npm test
```

小程序端回归测试：

```bash
node tests/task-sort.test.js
node tests/location-display.test.js
node tests/operation-feedback.test.js
node tests/sampling-page.test.js
node tests/approval-detail-page.test.js
node tests/task-execution-entry.test.js
```

## 当前首稿状态

- `sfa-api` 已部署为 CloudBase Event Function
- 小程序任务执行、物料打卡、产品上样和逐产品审批代码已完成
- 自动化测试已覆盖关键业务规则、状态流转、幂等和异常恢复
- 正式发布前仍需在目标企业微信环境完成全链路真机验收和权限复核

## 安全说明

- 仓库不包含企业微信 Secret、代理 Secret、回调 Secret 或私钥
- `project.private.config.json`、预览二维码、上传记录和依赖目录均已忽略
- 真实业务数据仅保存在企业微信智能表格、CloudBase 数据库和云存储中
