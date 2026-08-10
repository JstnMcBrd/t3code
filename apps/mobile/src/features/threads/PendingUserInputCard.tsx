import type { ApprovalRequestId, UserInputQuestion } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { Pressable, ScrollView, View } from "react-native";
import Animated, { FadeIn, FadeInUp, FadeOut } from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  isPendingUserInputOptionSelected,
  type PendingUserInput,
  type PendingUserInputDraftAnswer,
} from "../../lib/threadActivity";

export interface PendingUserInputCardProps {
  readonly pendingUserInput: PendingUserInput;
  /** Animated max-height tracking the keyboard, applied to the expanded card. */
  readonly maxHeightStyle: ComponentProps<typeof Animated.View>["style"];
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  /** Renders a stop control on the collapsed bar, which replaces the composer. */
  readonly onStopThread?: () => void;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly answers: Record<string, string | ReadonlyArray<string>> | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly onSelectOption: (
    requestId: ApprovalRequestId,
    question: UserInputQuestion,
    label: string,
  ) => void;
  readonly onChangeCustomAnswer: (
    requestId: ApprovalRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmit: () => Promise<unknown>;
}

/**
 * The bar and the card swap via keyed remounts with enter/exit animations —
 * frame-morphing one view between shapes this different strands it mid-flight
 * detached from the bottom slot. The expanded card's height needs no layout
 * transition: its animated max-height style already tracks the keyboard
 * frame-by-frame.
 */
export function PendingUserInputCard(props: PendingUserInputCardProps) {
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const questionCount = props.pendingUserInput.questions.length;

  if (props.collapsed) {
    return (
      <Animated.View
        key="pending-user-input-bar"
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(120)}
        className="flex-row items-center gap-2 rounded-full border border-neutral-200 bg-neutral-100 py-1.5 pl-4 pr-1.5 dark:border-white/6 dark:bg-neutral-900"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Expand user input, ${questionCount} question${
            questionCount === 1 ? "" : "s"
          }`}
          onPress={props.onToggleCollapsed}
          className="min-h-10 flex-1 flex-row items-center gap-2 active:opacity-70"
        >
          <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-sky-700 dark:text-sky-300">
            User input needed
          </Text>
          <Text className="font-sans text-xs text-neutral-500 dark:text-neutral-400">
            {questionCount} question{questionCount === 1 ? "" : "s"}
          </Text>
          <View className="flex-1" />
          <SymbolView name="chevron.up" size={12} tintColor={iconSubtle} type="monochrome" />
        </Pressable>
        {props.onStopThread ? (
          <ControlPill
            accessibilityLabel="Stop"
            icon="stop.fill"
            variant="danger"
            className="h-9 w-9"
            onPress={props.onStopThread}
          />
        ) : null}
      </Animated.View>
    );
  }

  // The surface is opaque on purpose: the card floats over the thread feed
  // with no blur behind it, so a translucent background renders the questions
  // on top of whatever message happens to sit underneath.
  return (
    <Animated.View
      key="pending-user-input-card"
      entering={FadeInUp.duration(220)}
      exiting={FadeOut.duration(120)}
      className="overflow-hidden gap-2.5 rounded-[20px] border border-neutral-200 bg-neutral-100 p-4 dark:border-white/6 dark:bg-neutral-900"
      style={props.maxHeightStyle}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Collapse user input"
        onPress={props.onToggleCollapsed}
        className="flex-row items-start gap-2"
      >
        <View className="flex-1 gap-2.5">
          <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-sky-700 dark:text-sky-300">
            User input needed
          </Text>
          <Text className="font-t3-bold text-lg text-neutral-950 dark:text-neutral-50">
            Fill in the pending answers
          </Text>
        </View>
        <View className="h-8 w-8 items-center justify-center rounded-full bg-neutral-200/70 dark:bg-white/8">
          <SymbolView name="chevron.down" size={13} tintColor={iconSubtle} type="monochrome" />
        </View>
      </Pressable>
      <ScrollView
        bounces={false}
        className="min-h-0"
        contentContainerClassName="gap-2.5 pb-1"
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        showsVerticalScrollIndicator
        style={{ flexShrink: 1 }}
      >
        {props.pendingUserInput.questions.map((question) => {
          const draft = props.drafts[question.id];
          return (
            <View key={question.id} className="gap-2 pt-1">
              <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-neutral-500 dark:text-neutral-500">
                {question.header}
              </Text>
              <Text className="font-sans text-base leading-snug text-neutral-950 dark:text-neutral-50">
                {question.question}
              </Text>
              <View className="flex-row flex-wrap gap-2.5">
                {question.options.map((option) => {
                  const selected = isPendingUserInputOptionSelected(draft, option.label);
                  return (
                    <Pressable
                      key={option.label}
                      className={cn(
                        "rounded-full border px-3 py-2.5 ",
                        selected
                          ? "border-blue-300/50 bg-blue-50 dark:border-blue-400/28 dark:bg-blue-400/14"
                          : "border-neutral-200 bg-white dark:border-white/6 dark:bg-neutral-950/70",
                      )}
                      onPress={() =>
                        props.onSelectOption(
                          props.pendingUserInput.requestId,
                          question,
                          option.label,
                        )
                      }
                    >
                      <Text
                        className={cn(
                          "font-t3-bold text-sm",
                          selected
                            ? "text-sky-700 dark:text-sky-300"
                            : "text-neutral-600 dark:text-neutral-300",
                        )}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <TextInput
                value={draft?.customAnswer ?? ""}
                onChangeText={(value) =>
                  props.onChangeCustomAnswer(props.pendingUserInput.requestId, question.id, value)
                }
                placeholder="Or type a custom answer"
                className="min-h-[54px] rounded-2xl border border-neutral-200 bg-white px-3.5 py-3 font-sans text-base text-neutral-950 dark:border-white/8 dark:bg-neutral-950/70 dark:text-neutral-50"
              />
            </View>
          );
        })}
      </ScrollView>
      <Pressable
        className={cn(
          "items-center justify-center rounded-2xl px-4 py-3.5",
          props.answers ? "bg-blue-500" : "bg-neutral-200 dark:bg-neutral-700/60",
        )}
        disabled={
          props.answers === null || props.respondingUserInputId === props.pendingUserInput.requestId
        }
        onPress={() => void props.onSubmit()}
      >
        <Text className="font-t3-extrabold text-sm text-white">Submit answers</Text>
      </Pressable>
    </Animated.View>
  );
}
