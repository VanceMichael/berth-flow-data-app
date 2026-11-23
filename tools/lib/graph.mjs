// 步行段图：可走路径按轮椅标志区分。用于相容路径枚举与停用后的重走计算。
export function buildGraph(walkways) {
  const adjacency = new Map();
  for (const edge of walkways) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge);
  }
  return {
    edges: walkways,
    outgoing(zone) {
      return adjacency.get(zone) ?? [];
    },
    zones: [...new Set(walkways.flatMap(edge => [edge.from, edge.to]))],
  };
}

// 两点间最短步行分钟数；wheelchair=true 时只走轮椅可行段。不可达返回 null。
export function shortestWalk(graph, from, to, { wheelchair = false } = {}) {
  if (from === to) return 0;
  const best = new Map([[from, 0]]);
  const queue = [from];
  while (queue.length > 0) {
    const zone = queue.shift();
    for (const edge of graph.outgoing(zone)) {
      if (wheelchair && !edge.wheelchair) continue;
      const total = best.get(zone) + edge.minutes;
      if (total < (best.get(edge.to) ?? Infinity)) {
        best.set(edge.to, total);
        queue.push(edge.to);
      }
    }
  }
  return best.get(to) ?? null;
}

// 枚举 from→to 的全部简单路径（不重复经过区域），按轮椅标志过滤。
export function allPaths(graph, from, to, { wheelchair = false, maxDepth = 8 } = {}) {
  const found = [];
  const walk = (zone, visited, zones, minutes) => {
    if (zone === to) {
      found.push({ zones: [...zones], minutes });
      return;
    }
    if (zones.length >= maxDepth) return;
    for (const edge of graph.outgoing(zone)) {
      if (wheelchair && !edge.wheelchair) continue;
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      zones.push(edge.to);
      walk(edge.to, visited, zones, minutes + edge.minutes);
      zones.pop();
      visited.delete(edge.to);
    }
  };
  walk(from, new Set([from]), [from], 0);
  return found;
}

// 观测序列（按时间排序的 [{zone, time}]）与图路径是否相容：
// 观测到的区域须按序出现在路径上，且相邻观测的时间差不小于路径上的步行分钟数。
export function pathMatchesObservations(path, cumulative, observed) {
  let position = 0;
  let previousTime = null;
  let previousCum = null;
  for (const obs of observed) {
    let next = -1;
    for (let i = position; i < path.zones.length; i += 1) {
      if (path.zones[i] === obs.zone) { next = i; break; }
    }
    if (next === -1) return false;
    const cum = cumulative[next];
    if (obs.time !== null && previousTime !== null && obs.time - previousTime < cum - previousCum) {
      return false;
    }
    if (obs.time !== null) {
      previousTime = obs.time;
      previousCum = cum;
    }
    position = next;
  }
  return true;
}

// 给定一名旅客的观测区域序列，列出 hall→meet 的所有相容路径（可能多条，也可能没有）。
export function compatiblePaths(graph, observed, { wheelchair = false, from = 'hall', to = 'meet' } = {}) {
  const candidates = allPaths(graph, from, to, { wheelchair });
  const usable = observed.length > 0 && observed[0].zone === from ? observed : [{ zone: from, time: null }, ...observed];
  const timed = usable.filter(obs => obs.time !== null);
  return candidates.filter(path => {
    const cumulative = [];
    let sum = 0;
    for (let i = 0; i < path.zones.length; i += 1) {
      cumulative.push(sum);
      if (i + 1 < path.zones.length) {
        const edge = graph.outgoing(path.zones[i]).find(e => e.to === path.zones[i + 1]);
        sum += edge.minutes;
      }
    }
    return pathMatchesObservations(path, cumulative, timed);
  });
}
