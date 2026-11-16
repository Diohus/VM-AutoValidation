// History index keyed by pseudonymous subject token. Only results measured strictly before
// the evaluated report are returned (no look-ahead).
export function buildHistoryIndex(reports) {
  const bySubject = new Map();
  for (const r of reports) {
    if (!bySubject.has(r.subjectToken)) bySubject.set(r.subjectToken, []);
    bySubject.get(r.subjectToken).push(r);
  }
  return bySubject;
}

export function historyFor(index, report, catalog) {
  const list = index.get(report.subjectToken) ?? [];
  const times = report.results.map(r => Date.parse(r.measuredAt)).filter(Number.isFinite);
  const t0 = times.length ? Math.max(...times) : Date.parse(report.specimen?.collectedAt);
  const out = [];
  for (const r of list) {
    if (r.reportId === report.reportId || r.discipline !== report.discipline) continue;
    for (const x of r.results) {
      if (x.status !== 'RESULTED' || typeof x.value !== 'number' || !x.measuredAt) continue;
      if (catalog && x.unit !== catalog.analytes[x.test]?.unit) continue; // only comparable units
      if (Date.parse(x.measuredAt) >= t0) continue;
      out.push({ test: x.test, value: x.value, unit: x.unit, measuredAt: x.measuredAt, reportId: r.reportId, instrument: x.instrument });
    }
  }
  return out.sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
}
