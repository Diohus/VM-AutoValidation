// Node-only helpers (keeps engine.js / model.js free of I/O).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Load every committed model JSON. Missing directory → no models (the engine then runs rules only). */
export function loadModels(dir) {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => { const m = JSON.parse(readFileSync(dir + '/' + f, 'utf8')); return [m.key ?? f.replace('.json', ''), m]; }));
}

/**
 * Fingerprint of what produces a decision (models + rulesets + catalog). The evaluation report stores it; the server
 * recomputes it at startup so the "Đánh giá mô hình" tab can say when the report no longer matches what is running.
 */
export function stackFingerprint(models, rulesets, catalog) {
  const h = createHash('sha256');
  for (const k of Object.keys(models).sort()) h.update(k).update(JSON.stringify(models[k]));
  for (const k of Object.keys(rulesets).sort()) h.update(k).update(JSON.stringify(rulesets[k]));
  h.update(JSON.stringify(catalog));
  return h.digest('hex').slice(0, 16);
}
