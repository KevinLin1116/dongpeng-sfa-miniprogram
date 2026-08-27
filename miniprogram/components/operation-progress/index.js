Component({
  properties: {
    visible: { type: Boolean, value: false },
    status: { type: String, value: "processing" },
    title: { type: String, value: "正在处理" },
    message: { type: String, value: "请稍候" },
    hint: { type: String, value: "" },
    elapsedText: { type: String, value: "" },
    stageText: { type: String, value: "" },
  },
  methods: { noop() {} },
});
