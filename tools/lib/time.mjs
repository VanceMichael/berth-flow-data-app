// 港口当地时间的 HH:MM 与分钟数互转。所有时钟均为船到港地时间，不跨日。
export function parseTime(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) throw new Error(`时间格式应为 HH:MM：${text}`);
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (Number(match[2]) >= 60) throw new Error(`时间分钟越界：${text}`);
  return minutes;
}

export function formatTime(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '未定';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 区间的人可读形式；上界缺失表示观察未闭合，不编造数字。
export function formatRange(lo, hi) {
  return `[${formatTime(lo)}, ${formatTime(hi)}]`;
}

export function formatMinutes(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '不可识别';
  return `${value} 分钟`;
}
