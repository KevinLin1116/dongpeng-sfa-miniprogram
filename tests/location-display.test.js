const assert = require("assert");
const { locationDisplay } = require("../miniprogram/utils/location-display");

assert.deepStrictEqual(locationDisplay({}, "绿岛湖店"), {
  addressText: "点击签到获取当前位置",
  distanceText: "",
});

assert.deepStrictEqual(locationDisplay({ checkedIn: true, address: "广东省佛山市禅城区季华西路", distanceMeters: 19.4 }, "绿岛湖店"), {
  addressText: "广东省佛山市禅城区季华西路",
  distanceText: "距绿岛湖店约 19 米",
});

assert.deepStrictEqual(locationDisplay({ checkedIn: true, address: "距绿岛湖店约 19 米", distanceMeters: 19 }, "绿岛湖店"), {
  addressText: "详细地址暂未获取",
  distanceText: "距绿岛湖店约 19 米",
});

process.stdout.write("location display tests passed\n");
