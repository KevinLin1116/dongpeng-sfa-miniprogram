const https = require("https");

const ENDPOINT = "https://apis.map.qq.com/ws/geocoder/v1/";

function requestJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { Accept: "application/json" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`腾讯位置服务请求失败（HTTP ${response.statusCode}）`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (_) { reject(new Error("腾讯位置服务返回了无法解析的数据")); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("腾讯位置服务请求超时")));
    request.on("error", reject);
  });
}

function addressFromResponse(payload = {}) {
  if (Number(payload.status) !== 0 || !payload.result) {
    throw new Error(payload.message || "腾讯位置服务逆地址解析失败");
  }
  const result = payload.result;
  return String(result.address || result.formatted_addresses?.recommend || "").trim();
}

function poiFromResponse(payload = {}) {
  const result = payload.result || {};
  const poi = Array.isArray(result.pois) ? result.pois.find((item) => String(item?.id || "").trim()) : undefined;
  if (!poi) return { poiId: "", poiTitle: "" };
  return { poiId: String(poi.id).trim(), poiTitle: String(poi.title || poi.address || "").trim() };
}

async function reverseGeocode(latitude, longitude, options = {}) {
  const key = String(options.key || process.env.SFA_TENCENT_MAP_KEY || "").trim();
  if (!key) return { address: "", resolved: false, reason: "MAP_KEY_MISSING" };
  const url = new URL(ENDPOINT);
  url.searchParams.set("location", `${latitude},${longitude}`);
  url.searchParams.set("key", key);
  // 智能表格定位单元格要求腾讯地图的地点 ID；逆地址解析时一并获取最近 POI。
  url.searchParams.set("get_poi", "1");
  const payload = await (options.requestJson || requestJson)(url);
  const address = addressFromResponse(payload);
  const components = payload.result?.address_component || {};
  const poi = poiFromResponse(payload);
  return { address, resolved: Boolean(address), reason: address ? "" : "ADDRESS_EMPTY", province: String(components.province || "").trim(), city: String(components.city || "").trim(), district: String(components.district || "").trim(), ...poi };
}

module.exports = { addressFromResponse, poiFromResponse, reverseGeocode };
