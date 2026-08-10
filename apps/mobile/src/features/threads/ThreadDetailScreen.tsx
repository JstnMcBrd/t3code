import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import { useKeyboardChatComposerInset, useKeyboardScrollToEnd } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { HeaderHeightContext } from "@react-navigation/elements";
import type {
  ApprovalRequestId,
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationThreadShell,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
  ThreadId,
  UserInputQuestion,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isLiquidGlassSupported, LiquidGlassView } from "@callstack/liquid-glass";
import {
  Keyboard,
  Platform,
  useColorScheme,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
} from "react-native";
import {
  KeyboardController,
  KeyboardStickyView,
  useKeyboardState,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import Animated, { FadeInDown, FadeOut, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ControlPill } from "../../components/ControlPill";
import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import type { StatusTone } from "../../components/StatusPill";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { CHAT_CONTENT_MAX_WIDTH, type LayoutVariant } from "../../lib/layout";
import { scopedThreadKey } from "../../lib/scopedEntities";
import type {
  PendingApproval,
  PendingUserInput,
  PendingUserInputDraftAnswer,
  ThreadFeedEntry,
} from "../../lib/threadActivity";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { derivePendingUserInputMaxHeight } from "./pendingUserInputLayout";
import {
  COMPOSER_COLLAPSED_CHROME,
  COMPOSER_EXPANDED_CHROME,
  ThreadComposer,
} from "./ThreadComposer";
import { ThreadFeed } from "./ThreadFeed";
import type { ThreadContentPresentation } from "./threadContentPresentation";

export interface ThreadDetailScreenProps {
  readonly selectedThread: OrchestrationThreadShell;
  readonly contentPresentation: ThreadContentPresentation;
  readonly screenTone: StatusTone;
  readonly connectionError: string | null;
  readonly environmentLabel: string | null;
  readonly selectedThreadFeed: ReadonlyArray<ThreadFeedEntry>;
  readonly activeWorkStartedAt: string | null;
  readonly activePendingApproval: PendingApproval | null;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activePendingUserInputDrafts: Record<string, PendingUserInputDraftAnswer>;
  readonly activePendingUserInputAnswers: Record<string, string | ReadonlyArray<string>> | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly connectionStateLabel: EnvironmentConnectionPhase;
  /** Message sync status for the selected thread (drives the composer status pill). */
  readonly threadSyncStatus?: EnvironmentThreadStatus;
  /** Non-null when older turns exist beyond the loaded window. */
  readonly loadEarlier?: { readonly loading: boolean; readonly onLoadEarlier: () => void } | null;
  readonly activeThreadBusy: boolean;
  readonly environmentId: EnvironmentId;
  readonly projectWorkspaceRoot: string | null;
  readonly threadCwd: string | null;
  readonly selectedThreadQueueCount: number;
  readonly serverConfig: T3ServerConfig | null;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly onOpenConnectionEditor: () => void;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftImages: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  readonly onSendMessage: () => Promise<MessageId | null>;
  readonly onReconnectEnvironment: () => void;
  readonly onUpdateThreadModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateThreadRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateThreadInteractionMode: (interactionMode: ProviderInteractionMode) => void;
  readonly onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  readonly onSelectUserInputOption: (
    requestId: ApprovalRequestId,
    question: UserInputQuestion,
    label: string,
  ) => void;
  readonly onChangeUserInputCustomAnswer: (
    requestId: ApprovalRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmitUserInput: () => Promise<unknown>;
  readonly showContent?: boolean;
}

function latestStreamingAssistantMessage(
  feed: ReadonlyArray<ThreadFeedEntry>,
): { readonly id: string; readonly textLength: number } | null {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const entry = feed[index];
    if (entry?.type !== "message") {
      continue;
    }
    if (entry.message.role !== "assistant" || !entry.message.streaming) {
      continue;
    }
    return {
      id: entry.message.id,
      textLength: entry.message.text.length,
    };
  }

  return null;
}

function useStreamingHaptics(threadId: ThreadId, feed: ReadonlyArray<ThreadFeedEntry>) {
  const lastStreamingAssistantRef = useRef<{
    readonly id: string;
    readonly textLength: number;
  } | null>(null);
  const lastStreamHapticAtRef = useRef(0);
  const hydratedRef = useRef(false);
  const previousThreadIdRef = useRef(threadId);

  useEffect(() => {
    if (previousThreadIdRef.current !== threadId) {
      previousThreadIdRef.current = threadId;
      hydratedRef.current = false;
    }

    const latestStreamingMessage = latestStreamingAssistantMessage(feed);

    if (!hydratedRef.current) {
      hydratedRef.current = true;
      lastStreamingAssistantRef.current = latestStreamingMessage;
      return;
    }

    if (!latestStreamingMessage) {
      lastStreamingAssistantRef.current = null;
      return;
    }

    const previousStreamingMessage = lastStreamingAssistantRef.current;
    lastStreamingAssistantRef.current = latestStreamingMessage;

    const isNewStream = previousStreamingMessage?.id !== latestStreamingMessage.id;
    const textGrew =
      previousStreamingMessage?.id === latestStreamingMessage.id &&
      latestStreamingMessage.textLength > previousStreamingMessage.textLength;

    if (!isNewStream && !textGrew) {
      return;
    }

    const now = Date.now();
    if (!isNewStream && now - lastStreamHapticAtRef.current < 320) {
      return;
    }

    lastStreamHapticAtRef.current = now;
    void Haptics.selectionAsync();
  }, [threadId, feed]);
}

export const ThreadDetailScreen = memo(function ThreadDetailScreen(props: ThreadDetailScreenProps) {
  const insets = useSafeAreaInsets();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const windowHeight = useWindowDimensions().height;
  const navigationHeaderHeight = useContext(HeaderHeightContext) || insets.top + 44;
  const agentLabel = `${props.selectedThread.modelSelection.instanceId} agent`;
  const selectedThreadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
  const composerEditorRef = useRef<ComposerEditorHandle>(null);
  const composerOverlayRef = useRef<View>(null);
  const listRef = useRef<LegendListRef>(null);
  const feedTouchStartRef = useRef<{ pageX: number; pageY: number } | null>(null);
  const selectedThreadKeyRef = useRef(selectedThreadKey);
  const lastScrolledAnchorMessageIdRef = useRef<MessageId | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [anchorMessageId, setAnchorMessageId] = useState<MessageId | null>(null);
  const [endFollowEnabled, setEndFollowEnabled] = useState(true);
  const composerBottomInset = composerExpanded ? 0 : Math.max(insets.bottom, 12);
  const contentPresentationKind = props.contentPresentation.kind;
  // The raw sync status enters "synchronizing" on every full fetch, cached or
  // not. Whether messages are already on screen decides the pill label: no
  // data yet → "Loading messages", cached data reconciling → "Syncing".
  const threadSyncPhase = (() => {
    switch (props.threadSyncStatus) {
      case "empty":
      case "cached":
      case "synchronizing":
        if (contentPresentationKind === "ready") {
          return "syncing" as const;
        }
        return contentPresentationKind === "loading" ? ("loading" as const) : null;
      default:
        return null;
    }
  })();
  const selectedThreadFeed = props.selectedThreadFeed;
  const composerChrome = composerExpanded ? COMPOSER_EXPANDED_CHROME : COMPOSER_COLLAPSED_CHROME;
  const composerOverlapHeight = composerChrome + composerBottomInset;
  // While a user-input request is pending, the questionnaire owns the
  // composer slot outright: expanded it is the full card, collapsed it is a
  // composer-style bar in the same place (with its own stop control). The
  // composer never mounts into the transition, which keeps the collapse and
  // keyboard animations coherent. Collapse state is keyed by request id so a
  // new request re-expands automatically.
  const [collapsedUserInputRequestId, setCollapsedUserInputRequestId] =
    useState<ApprovalRequestId | null>(null);
  const activeUserInputRequestId = props.activePendingUserInput?.requestId ?? null;
  const userInputCollapsed =
    activeUserInputRequestId !== null && collapsedUserInputRequestId === activeUserInputRequestId;
  const handleToggleUserInputCollapsed = useCallback(() => {
    if (activeUserInputRequestId === null) {
      return;
    }
    if (userInputCollapsed) {
      setCollapsedUserInputRequestId(null);
    } else {
      // Collapsing hides the custom-answer inputs; release the keyboard with
      // them instead of leaving it up over a dead responder.
      Keyboard.dismiss();
      setCollapsedUserInputRequestId(activeUserInputRequestId);
    }
  }, [activeUserInputRequestId, userInputCollapsed]);
  // The card's max height tracks the keyboard's ANIMATED height, so it
  // resizes frame-by-frame with the keyboard instead of correcting itself in
  // a second animation once the hide settles (the binary visibility state
  // only flips on keyboardDidHide).
  const keyboardAnimation = useReanimatedKeyboardAnimation();
  const pendingUserInputMaxHeightStyle = useAnimatedStyle(() => ({
    maxHeight: derivePendingUserInputMaxHeight({
      windowHeight,
      keyboardHeight: Math.abs(keyboardAnimation.height.value),
      navigationHeaderHeight,
      // The questionnaire owns the composer slot, so only the composer's
      // bottom inset still overlaps.
      composerOverlapHeight: composerBottomInset,
    }),
  }));
  const estimatedOverlayHeight = composerOverlapHeight;
  // The overlay's measured height includes the home-indicator inset (the
  // composer pads it), but contentInsetAdjustmentBehavior="automatic" makes
  // UIKit add the safe-area bottom to the content inset AGAIN — leaving a
  // dead strip between the resting content and the composer. Report the
  // overlay height minus the safe area; UIKit adds it back, and ThreadFeed
  // hands LegendList the same delta via contentInsetEndStaticAdjustment so
  // its end-scroll math matches the real resting position.
  const nativeInsetOvercount =
    props.usesAutomaticContentInsets === true && Platform.OS === "ios" ? insets.bottom : 0;
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(
    listRef,
    composerOverlayRef,
    Math.max(0, estimatedOverlayHeight - nativeInsetOvercount),
    -nativeInsetOvercount,
  );
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });
  const showContent = props.showContent ?? true;
  const layoutVariant = props.layoutVariant ?? "compact";
  const isSplitLayout = layoutVariant === "split";
  const contentMaxWidth = isSplitLayout ? CHAT_CONTENT_MAX_WIDTH : undefined;
  const selectedInstanceId = props.selectedThread.modelSelection.instanceId;
  useStreamingHaptics(props.selectedThread.id, props.selectedThreadFeed);
  const selectedProviderSkills = useMemo(
    () =>
      props.serverConfig?.providers.find((provider) => provider.instanceId === selectedInstanceId)
        ?.skills ?? [],
    [props.serverConfig, selectedInstanceId],
  );

  useLayoutEffect(() => {
    selectedThreadKeyRef.current = selectedThreadKey;
  }, [selectedThreadKey]);

  useEffect(() => {
    setAnchorMessageId(null);
    lastScrolledAnchorMessageIdRef.current = null;
    setEndFollowEnabled(true);
    freeze.set(false);
  }, [freeze, selectedThreadKey]);

  useEffect(() => {
    if (
      anchorMessageId === null ||
      lastScrolledAnchorMessageIdRef.current === anchorMessageId ||
      contentPresentationKind !== "ready" ||
      !selectedThreadFeed.some((entry) => entry.type === "message" && entry.id === anchorMessageId)
    ) {
      return;
    }

    const targetThreadKey = selectedThreadKey;
    const frame = requestAnimationFrame(() => {
      if (selectedThreadKeyRef.current !== targetThreadKey) {
        return;
      }
      lastScrolledAnchorMessageIdRef.current = anchorMessageId;
      // Wait for the keyboard dismissal (started by blur() on send) to finish
      // before scrolling: scrollMessageToEnd freezes keyboard-driven inset
      // updates while it runs, and a close event swallowed by that freeze
      // leaves the keyboard padding permanently applied — overshooting the
      // anchor and leaving a phantom bottom inset once the reply streams in.
      void KeyboardController.dismiss()
        .then(() => {
          if (
            selectedThreadKeyRef.current !== targetThreadKey ||
            lastScrolledAnchorMessageIdRef.current !== anchorMessageId
          ) {
            return;
          }
          return scrollMessageToEnd({ animated: true, closeKeyboard: false });
        })
        .catch(() => {
          if (
            selectedThreadKeyRef.current !== targetThreadKey ||
            lastScrolledAnchorMessageIdRef.current !== anchorMessageId
          ) {
            return;
          }
          lastScrolledAnchorMessageIdRef.current = null;
          freeze.set(false);
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    anchorMessageId,
    freeze,
    contentPresentationKind,
    selectedThreadFeed,
    scrollMessageToEnd,
    selectedThreadKey,
  ]);

  const handleSendMessage = useCallback(async () => {
    const targetThreadKey = selectedThreadKey;
    const messageId = await props.onSendMessage();
    if (messageId === null || selectedThreadKeyRef.current !== targetThreadKey) {
      return messageId;
    }

    setAnchorMessageId(messageId);
    composerEditorRef.current?.blur();
    return messageId;
  }, [props.onSendMessage, selectedThreadKey]);

  const collapseComposer = useCallback(() => {
    composerEditorRef.current?.blur();
  }, []);

  const handleScrollToEnd = useCallback(() => {
    void Haptics.selectionAsync();
    void scrollMessageToEnd({ animated: true, closeKeyboard: false }).catch(() => {
      freeze.set(false);
    });
  }, [freeze, scrollMessageToEnd]);

  const showScrollToEndButton = contentPresentationKind === "ready" && !endFollowEnabled;
  const isDarkMode = useColorScheme() === "dark";

  const handleFeedTouchStart = useCallback((event: GestureResponderEvent) => {
    feedTouchStartRef.current = {
      pageX: event.nativeEvent.pageX,
      pageY: event.nativeEvent.pageY,
    };
  }, []);

  const handleFeedTouchMove = useCallback((event: GestureResponderEvent) => {
    const start = feedTouchStartRef.current;
    if (!start) {
      return;
    }
    const deltaX = event.nativeEvent.pageX - start.pageX;
    const deltaY = event.nativeEvent.pageY - start.pageY;
    if (Math.hypot(deltaX, deltaY) > 8) {
      feedTouchStartRef.current = null;
    }
  }, []);

  const handleFeedTouchEnd = useCallback(() => {
    if (feedTouchStartRef.current) {
      collapseComposer();
    }
    feedTouchStartRef.current = null;
  }, [collapseComposer]);

  const handleFeedTouchCancel = useCallback(() => {
    feedTouchStartRef.current = null;
  }, []);

  return (
    <View className="flex-1">
      {showContent ? (
        <View
          className="flex-1"
          onTouchStart={handleFeedTouchStart}
          onTouchMove={handleFeedTouchMove}
          onTouchEnd={handleFeedTouchEnd}
          onTouchCancel={handleFeedTouchCancel}
        >
          <ThreadFeed
            key={props.selectedThread.id}
            environmentId={props.environmentId}
            threadId={props.selectedThread.id}
            workspaceRoot={props.threadCwd}
            feed={props.selectedThreadFeed}
            contentPresentation={props.contentPresentation}
            agentLabel={agentLabel}
            latestTurn={props.selectedThread.latestTurn}
            activeWorkStartedAt={props.activeWorkStartedAt}
            listRef={listRef}
            freeze={freeze}
            anchorMessageId={anchorMessageId}
            contentInsetEndAdjustment={contentInsetEndAdjustment}
            contentTopInset={0}
            contentBottomInset={estimatedOverlayHeight}
            contentMaxWidth={contentMaxWidth}
            layoutVariant={layoutVariant}
            usesAutomaticContentInsets={props.usesAutomaticContentInsets}
            onHeaderMaterialVisibilityChange={props.onHeaderMaterialVisibilityChange}
            onEndFollowEnabledChange={setEndFollowEnabled}
            skills={selectedProviderSkills}
            loadEarlier={props.loadEarlier ?? null}
          />
        </View>
      ) : (
        <View className="flex-1" />
      )}

      {/* Floating composer — sticks to keyboard via KeyboardStickyView */}
      {showContent ? (
        <KeyboardStickyView
          // The animated keyboard height can remain stale after a dismissed
          // IME on both platforms. Visibility is the authoritative closed
          // state, so disable the translation rather than stranding the pill.
          enabled={isKeyboardVisible}
          style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
          offset={{ closed: 0, opened: 0 }}
        >
          {/* No paddingTop here: the overlay's measured height becomes the
              list's bottom inset, so any padding above the pill/composer
              pushes the resting content floor up by the same amount. */}
          <View ref={composerOverlayRef} onLayout={onComposerLayout} className="w-full">
            {showScrollToEndButton ? (
              <Animated.View
                pointerEvents="box-none"
                className="absolute -top-11 left-0 right-0 z-20 items-center"
                entering={FadeInDown.duration(160)}
                exiting={FadeOut.duration(100)}
              >
                {isLiquidGlassSupported ? (
                  <LiquidGlassView
                    colorScheme={isDarkMode ? "dark" : "light"}
                    effect="regular"
                    interactive
                    // Interactive glass can render larger than the requested
                    // box (minimum touch size), so center the pill instead of
                    // relying on it filling the glass exactly.
                    style={{
                      alignItems: "center",
                      borderRadius: 18,
                      height: 36,
                      justifyContent: "center",
                      overflow: "hidden",
                      width: 36,
                    }}
                  >
                    <ControlPill
                      accessibilityLabel="Scroll to end"
                      activateOnPressIn
                      className="h-9 w-9 bg-transparent"
                      icon={{ ios: "chevron.down", android: "keyboard_arrow_down" }}
                      onPress={handleScrollToEnd}
                    />
                  </LiquidGlassView>
                ) : (
                  <ControlPill
                    accessibilityLabel="Scroll to end"
                    activateOnPressIn
                    className="h-9 w-9 border border-border bg-card shadow-md shadow-black/10"
                    icon={{ ios: "chevron.down", android: "keyboard_arrow_down" }}
                    onPress={handleScrollToEnd}
                  />
                )}
              </Animated.View>
            ) : null}
            <View className="w-full self-center" style={{ maxWidth: contentMaxWidth }}>
              {props.activePendingApproval || props.activePendingUserInput ? (
                <Animated.View
                  className="shrink-0 gap-3 px-4 pb-3"
                  // The questionnaire replaces the composer, so it must pad
                  // the home indicator the composer normally covers.
                  style={
                    activeUserInputRequestId !== null
                      ? { paddingBottom: composerBottomInset }
                      : undefined
                  }
                  entering={FadeInDown.duration(220)}
                  exiting={FadeOut.duration(140)}
                >
                  {props.activePendingApproval ? (
                    <PendingApprovalCard
                      approval={props.activePendingApproval}
                      respondingApprovalId={props.respondingApprovalId}
                      onRespond={props.onRespondToApproval}
                    />
                  ) : null}
                  {props.activePendingUserInput ? (
                    <PendingUserInputCard
                      pendingUserInput={props.activePendingUserInput}
                      maxHeightStyle={pendingUserInputMaxHeightStyle}
                      collapsed={userInputCollapsed}
                      onToggleCollapsed={handleToggleUserInputCollapsed}
                      onStopThread={props.onStopThread}
                      drafts={props.activePendingUserInputDrafts}
                      answers={props.activePendingUserInputAnswers}
                      respondingUserInputId={props.respondingUserInputId}
                      onSelectOption={props.onSelectUserInputOption}
                      onChangeCustomAnswer={props.onChangeUserInputCustomAnswer}
                      onSubmit={props.onSubmitUserInput}
                    />
                  ) : null}
                </Animated.View>
              ) : null}
            </View>

            {/* Hidden (not unmounted) while a user-input request owns the
                composer slot, so composer drafts and editor state survive. */}
            <View style={activeUserInputRequestId !== null ? { display: "none" } : undefined}>
              <ThreadComposer
                editorRef={composerEditorRef}
                draftMessage={props.draftMessage}
                draftAttachments={props.draftAttachments}
                placeholder="Ask the repo agent, or run a command…"
                contentMaxWidth={contentMaxWidth}
                connectionState={props.connectionStateLabel}
                connectionError={props.connectionError}
                environmentLabel={props.environmentLabel}
                threadSyncPhase={threadSyncPhase}
                selectedThread={props.selectedThread}
                serverConfig={props.serverConfig}
                queueCount={props.selectedThreadQueueCount}
                activeThreadBusy={props.activeThreadBusy}
                environmentId={props.environmentId}
                projectCwd={props.projectWorkspaceRoot}
                bottomInset={composerBottomInset}
                onChangeDraftMessage={props.onChangeDraftMessage}
                onPickDraftImages={props.onPickDraftImages}
                onNativePasteImages={props.onNativePasteImages}
                onRemoveDraftImage={props.onRemoveDraftImage}
                onStopThread={props.onStopThread}
                onSendMessage={handleSendMessage}
                onReconnectEnvironment={props.onReconnectEnvironment}
                onUpdateModelSelection={props.onUpdateThreadModelSelection}
                onUpdateRuntimeMode={props.onUpdateThreadRuntimeMode}
                onUpdateInteractionMode={props.onUpdateThreadInteractionMode}
                onExpandedChange={setComposerExpanded}
              />
            </View>
          </View>
        </KeyboardStickyView>
      ) : null}
    </View>
  );
});
