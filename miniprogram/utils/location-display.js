function isLegacyDistanceAddress(value) {
  return /^距.+约\s*\d+\s*米$/.test(String(value || "").trim());
}

function locationDisplay(location = {}, storeName = "门店") {
  const checkedIn = Boolean(location.checkedIn);
  const rawAddress = String(location.address || "").trim();
  const addressText = rawAddress && !isLegacyDistanceAddress(rawAddress)
    ? rawAddress
    : checkedIn ? "详细地址暂未获取" : "点击签到获取当前位置";
  const distance = Number(location.distanceMeters);
  const distanceText = checkedIn && Number.isFinite(distance)
    ? `距${storeName || "门店"}约 ${Math.round(distance)} 米`
    : "";
  return { addressText, distanceText };
}

module.exports = { isLegacyDistanceAddress, locationDisplay };
