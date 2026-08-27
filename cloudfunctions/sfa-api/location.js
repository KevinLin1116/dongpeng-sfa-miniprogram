function toRadians(value) { return value * Math.PI / 180; }
function distanceMeters(lat1, lon1, lat2, lon2) { const earth = 6371000; const dLat = toRadians(lat2 - lat1); const dLon = toRadians(lon2 - lon1); const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2; return earth * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); }
module.exports = { distanceMeters };
