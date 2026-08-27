const assert = require("assert");
const { addressFromResponse, reverseGeocode } = require("../reverse-geocoder");

assert.strictEqual(addressFromResponse({
  status: 0,
  result: {
    address: "广东省佛山市禅城区季华西路",
    formatted_addresses: { recommend: "广东省佛山市禅城区季华西路绿岛湖附近" },
  },
}), "广东省佛山市禅城区季华西路");

assert.throws(() => addressFromResponse({ status: 311, message: "Key格式错误" }), /Key格式错误/);

(async () => {
  const missing = await reverseGeocode(23.01, 113.01, { key: "" });
  assert.deepStrictEqual(missing, { address: "", resolved: false, reason: "MAP_KEY_MISSING" });

  let requestedUrl = "";
  const result = await reverseGeocode(23.01, 113.01, {
    key: "test-key",
    requestJson: async (url) => {
      requestedUrl = String(url);
      return { status: 0, result: { address: "广东省佛山市禅城区测试路1号" } };
    },
  });
  assert.strictEqual(result.address, "广东省佛山市禅城区测试路1号");
  assert.match(requestedUrl, /location=23\.01%2C113\.01/);
  assert.match(requestedUrl, /key=test-key/);
  process.stdout.write("reverse geocoder tests passed\n");
})().catch((error) => { console.error(error); process.exitCode = 1; });
