import { useState } from "react";
import { Check } from "lucide-react";

import type { AgentProfile } from "../../../core/vibers/contracts";
import {
  supportedEfforts,
  type ProviderDetection,
} from "../../../core/execution/providers/contracts";
import { useProviders } from "../../hooks/useWorkspace";
import { Select } from "../../components/ui/Select";
import { ProviderIcon } from "../../components/ui/ProviderIcon";

const providerNames = { codex: "Codex", antigravity: "Antigravity" } as const;

const effortNames: Record<string, string> = {
  default: "Automatic",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

const modelName = (name: string) =>
  name
    .replace(/^GPT-/i, "")
    .replaceAll("-", " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());

interface ModelGroup {
  id: string;
  label: string;
  variants: ProviderDetection["models"];
  efforts: string[];
}

const groupModels = (provider: string, models: ProviderDetection["models"]) => {
  const groups = new Map<string, ModelGroup>();
  for (const model of models) {
    const suffix =
      provider === "antigravity"
        ? model.id.match(/-(low|medium|high|xhigh|max|ultra)$/)?.[1]
        : undefined;

    const fixed =
      suffix && model.supportedEfforts.length === 1 && model.supportedEfforts[0] === suffix;

    const id = fixed ? model.id.slice(0, -suffix.length - 1) : model.id;

    const label = fixed
      ? (model.label || id).replace(
          /\s+(?:\((?:low|medium|high|extra high|xhigh|max|ultra)\)|low|medium|high|extra high|xhigh|max|ultra)$/i,
          "",
        )
      : model.label || id;

    const group = groups.get(id) || { id, label: modelName(label), variants: [], efforts: [] };
    group.variants.push(model);
    group.efforts = [...new Set([...group.efforts, ...model.supportedEfforts])];
    groups.set(id, group);
  }

  const order = Object.keys(effortNames);
  for (const group of groups.values()) {
    group.efforts.sort((left, right) => order.indexOf(left) - order.indexOf(right));
  }

  return [...groups.values()];
};

export const ViberModelPicker = ({
  execution,
  change,
  disabled = false,
}: {
  execution: AgentProfile["execution"];
  change: (execution: AgentProfile["execution"]) => void;
  disabled?: boolean;
}) => {
  const { providers, loading, error, refresh } = useProviders();
  const [browsingProvider, setBrowsingProvider] = useState(execution.provider);
  const [draft, setDraft] = useState<AgentProfile["execution"] | null>(null);
  const current = draft || execution;
  const browsingCatalog = providers.find((item) => item.provider === browsingProvider);
  const selectedProvider = providers.find((item) => item.provider === current.provider);

  const selectedGroups = groupModels(current.provider, selectedProvider?.models || []);

  const selectedGroup = selectedGroups.find((group) =>
    group.variants.some((model) => (current.model ? model.id === current.model : model.isDefault)),
  );

  const name = selectedGroup?.label || (current.model ? modelName(current.model) : "Choose model");

  const sameProvider = browsingProvider === current.provider;

  const groups = sameProvider
    ? selectedGroups
    : groupModels(browsingProvider, browsingCatalog?.models || []);

  const efforts =
    sameProvider && (selectedGroup || current.model)
      ? selectedGroup?.efforts || supportedEfforts(selectedProvider, current.model)
      : [];

  const options = groups.map((group) => ({
    value: `${browsingProvider}:${group.id}`,
    label: group.label,
    icon: <ProviderIcon provider={browsingProvider} model={group.id} />,
    disabled: !group.efforts.length,
  }));

  const value = `${current.provider}:${selectedGroup?.id || current.model}`;
  if (sameProvider && current.model && !options.some((option) => option.value === value)) {
    options.push({
      value,
      label: name,
      icon: <ProviderIcon provider={current.provider} />,
      disabled: true,
    });
  }

  const discoveryMessage = loading
    ? "Loading models…"
    : error || browsingCatalog?.error || "Connect a provider to load models.";

  return (
    <Select
      label="Model"
      triggerAppearance="chip"
      disabled={disabled}
      searchable
      closeOnSelect={false}
      onOpenChange={(open) => {
        if (open) {
          setDraft(execution);
          setBrowsingProvider(execution.provider);
          if (!loading && !selectedProvider?.models.length) {
            void refresh();
          }
        } else {
          if (draft && JSON.stringify(draft) !== JSON.stringify(execution)) {
            change(draft);
          }

          setDraft(null);
        }
      }}
      value={value}
      options={options}
      selectedIcon={<ProviderIcon provider={current.provider} model={current.model} />}
      selectedLabel={
        <>
          {name}
          {(selectedGroup || current.model) && (
            <span> {effortNames[current.effort] || current.effort}</span>
          )}
        </>
      }
      listNotice={
        !groups.length &&
        options.length > 0 && (
          <p className="viber-model-notice" role="status">
            {discoveryMessage}
          </p>
        )
      }
      emptyMessage={discoveryMessage}
      popoverClassName="viber-model-popover"
      navigation={
        <div className="viber-model-providers" role="group" aria-label="Model providers">
          {(["codex", "antigravity"] as const).map((provider) => (
            <button
              key={provider}
              type="button"
              aria-label={providerNames[provider]}
              title={providerNames[provider]}
              aria-pressed={browsingProvider === provider}
              onClick={() => setBrowsingProvider(provider)}
            >
              <ProviderIcon provider={provider} size={23} />
            </button>
          ))}
        </div>
      }
      details={
        <section className="viber-model-reasoning" aria-label="Reasoning effort">
          <header>
            <span>Reasoning</span>
            <small>{sameProvider ? name : providerNames[browsingProvider]}</small>
          </header>
          {efforts.map((effort) => (
            <button
              type="button"
              key={effort}
              aria-pressed={current.effort === effort}
              onClick={() =>
                setDraft({
                  ...current,
                  effort,
                  model:
                    selectedGroup?.variants.find((model) => model.supportedEfforts.includes(effort))
                      ?.id || current.model,
                })
              }
            >
              {effortNames[effort] || effort}
              {current.effort === effort && <Check size={15} aria-hidden="true" />}
            </button>
          ))}
          {!efforts.length && (
            <p>
              {sameProvider && (selectedGroup || current.model)
                ? "No adjustable reasoning."
                : "Choose a model to set reasoning."}
            </p>
          )}
        </section>
      }
      onChange={(value) => {
        const separator = value.indexOf(":");
        const provider = value.slice(0, separator) as typeof current.provider;
        const id = value.slice(separator + 1);
        const group = groups.find((group) => group.id === id);
        if (!group) {
          return;
        }

        const effort = group.efforts.includes(current.effort)
          ? current.effort
          : group.efforts[0] || current.effort;

        const model =
          group.variants.find((model) => model.supportedEfforts.includes(effort)) ||
          group.variants[0];

        setDraft({ ...current, provider, model: model?.id || id, effort });
      }}
    />
  );
};
