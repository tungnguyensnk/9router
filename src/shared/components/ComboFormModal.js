"use client";

import { useState, useEffect } from "react";
import Modal from "./Modal";
import Input from "./Input";
import Button from "./Button";
import ModelSelectModal from "./ModelSelectModal";
import { getProviderAlias } from "@/shared/constants/providers";

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

function getModelConnectionCandidates(model, connections) {
  if (!model || !model.includes("/")) return [];
  const modelPrefix = model.split("/")[0];
  return connections.filter((conn) => {
    if (conn.isActive === false) return false;
    const providerAlias = getProviderAlias(conn.provider);
    const providerPrefix = conn.providerSpecificData?.prefix;
    return modelPrefix === conn.provider || modelPrefix === providerAlias || modelPrefix === providerPrefix;
  });
}

// Inline editable model item
function ModelItem({ index, model, isFirst, isLast, onEdit, onMoveUp, onMoveDown, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(model);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== model) onEdit(trimmed);
    else setDraft(model);
    setEditing(false);
  };
  const handleKeyDown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { setDraft(model); setEditing(false); }
  };
  return (
    <div className="group flex min-w-0 items-center gap-1.5 rounded-md bg-black/[0.02] px-2 py-1 transition-colors hover:bg-black/[0.04] dark:bg-white/[0.02] dark:hover:bg-white/[0.04]">
      <span className="text-[10px] font-medium text-text-muted w-3 text-center shrink-0">{index + 1}</span>
      {editing ? (
        <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 rounded border border-primary/40 bg-white px-1.5 py-0.5 font-mono text-xs text-text-main outline-none dark:bg-black/20" />
      ) : (
        <div className="min-w-0 flex-1 cursor-text truncate rounded px-1.5 py-0.5 font-mono text-xs text-text-main hover:bg-black/5 dark:hover:bg-white/5"
          onClick={() => setEditing(true)} title="Click to edit">{model}</div>
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        <button onClick={onMoveUp} disabled={isFirst}
          className={`p-0.5 rounded ${isFirst ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`} title="Move up">
          <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
        </button>
        <button onClick={onMoveDown} disabled={isLast}
          className={`p-0.5 rounded ${isLast ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`} title="Move down">
          <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
        </button>
      </div>
      <button onClick={onRemove} className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 transition-all" title="Remove">
        <span className="material-symbols-outlined text-[12px]">close</span>
      </button>
    </div>
  );
}

// Reusable Combo create/edit modal. forcePrefix auto-prepends to name.
export default function ComboFormModal({ isOpen, combo, onClose, onSave, activeProviders, kindFilter = null, forcePrefix = "", title }) {
  // Strip prefix when editing existing combo so user only edits suffix
  const initialName = combo?.name
    ? (forcePrefix && combo.name.startsWith(forcePrefix) ? combo.name.slice(forcePrefix.length) : combo.name)
    : "";
  const [name, setName] = useState(initialName);
  const [models, setModels] = useState(combo?.models || []);
  const [accountFilters, setAccountFilters] = useState(combo?.accountFilters || {});
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [modelAliases, setModelAliases] = useState({});

  useEffect(() => {
    if (!isOpen) return;
    fetch("/api/models/alias").then((r) => r.ok ? r.json() : null).then((d) => d && setModelAliases(d.aliases || {})).catch(() => {});
  }, [isOpen]);

  const validateName = (value) => {
    if (!value.trim()) { setNameError("Name is required"); return false; }
    const full = forcePrefix + value;
    if (!VALID_NAME_REGEX.test(full)) { setNameError("Only letters, numbers, -, _ and . allowed"); return false; }
    setNameError("");
    return true;
  };

  const handleNameChange = (e) => {
    let value = e.target.value;
    // If user types prefix manually, strip it (we always prepend)
    if (forcePrefix && value.startsWith(forcePrefix)) value = value.slice(forcePrefix.length);
    setName(value);
    if (value) validateName(value); else setNameError("");
  };

  const handleAddModel = (model) => {
    if (!models.includes(model.value)) {
      setModels([...models, model.value]);
    }
  };
  const handleDeselectModel = (model) => {
    setModels(models.filter((m) => m !== model.value));
    setAccountFilters((prev) => {
      const next = { ...prev };
      delete next[model.value];
      return next;
    });
  };
  const handleRemoveModel = (i) => {
    const removedModel = models[i];
    setModels(models.filter((_, idx) => idx !== i));
    setAccountFilters((prev) => {
      const next = { ...prev };
      delete next[removedModel];
      return next;
    });
  };
  const handleMoveUp = (i) => {
    if (i === 0) return;
    const a = [...models]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; setModels(a);
  };
  const handleMoveDown = (i) => {
    if (i === models.length - 1) return;
    const a = [...models]; [a[i], a[i + 1]] = [a[i + 1], a[i]]; setModels(a);
  };

  const handleSave = async () => {
    if (!validateName(name)) return;
    setSaving(true);
    await onSave({
      name: forcePrefix + name.trim(),
      models,
      accountFilters: Object.fromEntries(
        models
          .filter((model) => Array.isArray(accountFilters[model]) && accountFilters[model].length > 0)
          .map((model) => [model, accountFilters[model]])
      )
    });
    setSaving(false);
  };

  const isEdit = !!combo;

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title={title || (isEdit ? "Edit Combo" : "Create Combo")}>
        <div className="flex flex-col gap-3">
          <div>
            {forcePrefix ? (
              <>
                <label className="text-sm font-medium mb-1 block">Combo Name</label>
                <div className="flex items-stretch">
                  <span className="inline-flex items-center px-2 rounded-l border border-r-0 border-black/10 dark:border-white/10 bg-black/[0.04] dark:bg-white/[0.04] text-text-muted font-mono text-sm">{forcePrefix}</span>
                  <input value={name} onChange={handleNameChange} placeholder="my-combo"
                    className="flex-1 min-w-0 rounded-r border border-black/10 dark:border-white/10 bg-white dark:bg-black/20 px-2 py-1.5 font-mono text-sm outline-none focus:border-primary" />
                </div>
                {nameError && <p className="text-[11px] text-red-500 mt-0.5">{nameError}</p>}
              </>
            ) : (
              <Input label="Combo Name" value={name} onChange={handleNameChange} placeholder="my-combo" error={nameError} />
            )}
            <p className="text-[10px] text-text-muted mt-0.5">
              {forcePrefix ? `Auto-prefixed with "${forcePrefix}". ` : ""}Only letters, numbers, -, _ and . allowed
            </p>
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">Models</label>
            {models.length === 0 ? (
              <div className="text-center py-4 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                <span className="material-symbols-outlined text-text-muted text-xl mb-1">layers</span>
                <p className="text-xs text-text-muted">No models added yet</p>
              </div>
            ) : (
              <div className="flex max-h-[55vh] min-w-0 flex-col gap-1 overflow-y-auto sm:max-h-[350px]">
                {models.map((model, index) => (
                  <ModelItem key={index} index={index} model={model}
                    isFirst={index === 0} isLast={index === models.length - 1}
                    onEdit={(v) => { const a = [...models]; a[index] = v; setModels(a); }}
                    onMoveUp={() => handleMoveUp(index)}
                    onMoveDown={() => handleMoveDown(index)}
                    onRemove={() => handleRemoveModel(index)} />
                ))}
              </div>
            )}
            <button onClick={() => setShowModelSelect(true)}
              className="w-full mt-2 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1">
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add Model
            </button>
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">Accounts By Model</label>
            {models.length === 0 ? (
              <div className="text-center py-3 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                <p className="text-xs text-text-muted">Add model first</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2 max-h-[260px] overflow-y-auto">
                {models.map((model) => {
                  const hasCustomAccounts = Object.prototype.hasOwnProperty.call(accountFilters, model);
                  const selectedAccounts = hasCustomAccounts ? accountFilters[model] || [] : [];
                  const useAllAccounts = !hasCustomAccounts;
                  const availableConnections = getModelConnectionCandidates(model, activeProviders);
                  return (
                    <div key={model} className="rounded-lg border border-black/10 dark:border-white/10 p-2">
                      <div className="mb-2">
                        <code className="block truncate font-mono text-[11px] text-text-main">{model}</code>
                      </div>
                      <div className="flex items-center gap-2 mb-2">
                        <button
                          type="button"
                          onClick={() => setAccountFilters((prev) => {
                            const next = { ...prev };
                            if (useAllAccounts) next[model] = [];
                            else delete next[model];
                            return next;
                          })}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${useAllAccounts ? "bg-primary" : "bg-black/10 dark:bg-white/10"}`}
                        >
                          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${useAllAccounts ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
                        </button>
                        <span className="text-xs text-text-main">All accounts for this model</span>
                      </div>
                      {!useAllAccounts && (
                        <div className="flex flex-col gap-1 max-h-[120px] overflow-y-auto border border-black/10 dark:border-white/10 rounded-lg p-2">
                          {availableConnections.length === 0 ? (
                            <p className="text-xs text-text-muted text-center py-2">No accounts available</p>
                          ) : (
                            availableConnections.map((conn) => {
                              const isSelected = selectedAccounts.includes(conn.id);
                              return (
                                <label key={`${model}-${conn.id}`} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-black/[0.03] dark:hover:bg-white/[0.03] cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => {
                                      setAccountFilters((prev) => {
                                        const current = (prev[model] || []).filter(Boolean);
                                        return {
                                          ...prev,
                                          [model]: isSelected
                                            ? current.filter((id) => id !== conn.id)
                                            : [...current, conn.id],
                                        };
                                      });
                                    }}
                                    className="rounded border-border text-primary focus:ring-primary/50 h-3.5 w-3.5"
                                  />
                                  <span className="text-xs text-text-main truncate">{conn.name || conn.email || conn.provider}</span>
                                  <span className="text-[10px] text-text-muted ml-auto shrink-0">{conn.provider}</span>
                                </label>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Button onClick={onClose} variant="ghost" fullWidth size="sm">Cancel</Button>
            <Button onClick={handleSave} fullWidth size="sm" disabled={!name.trim() || !!nameError || saving}>
              {saving ? "Saving..." : isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>

      <ModelSelectModal isOpen={showModelSelect} onClose={() => setShowModelSelect(false)}
        onSelect={handleAddModel} onDeselect={handleDeselectModel}
        activeProviders={activeProviders} modelAliases={modelAliases}
        title="Add Model to Combo" kindFilter={kindFilter}
        addedModelValues={models} closeOnSelect={false} />
    </>
  );
}
