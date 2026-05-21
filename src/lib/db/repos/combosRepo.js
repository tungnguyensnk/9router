import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function normalizeAccountFilters(raw, models = []) {
  if (Array.isArray(raw)) {
    return Object.fromEntries(models.map((model) => [model, raw]));
  }
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(
    Object.entries(raw).map(([model, accounts]) => [model, Array.isArray(accounts) ? accounts : []])
  );
}

function rowToCombo(row) {
  if (!row) return null;
  const models = parseJson(row.models, []);
  const accountFilters = normalizeAccountFilters(parseJson(row.accounts, {}), models);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models,
    accountFilters,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCombos() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos ORDER BY createdAt ASC`);
  return rows.map(rowToCombo);
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByName(name) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
  return rowToCombo(row);
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    accountFilters: normalizeAccountFilters(data.accountFilters, data.models || []),
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO combos(id, name, kind, models, accounts, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [combo.id, combo.name, combo.kind, stringifyJson(combo.models), stringifyJson(combo.accountFilters), combo.createdAt, combo.updatedAt]
  );
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
    merged.accountFilters = normalizeAccountFilters(merged.accountFilters, merged.models || []);
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, accounts = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), stringifyJson(merged.accountFilters || {}), merged.updatedAt, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM combos WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}
