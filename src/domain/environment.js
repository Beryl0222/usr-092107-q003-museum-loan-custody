import { toInstant } from "../store/eventStore.js";

// 同一（传感器, 指标, 时刻）的读数视为重复：断网补报与时区差异不产生第二条。
export function readingKey(sensorId, reading) {
  return `${sensorId}|${reading.metric}|${toInstant(reading.measured_at)}`;
}

function breachAmount(value, rule) {
  if (rule.max !== undefined && value > rule.max) return value - rule.max;
  if (rule.min !== undefined && value < rule.min) return rule.min - value;
  return 0;
}

/**
 * 超阈值窗口检测（纯函数）：同一指标的连续越界读数构成一个窗口，
 * 正常读数闭合窗口。对完整时间线重复计算是确定性的——
 * 补报只可能延伸或合并窗口，窗口键（起始时刻）保持稳定。
 */
export function detectExcursions(sensorId, readings, rulesByMetric) {
  const byMetric = new Map();
  for (const r of readings) {
    const list = byMetric.get(r.metric) ?? [];
    list.push({ ...r, instant: toInstant(r.measured_at) });
    byMetric.set(r.metric, list);
  }

  const excursions = [];
  for (const [metric, series] of byMetric) {
    const rule = rulesByMetric[metric];
    if (!rule) continue;
    series.sort((a, b) => a.instant.localeCompare(b.instant));

    let open = null;
    const close = () => {
      if (open) excursions.push(open);
      open = null;
    };
    for (const reading of series) {
      const amount = breachAmount(reading.value, rule);
      if (amount > 0) {
        if (!open) {
          open = {
            key: `${sensorId}:${metric}:${reading.instant}`,
            sensor_id: sensorId,
            metric,
            window: { start: reading.instant, end: reading.instant },
            extreme: { value: reading.value, unit: reading.unit },
            threshold: { min: rule.min, max: rule.max },
            reading_count: 0,
            _worst: -1,
          };
        }
        open.window.end = reading.instant;
        open.reading_count += 1;
        if (amount > open._worst) {
          open._worst = amount;
          open.extreme = { value: reading.value, unit: reading.unit };
        }
      } else {
        close();
      }
    }
    close();
  }
  return excursions.map(({ _worst, ...rest }) => rest);
}
