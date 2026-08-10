import type { MenuAction } from "@react-native-menu/menu";
import type { ModelSelection, ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";

import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";

/**
 * Desktop-oriented effort keywords that don't belong in the phone picker.
 * Prompt-injected values (ultrathink and friends) are filtered from the
 * descriptor metadata; ultracode is a real option but a workflow trigger, not
 * a reasoning level. A value set elsewhere still displays, it just isn't
 * offered.
 */
export const HIDDEN_EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["ultracode"]);

export const RUNTIME_MODE_CHOICES: ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly shortLabel: string;
}> = [
  { mode: "approval-required", label: "Approve actions", shortLabel: "Approve" },
  { mode: "auto-accept-edits", label: "Auto-accept edits", shortLabel: "Edits" },
  { mode: "auto", label: "Auto", shortLabel: "Auto" },
  { mode: "full-access", label: "Full access", shortLabel: "Full" },
];

export function selectableChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
) {
  const injected = new Set(descriptor.promptInjectedValues ?? []);
  return descriptor.options.filter(
    (option) => !injected.has(option.id) && !HIDDEN_EFFORT_OPTION_IDS.has(option.id),
  );
}

export type ThreadSettingsMenuEvent =
  | { readonly type: "select-model"; readonly option: ModelOption }
  | { readonly type: "set-option"; readonly optionId: string; readonly value: string | boolean }
  | { readonly type: "set-runtime"; readonly mode: RuntimeMode }
  | { readonly type: "open-settings" };

export type ThreadSettingsMenu = {
  readonly actions: MenuAction[];
  /** Menu action id → the change it applies, for the onPressAction dispatch. */
  readonly events: ReadonlyMap<string, ThreadSettingsMenuEvent>;
};

/**
 * Native menu equivalent of the thread settings sheet for the everyday
 * adjustments (model, select/boolean provider options, runtime mode). The
 * menu presents from the composer pill without resigning the keyboard, so the
 * common flow never bounces focus; "All Settings…" falls back to the sheet
 * for anything richer.
 *
 * Selections apply immediately — the sheet's stage-then-Save flow only exists
 * because the sheet batches a model change with its option edits, and a menu
 * closes after each pick anyway.
 */
export function buildThreadSettingsMenu(input: {
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly selectedModel: ModelSelection | null;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly runtimeMode: RuntimeMode;
}): ThreadSettingsMenu {
  const events = new Map<string, ThreadSettingsMenuEvent>();
  const actions: MenuAction[] = [];

  const isSelected = (option: ModelOption) =>
    option.selection.instanceId === input.selectedModel?.instanceId &&
    option.selection.model === input.selectedModel.model;

  const modelAction = (option: ModelOption, id: string): MenuAction => {
    events.set(id, { type: "select-model", option });
    return {
      id,
      title: option.label,
      ...(option.isDefault ? { subtitle: "Default" } : {}),
      state: isSelected(option) ? "on" : "off",
    };
  };

  const modelItems: MenuAction[] = [];
  const legacyItems: MenuAction[] = [];
  let selectedModelLabel: string | undefined;
  input.providerGroups.forEach((group, groupIndex) => {
    const groupItems: MenuAction[] = [];
    group.models.forEach((option, modelIndex) => {
      if (isSelected(option)) {
        selectedModelLabel = option.label;
      }
      const id = `model:${groupIndex}:${modelIndex}`;
      // A highlighted legacy model stays in the main list (mirroring the
      // sheet) so the checkmark isn't hidden behind the Legacy fold.
      if (option.isLegacy && !isSelected(option)) {
        legacyItems.push(modelAction(option, id));
      } else {
        groupItems.push(modelAction(option, id));
      }
    });
    if (groupItems.length === 0) {
      return;
    }
    // A thread is bound to one harness, so provider sections only appear for
    // multi-group callers (the new-task draft, if it ever adopts the menu).
    if (input.providerGroups.length > 1) {
      modelItems.push({
        id: `model-group:${groupIndex}`,
        title: group.providerLabel,
        displayInline: true,
        subactions: groupItems,
      });
    } else {
      modelItems.push(...groupItems);
    }
  });
  if (legacyItems.length > 0) {
    modelItems.push({
      id: "legacy-models",
      title: "Legacy Models",
      subactions: legacyItems,
    });
  }
  if (modelItems.length > 0) {
    actions.push({
      id: "model",
      title: "Model",
      ...(selectedModelLabel === undefined
        ? input.selectedModel
          ? { subtitle: input.selectedModel.model }
          : {}
        : { subtitle: selectedModelLabel }),
      subactions: modelItems,
    });
  }

  for (const descriptor of input.optionDescriptors) {
    if (descriptor.type === "boolean") {
      const id = `option:${descriptor.id}`;
      events.set(id, {
        type: "set-option",
        optionId: descriptor.id,
        value: !(descriptor.currentValue ?? false),
      });
      actions.push({
        id,
        title: descriptor.label,
        state: descriptor.currentValue ? "on" : "off",
      });
      continue;
    }
    const currentValue = getProviderOptionCurrentValue(descriptor);
    const choices = selectableChoices(descriptor).map((choice): MenuAction => {
      const id = `option:${descriptor.id}:${choice.id}`;
      events.set(id, { type: "set-option", optionId: descriptor.id, value: choice.id });
      return {
        id,
        title: choice.label,
        state: choice.id === currentValue ? "on" : "off",
      };
    });
    if (choices.length === 0) {
      continue;
    }
    const currentLabel = getProviderOptionCurrentLabel(descriptor);
    actions.push({
      id: `option:${descriptor.id}`,
      title: descriptor.label,
      ...(currentLabel === undefined ? {} : { subtitle: currentLabel }),
      subactions: choices,
    });
  }

  const runtimeLabel = RUNTIME_MODE_CHOICES.find(
    (choice) => choice.mode === input.runtimeMode,
  )?.label;
  actions.push({
    id: "runtime",
    title: "Runtime",
    ...(runtimeLabel === undefined ? {} : { subtitle: runtimeLabel }),
    subactions: RUNTIME_MODE_CHOICES.map((choice): MenuAction => {
      const id = `runtime:${choice.mode}`;
      events.set(id, { type: "set-runtime", mode: choice.mode });
      return {
        id,
        title: choice.label,
        state: choice.mode === input.runtimeMode ? "on" : "off",
      };
    }),
  });

  events.set("open-settings", { type: "open-settings" });
  actions.push({
    // Inline single-item section renders the system divider above the row.
    id: "settings-section",
    title: "",
    displayInline: true,
    subactions: [{ id: "open-settings", title: "All Settings…", image: "slider.horizontal.3" }],
  });

  return { actions, events };
}
