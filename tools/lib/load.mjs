// 装载交接资料：复用 check-materials 的字段与引用校验，再把字符串列解析为业务类型。
// 可选的 replies.csv（旅客真实回复与改约）不在 format.json 清单内，存在则读取，缺失不视为错误。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseTable, checkLinks } from '../check-materials.mjs';
import { parseTime } from './time.mjs';

const EMPTY_AS_NULL = value => (value === '' || value === '-' ? null : value);

export async function loadMaterials(dir) {
  const format = JSON.parse(await readFile(path.join(dir, 'format.json'), 'utf8'));
  const raw = {};
  for (const [name, fields] of Object.entries(format.tables)) {
    raw[name] = parseTable(await readFile(path.join(dir, `${name}.csv`), 'utf8'), fields, name);
  }
  checkLinks(raw, format.links);

  const tables = {
    manifest: raw.manifest.map(row => ({
      visit: row.visit,
      person: row.person,
      group: row.group,
      window: parseTime(row.window),
      assistance: row.assistance,
      escort: EMPTY_AS_NULL(row.escort),
      meetBy: parseTime(row.meet_by),
      notifiedUntil: EMPTY_AS_NULL(row.notified_until) === null ? null : parseTime(row.notified_until),
    })),
    observations: raw.observations.map(row => ({
      event: row.event,
      visit: row.visit,
      person: row.person,
      zone: row.zone,
      kind: row.kind,
      time: parseTime(row.time),
      source: row.source,
    })),
    disruptions: raw.disruptions.map(row => ({
      visit: row.visit,
      zone: row.zone,
      first: parseTime(row.first),
      last: parseTime(row.last),
      kind: row.kind, // closed=禁止配置新服务；missing-gate=观察不全，二者不等价
    })),
    capacity: raw.capacity.map(row => ({
      option: row.option,
      from: parseTime(row.from),
      to: parseTime(row.to),
      normalCounters: Number(row.normal_counters),
      assistedCounters: Number(row.assisted_counters),
      helpers: Number(row.helpers),
      accessibleZones: row.accessible_zones.split('|').filter(Boolean),
    })),
    walkways: raw.walkways.map(row => ({
      from: row.from,
      to: row.to,
      minutes: Number(row.minutes),
      wheelchair: row.wheelchair === 'true',
    })),
    cutoff: raw['observation-cutoff'].map(row => ({
      visit: row.visit,
      lastKnown: parseTime(row.last_known),
    })),
    replies: [],
  };

  try {
    const content = await readFile(path.join(dir, 'replies.csv'), 'utf8');
    tables.replies = parseTable(content, ['visit', 'person', 'response', 'new_window'], 'replies').map(row => ({
      visit: row.visit,
      person: row.person,
      response: row.response,
      newWindow: EMPTY_AS_NULL(row.new_window) === null ? null : parseTime(row.new_window),
    }));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return tables;
}
