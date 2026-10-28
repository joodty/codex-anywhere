/** Shared model contract for the browser draft and both native delivery paths. */
export type ModelOption = {
  model: string; displayName: string; description: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  serviceTiers: Array<{ id: string; name: string; description: string }>;
  defaultServiceTier: string | null; isDefault: boolean;
};
export type ModelConfigDraft = { model: string; reasoningEffort: string; fastMode: boolean };
export type ModelSettings = ModelConfigDraft & { serviceTier: string };
export const isFastTier = (tier: { id: string; name?: string }) => /fast|priority/i.test(`${tier.id} ${tier.name || ''}`);

export function resolveModelSettings(models: ModelOption[], value: unknown): ModelSettings {
  if (!value || typeof value !== 'object') throw new Error('model_config_invalid');
  const draft = value as ModelConfigDraft;
  const model = models.find(candidate => candidate.model === draft.model);
  if (!model) throw new Error('model_not_available');
  if (!model.supportedReasoningEfforts.some(option => option.reasoningEffort === draft.reasoningEffort)) throw new Error('reasoning_effort_not_available');
  if (draft.fastMode !== undefined && typeof draft.fastMode !== 'boolean') throw new Error('model_config_invalid');
  const fast = model.serviceTiers.find(isFastTier);
  if (draft.fastMode && !fast) throw new Error('fast_mode_not_available');
  const standard = model.serviceTiers.find(tier => tier.id === model.defaultServiceTier && !isFastTier(tier))
    || model.serviceTiers.find(tier => /default|standard/i.test(`${tier.id} ${tier.name}`));
  return { model: model.model, reasoningEffort: draft.reasoningEffort, fastMode: draft.fastMode === true,
    serviceTier: draft.fastMode ? fast!.id : standard?.id || 'default' };
}

export function normalizeModelReasoningEffort(model: ModelOption, value: unknown) {
  const requested = String(value || '').trim();
  const supported = model.supportedReasoningEfforts.map(option => option.reasoningEffort);
  if (supported.includes(requested)) return requested;
  if (['none', 'minimal'].includes(requested) && supported.includes('low')) return 'low';
  if (['max', 'ultra'].includes(requested) && supported.includes('xhigh')) return 'xhigh';
  return supported.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : supported[0] || '';
}

export function initialModelSettings(models: ModelOption[], preference: unknown): ModelSettings {
  const saved = preference && typeof preference === 'object' ? preference as Partial<ModelConfigDraft> : {};
  const model = models.find(candidate => candidate.model === saved.model) || models.find(candidate => candidate.isDefault) || models[0];
  if (!model) throw new Error('model_not_available');
  return resolveModelSettings(models, { model: model.model, reasoningEffort: normalizeModelReasoningEffort(model, saved.reasoningEffort),
    fastMode: saved.fastMode === true && model.serviceTiers.some(isFastTier) });
}

export function modelConfigDraft(settings: ModelConfigDraft): ModelConfigDraft {
  return { model: settings.model, reasoningEffort: settings.reasoningEffort, fastMode: settings.fastMode };
}
