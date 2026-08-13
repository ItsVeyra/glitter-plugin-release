/**
 * 快速记录弹窗。
 * 负责维护速记输入运行时状态、链接导入与附件落盘，并驱动首次使用或全局保存流程。
 */

import { Modal } from "obsidian";
import { PoolModal } from "./pool-modal";
import {
  createSelectedCaptureMedia,
  createSelectedCaptureMediaFromImportedCandidates,
  normalizeQuickCapturePickedMediaFiles,
  pickQuickCaptureAttachmentFiles,
  releaseSelectedCaptureMediaPreviews,
  saveQuickCaptureSelectedMediaFiles,
  type PickQuickCaptureAttachmentFilesOptions,
  type QuickCaptureImportedMediaCandidate,
  type SelectedCaptureMedia
} from "./quick-capture-media";
import {
  blurFirstUseLauncherAfterClose,
  captureFirstUseLauncherFocusTarget,
  captureQuickCaptureEditableFieldState,
  registerQuickCaptureOutsideClickGuard,
  registerQuickCaptureShortcutHandlers,
  restoreQuickCaptureEditableFieldState
} from "./quick-capture-modal-lifecycle";
import createQuickCaptureModalActions, { type QuickCaptureModalStep } from "./quick-capture-modal-actions";
import {
  appendQuickCapturePastedLinkText,
  buildQuickCaptureBodyInputState,
  clearQuickCaptureLinkAttachment,
  createQuickCaptureLinkImportRequestState,
  extractQuickCapturePastedImages,
  extractQuickCaptureTypedSourceUrl,
  isLatestQuickCaptureLinkImportRequest,
  isQuickCaptureUrlText,
  resolveQuickCaptureLinkImportError,
  resolveQuickCaptureLinkImportSuccess,
  type QuickCaptureLinkImportRequestState,
  type QuickCapturePasteLinkState
} from "./quick-capture-link-import";
import { createQuickCapturePolishService } from "../ai/polish/polish-service";
import {
  normalizeQuickCapturePolishError,
  type QuickCapturePolishErrorCode
} from "../ai/polish/polish-types";
import type { IdeaContentType } from "../domain/idea/idea-model";
import { createToastService } from "../feedback/toast-service";
import { getInterfaceText } from "../i18n/interface-language";
import {
  CREATE_NEW_POOL_ID,
  DEFAULT_POOL_ID
} from "../plugin/constants";
import type GlitterPlugin from "../plugin/GlitterPlugin";
import {
  deriveQuickCaptureStateModel,
  detectQuickCaptureContentKind,
  type QuickCaptureFlowContext,
  type QuickCaptureImportState,
  type QuickCaptureRuntimeState
} from "../ui/write/quick-capture-runtime";
import {
  renderWriteView,
  type WriteTextInputChangeOptions,
  type WriteBodyPastePayload
} from "../ui/write/render-write";
import { buildWriteViewState, type WriteAiPolishState } from "../ui/write/write-state";

// 快速记录流程回调与本地运行时模型。
export interface QuickCaptureSavedSelection {
  poolId?: string;
  poolLabel?: string;
  createFileChecked?: boolean;
}

export interface QuickCaptureFlowHandlers {
  onSaved?: (selection?: QuickCaptureSavedSelection) => void;
  onChoosePool?: () => void;
  onBackHome?: () => void;
  onPoolPickerOpen?: (step?: "choose" | "create") => void;
}

export type { QuickCaptureModalStep } from "./quick-capture-modal-actions";

export interface QuickCaptureModalOptions {
  flowContext?: QuickCaptureFlowContext;
  initialInputText?: string;
  initialTitleText?: string;
  initialHasMedia?: boolean;
  initialImportState?: QuickCaptureImportState;
  initialCreateFileChecked?: boolean;
  initialSelectedPoolId?: string;
  initialSelectedPoolLabel?: string;
}

interface QuickCapturePoolOption {
  id: string;
  label: string;
}

interface QuickCaptureAiPolishSession {
  requestId: number;
  state: Exclude<WriteAiPolishState, "idle">;
  sourceValue: string;
  polishedValue?: string;
  errorMessage?: string;
}

type QuickCaptureEntryMode = "text" | "link" | "media";

// 文件名清理与内容类型转换辅助。
const FIRST_USE_QUICK_CAPTURE_POOL_OPTIONS: QuickCapturePoolOption[] = [];

function createGlobalQuickCapturePoolOptions(language: unknown): QuickCapturePoolOption[] {
  const text = getInterfaceText(language).pool;
  return [
    { id: DEFAULT_POOL_ID, label: text.defaultPoolName },
    { id: CREATE_NEW_POOL_ID, label: text.newPoolLabel }
  ];
}

function resolveQuickCaptureEntryMode(options: QuickCaptureModalOptions): QuickCaptureEntryMode {
  if (options.initialHasMedia) {
    return "media";
  }

  return isQuickCaptureUrlText(options.initialInputText?.trim() ?? "") ? "link" : "text";
}

function resolveIdeaContentTypeForSave(input: {
  entryMode: QuickCaptureEntryMode;
  sourceUrl?: string;
  selectedMedia: SelectedCaptureMedia[];
}): IdeaContentType {
  const hasMedia = input.selectedMedia.length > 0;
  const hasVideo = input.selectedMedia.some(({ file }) => file.type.startsWith("video/"));

  if (hasMedia) {
    if (input.entryMode === "text" && input.sourceUrl) {
      return "link";
    }

    return hasVideo ? "video" : "image";
  }

  if (input.sourceUrl) {
    return "link";
  }

  return "text";
}

const MAX_IMAGE_ATTACHMENTS = 7;

// 快速记录弹窗主流程。
export class QuickCaptureModal extends Modal {
  private static readonly EMPTY_SUBMIT_FEEDBACK_DURATION_MS = 3000;

  private flowContext: QuickCaptureFlowContext = "first-use";

  private captureEntryMode: QuickCaptureEntryMode = "text";

  private runtimePoolOptions: QuickCapturePoolOption[] = this.resolveInitialRuntimePoolOptions("first-use");

  private runtimeState: QuickCaptureRuntimeState | null = null;

  private hasCaptureFieldEdits = false;

  private showingCloseConfirm = false;

  private showingMediaReplaceConfirm = false;

  private showingMediaPreview = false;

  private emptySubmitFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

  private showingEmptySubmitFeedback = false;

  private selectedMedia: SelectedCaptureMedia[] = [];

  private selectedMediaIndex = 0;

  private primaryPastedLink: QuickCapturePasteLinkState | null = null;

  private pendingMediaLinkImport:
    | {
        requestText: string;
        bodyPrefix: string;
        replaceBody: boolean;
      }
    | null = null;

  private linkImportRequestState: QuickCaptureLinkImportRequestState | null = null;

  private nextLinkImportRequestId = 1;

  private unregisterShortcutHandlers?: () => void;

  private unregisterOutsideClickGuard?: () => void;

  private firstUseLauncherFocusTarget: { blur?: () => void } | null = null;

  private nextPoolOptionsRequestId = 0;

  private aiPolishSession: QuickCaptureAiPolishSession | null = null;

  private nextAiPolishRequestId = 1;

  private readonly toastService = createToastService();

  private readonly quickCapturePolishService = createQuickCapturePolishService();

  constructor(
    private readonly plugin: GlitterPlugin,
    private readonly step: QuickCaptureModalStep = "capture",
    private readonly handlers: QuickCaptureFlowHandlers = {},
    private readonly options: QuickCaptureModalOptions = {}
  ) {
    super(plugin.app);
  }

  // 打开时记录来源焦点并初始化当前流程状态。
  override open(): void {
    const nextFlowContext = this.options.flowContext ?? "first-use";
    this.firstUseLauncherFocusTarget = captureFirstUseLauncherFocusTarget(nextFlowContext, {
      containerEl: this.containerEl,
      modalEl: this.modalEl,
      contentEl: this.contentEl
    });

    super.open();
  }

  override onOpen(): void {
    this.flowContext = this.options.flowContext ?? "first-use";
    this.captureEntryMode = resolveQuickCaptureEntryMode(this.options);
    this.runtimePoolOptions = this.resolveInitialRuntimePoolOptions(this.flowContext);
    this.containerEl?.addClass?.("glitter-quick-capture-modal-host");
    this.modalEl?.addClass?.("glitter-quick-capture-modal");
    if (this.flowContext === "first-use") {
      this.modalEl?.addClass?.("glitter-quick-capture-modal--first-use");
    }
    this.contentEl?.addClass?.("glitter-quick-capture-modal__content");
    this.unregisterOutsideClickGuard?.();
    this.unregisterShortcutHandlers?.();
    this.unregisterOutsideClickGuard = registerQuickCaptureOutsideClickGuard({
      containerEl: this.containerEl,
      modalEl: this.modalEl
    });
    this.unregisterShortcutHandlers = registerQuickCaptureShortcutHandlers({
      scope: this.scope,
      step: this.step,
      onClose: () => {
        this.handleCloseAction();
      },
      onSubmit: () => {
        void this.handleSubmit();
      }
    });
    this.runtimeState = this.resolveRuntimeState(this.flowContext);
    this.renderCurrentState();
    if (this.flowContext === "global") {
      void this.refreshGlobalPoolOptions();
    }
  }

  override onClose(): void {
    blurFirstUseLauncherAfterClose(this.flowContext, this.firstUseLauncherFocusTarget);
    this.containerEl?.removeClass?.("glitter-quick-capture-modal-host");
    this.modalEl?.removeClass?.("glitter-quick-capture-modal");
    this.modalEl?.removeClass?.("glitter-quick-capture-modal--first-use");
    this.contentEl?.removeClass?.("glitter-quick-capture-modal__content");
    this.unregisterOutsideClickGuard?.();
    this.unregisterOutsideClickGuard = undefined;
    this.unregisterShortcutHandlers?.();
    this.unregisterShortcutHandlers = undefined;
    this.contentEl?.empty?.();
    releaseSelectedCaptureMediaPreviews(this.selectedMedia);
    this.clearEmptySubmitFeedbackTimer();
    this.runtimeState = null;
    this.hasCaptureFieldEdits = false;
    this.showingCloseConfirm = false;
    this.showingMediaReplaceConfirm = false;
    this.showingMediaPreview = false;
    this.showingEmptySubmitFeedback = false;
    this.selectedMedia = [];
    this.selectedMediaIndex = 0;
    this.primaryPastedLink = null;
    this.pendingMediaLinkImport = null;
    this.linkImportRequestState = null;
    this.aiPolishSession = null;
    this.runtimePoolOptions = this.resolveInitialRuntimePoolOptions(this.flowContext);
    this.firstUseLauncherFocusTarget = null;
  }

  // 全局池选项同步与弹窗级关闭守卫。
  private async refreshGlobalPoolOptions(): Promise<void> {
    const requestId = ++this.nextPoolOptionsRequestId;
    const baselineSelectedPoolId = this.runtimeState?.phase === "capture" ? this.runtimeState.input.selectedPoolId : undefined;
    const baselineSelectedPoolLabel =
      this.runtimeState?.phase === "capture" ? this.runtimeState.input.selectedPoolLabel : undefined;
    const nextPoolOptions = await this.resolveRuntimePoolOptions(this.flowContext);

    if (requestId !== this.nextPoolOptionsRequestId) {
      return;
    }

    this.runtimePoolOptions = nextPoolOptions;

    if (this.runtimeState?.phase === "capture") {
      const currentInput = this.runtimeState.input;
      const selectedPoolId = currentInput.selectedPoolId;
      const selectedOption = selectedPoolId
        ? this.runtimePoolOptions.find((option) => option.id === selectedPoolId)
        : undefined;
      const fallbackOption = this.runtimePoolOptions.find((option) => option.id === DEFAULT_POOL_ID);
      const nextSelectedOption =
        selectedOption ??
        fallbackOption ??
        this.runtimePoolOptions.find((option) => option.id !== CREATE_NEW_POOL_ID);
      const selectionChangedDuringRequest =
        currentInput.selectedPoolId !== baselineSelectedPoolId ||
        currentInput.selectedPoolLabel !== baselineSelectedPoolLabel;

      this.runtimeState = {
        ...this.runtimeState,
        input: {
          ...currentInput,
          selectedPoolId: selectionChangedDuringRequest && selectedPoolId ? selectedPoolId : nextSelectedOption?.id,
          selectedPoolLabel:
            selectionChangedDuringRequest && selectedPoolId ? currentInput.selectedPoolLabel : nextSelectedOption?.label
        }
      };
    }

    this.renderCurrentState();
  }

  // 键盘快捷键与关闭行为。
  private handleCloseAction(): void {
    if (this.showingMediaReplaceConfirm) {
      this.dismissMediaReplaceConfirm();
      return;
    }

    if (this.showingMediaPreview) {
      this.showingMediaPreview = false;
      this.renderCurrentState();
      return;
    }

    if (this.runtimeState?.phase === "saving") {
      return;
    }

    if (this.runtimeState?.phase === "save-failed") {
      this.close();
      return;
    }

    if (this.step === "capture") {
      if (!this.hasCaptureFieldEdits) {
        this.close();
        return;
      }

      this.showingCloseConfirm = true;
      if (this.runtimeState?.phase === "capture" && this.runtimeState.input.poolDropdownVisible) {
        this.runtimeState = {
          ...this.runtimeState,
          input: {
            ...this.runtimeState.input,
            poolDropdownVisible: false
          }
        };
      }
      this.renderCurrentState();
      return;
    }

    this.close();
    if (this.step === "saved-feedback" && this.flowContext === "first-use") {
      this.handlers.onBackHome?.();
    }
  }

  private retrySaveFailed(): void {
    if (!this.runtimeState || this.runtimeState.phase !== "save-failed" || this.runtimeState.flowContext !== "global") {
      return;
    }

    this.setRuntimeState({
      ...this.runtimeState,
      phase: "capture"
    });
    this.renderCurrentState();
  }

  private handleSavedFeedbackSecondaryAction(): void {
    this.close();
    this.handlers.onSaved?.();
  }

  private setRuntimeState(nextState: QuickCaptureRuntimeState): void {
    this.runtimeState = nextState;
  }

  private shouldShowAiPolishTrigger(flowContext: QuickCaptureFlowContext = this.flowContext): boolean {
    return flowContext === "global" && this.plugin.settings.ai?.quickCapturePolishEnabled !== false;
  }

  private hasAiPolishConfig(): boolean {
    const aiSettings = this.plugin.settings.ai;
    return (
      aiSettings?.enabled === true &&
      this.shouldShowAiPolishTrigger() &&
      (aiSettings?.baseUrl?.trim()?.length ?? 0) > 0 &&
      (aiSettings?.model?.trim()?.length ?? 0) > 0 &&
      (aiSettings?.apiKey?.trim()?.length ?? 0) > 0
    );
  }

  private openPluginSettings(): void {
    const setting = (this.plugin.app as {
      setting?: {
        open?: () => void;
        openTabById?: (id: string) => void;
      };
    }).setting;
    const manifestId = (this.plugin as { manifest?: { id?: string } }).manifest?.id;

    setting?.open?.();
    if (manifestId) {
      setting?.openTabById?.(manifestId);
    }
  }

  private clearAiPolishSession(): void {
    this.aiPolishSession = null;
  }

  private isLatestAiPolishRequest(requestId: number): boolean {
    return this.aiPolishSession?.requestId === requestId;
  }

  private doesAiPolishResultMatchCurrentSource(): boolean {
    if (!this.runtimeState || this.runtimeState.phase !== "capture" || !this.aiPolishSession) {
      return false;
    }

    return this.runtimeState.input.text === this.aiPolishSession.sourceValue;
  }

  private resolveAiPolishErrorMessage(code: QuickCapturePolishErrorCode): string {
    const text = getInterfaceText(this.plugin.settings?.interfaceLanguage).write.aiPolishErrors;
    return text[code] ?? text.default;
  }

  private async requestAiPolish(sourceValue: string): Promise<void> {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    const requestId = this.nextAiPolishRequestId++;
    this.aiPolishSession = {
      requestId,
      state: "loading",
      sourceValue
    };
    this.renderCurrentState();

    try {
      const polishedValue = await this.quickCapturePolishService.polishText(sourceValue, this.plugin.settings);
      if (!this.isLatestAiPolishRequest(requestId) || !this.runtimeState || this.runtimeState.phase !== "capture") {
        return;
      }

      this.aiPolishSession = {
        requestId,
        state: "reviewing",
        sourceValue,
        polishedValue
      };
      this.renderCurrentState();
    } catch (error) {
      if (!this.isLatestAiPolishRequest(requestId) || !this.runtimeState || this.runtimeState.phase !== "capture") {
        return;
      }

      const normalizedError = normalizeQuickCapturePolishError(error);
      if (normalizedError.code === "missing-config") {
        this.clearAiPolishSession();
        this.renderCurrentState();
        this.openPluginSettings();
        return;
      }

      this.aiPolishSession = {
        requestId,
        state: "error",
        sourceValue,
        errorMessage: this.resolveAiPolishErrorMessage(normalizedError.code)
      };
      this.renderCurrentState();
    }
  }

  private async handleAiPolishStart(): Promise<void> {
    if (!this.runtimeState || this.runtimeState.phase !== "capture" || !this.shouldShowAiPolishTrigger()) {
      return;
    }

    if (!this.hasAiPolishConfig()) {
      this.openPluginSettings();
      return;
    }

    await this.requestAiPolish(this.runtimeState.input.text);
  }

  private async handleAiPolishRedo(): Promise<void> {
    if (!this.runtimeState || this.runtimeState.phase !== "capture" || !this.shouldShowAiPolishTrigger()) {
      return;
    }

    if (!this.hasAiPolishConfig()) {
      this.openPluginSettings();
      return;
    }

    await this.requestAiPolish(this.runtimeState.input.text);
  }

  private handleAiPolishAccept(): void {
    if (
      !this.runtimeState ||
      this.runtimeState.phase !== "capture" ||
      this.aiPolishSession?.state !== "reviewing" ||
      this.aiPolishSession.polishedValue === undefined ||
      !this.doesAiPolishResultMatchCurrentSource()
    ) {
      return;
    }

    this.hasCaptureFieldEdits = true;
    this.runtimeState = {
      ...this.runtimeState,
      input: {
        ...this.runtimeState.input,
        text: this.aiPolishSession.polishedValue
      }
    };
    this.clearAiPolishSession();
    this.renderCurrentState();
  }

  private handleAiPolishBackToEditing(): void {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    this.clearAiPolishSession();
    this.renderCurrentState();
  }

  private createNewPoolFromQuickCapture(): void {
    this.openPoolCreateModal();
  }

  private reopenPoolPicker(): void {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    this.setRuntimeState({
      ...this.runtimeState,
      input: {
        ...this.runtimeState.input,
        poolDropdownVisible: true
      }
    });
    this.renderCurrentState();
  }

  private async handleQuickCapturePoolCreated(poolId: string, poolName?: string): Promise<void> {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    const optimisticPoolLabel = poolName?.trim() || getInterfaceText(this.plugin.settings?.interfaceLanguage).pool.newPoolLabel;

    this.setRuntimeState({
      ...this.runtimeState,
      input: {
        ...this.runtimeState.input,
        selectedPoolId: poolId,
        selectedPoolLabel: optimisticPoolLabel,
        poolDropdownVisible: false
      }
    });
    this.renderCurrentState();

    const requestId = ++this.nextPoolOptionsRequestId;
    const baselineSelectedPoolId = poolId;
    const baselineSelectedPoolLabel = optimisticPoolLabel;
    let nextPoolOptions = this.runtimePoolOptions;
    try {
      nextPoolOptions = await this.resolveRuntimePoolOptions("global");
    } catch {
      nextPoolOptions = this.runtimePoolOptions;
    }

    if (requestId !== this.nextPoolOptionsRequestId) {
      return;
    }

    let selectedPoolLabel = poolName?.trim() || nextPoolOptions.find((option) => option.id === poolId)?.label;
    if (!selectedPoolLabel) {
      try {
        selectedPoolLabel = (await this.plugin.poolService.getPool(poolId))?.name?.trim() || undefined;
      } catch {
        selectedPoolLabel = undefined;
      }
    }

    if (selectedPoolLabel && !nextPoolOptions.some((option) => option.id === poolId)) {
      const createNewPoolOption = nextPoolOptions.find((option) => option.id === CREATE_NEW_POOL_ID);
      nextPoolOptions = [
        ...nextPoolOptions.filter((option) => option.id !== CREATE_NEW_POOL_ID),
        {
          id: poolId,
          label: selectedPoolLabel
        },
        ...(createNewPoolOption ? [createNewPoolOption] : [])
      ];
    }

    this.runtimePoolOptions = nextPoolOptions;

    const latestState = this.runtimeState;
    if (!latestState || latestState.phase !== "capture") {
      return;
    }

    const selectionChangedDuringRequest =
      latestState.input.selectedPoolId !== baselineSelectedPoolId ||
      latestState.input.selectedPoolLabel !== baselineSelectedPoolLabel;
    if (selectionChangedDuringRequest) {
      this.renderCurrentState();
      return;
    }

    this.setRuntimeState({
      ...latestState,
      input: {
        ...latestState.input,
        selectedPoolId: poolId,
        selectedPoolLabel: selectedPoolLabel ?? latestState.input.selectedPoolLabel ?? getInterfaceText(this.plugin.settings?.interfaceLanguage).pool.newPoolLabel,
        poolDropdownVisible: false
      }
    });
    this.renderCurrentState();
  }

  private togglePoolPicker(): void {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    this.setRuntimeState({
      ...this.runtimeState,
      input: {
        ...this.runtimeState.input,
        poolDropdownVisible: !(this.runtimeState.input.poolDropdownVisible ?? false)
      }
    });
    this.renderCurrentState();
  }

  private selectPool(poolId: string): void {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    if (poolId === CREATE_NEW_POOL_ID) {
      this.createNewPoolFromQuickCapture();
      return;
    }

    const selectedPool = this.runtimePoolOptions.find((option) => option.id === poolId);
    if (!selectedPool) {
      return;
    }

    this.setRuntimeState({
      ...this.runtimeState,
      input: {
        ...this.runtimeState.input,
        selectedPoolId: selectedPool.id,
        selectedPoolLabel: selectedPool.label,
        poolDropdownVisible: false
      }
    });
    this.renderCurrentState();
  }

  private handleTitleInputChange(value: string, options: WriteTextInputChangeOptions = {}): void {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    this.hasCaptureFieldEdits = true;
    this.runtimeState = {
      ...this.runtimeState,
      input: {
        ...this.runtimeState.input,
        title: value,
        hasManualTitle: true
      }
    };

    if (options.isComposing) {
      return;
    }

    this.renderCurrentState();
  }

  private toggleCreateFileChecked(checked: boolean): void {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    if ((this.runtimeState.input.createFileChecked ?? false) === checked) {
      return;
    }

    this.runtimeState = {
      ...this.runtimeState,
      input: {
        ...this.runtimeState.input,
        createFileChecked: checked
      }
    };

    this.renderCurrentState();
  }

  private showMediaPreview(): void {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    this.showingMediaPreview = true;
    this.showingCloseConfirm = false;
    this.renderCurrentState();
  }

  private hideMediaPreview(): void {
    if (!this.showingMediaPreview) {
      return;
    }

    this.showingMediaPreview = false;
    this.renderCurrentState();
  }

  private promptMediaReplaceConfirm(requestText: string, bodyPrefix: string): void {
    this.pendingMediaLinkImport = {
      requestText,
      bodyPrefix,
      replaceBody: false
    };
    this.showingMediaReplaceConfirm = true;
    this.showingCloseConfirm = false;
    this.showingMediaPreview = false;
    this.renderCurrentState();
  }

  private dismissMediaReplaceConfirm(): void {
    if (!this.showingMediaReplaceConfirm) {
      return;
    }

    this.showingMediaReplaceConfirm = false;
    this.pendingMediaLinkImport = null;
    this.renderCurrentState();
  }

  private cancelMediaReplaceConfirm(): void {
    if (!this.showingMediaReplaceConfirm) {
      return;
    }

    this.dismissMediaReplaceConfirm();
    this.toastService.show({
      status: "info",
      message: getInterfaceText(this.plugin.settings?.interfaceLanguage).write.replaceMediaWithLinkCancelled
    });
  }

  private async confirmMediaReplaceConfirm(): Promise<void> {
    if (!this.showingMediaReplaceConfirm || !this.pendingMediaLinkImport) {
      return;
    }

    const pendingImport = this.pendingMediaLinkImport;
    this.showingMediaReplaceConfirm = false;
    this.pendingMediaLinkImport = null;
    await this.startLinkImport(pendingImport);
  }

  private clearEmptySubmitFeedbackIfVisible(): void {
    if (!this.showingEmptySubmitFeedback) {
      return;
    }

    this.showingEmptySubmitFeedback = false;
    this.clearEmptySubmitFeedbackTimer();
  }

  private async pickMediaFiles(options: PickQuickCaptureAttachmentFilesOptions = {}): Promise<File[]> {
    this.clearEmptySubmitFeedbackIfVisible();
    const files = await pickQuickCaptureAttachmentFiles(this.contentEl, options);

    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return [];
    }

    return files;
  }

  private revokeSelectedMediaPreview(selectedMedia?: SelectedCaptureMedia): void {
    if (!selectedMedia?.previewUrl || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
      return;
    }

    URL.revokeObjectURL(selectedMedia.previewUrl);
  }

  private syncRuntimeStateForMediaSelection(): void {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    this.clearAiPolishSession();
    this.runtimeState = {
      ...this.runtimeState,
      input: {
        ...this.runtimeState.input,
        hasMedia: this.selectedMedia.length > 0,
        importState: this.runtimeState.input.importState ?? "idle"
      }
    };
  }

  private navigateSelectedMedia(offset: -1 | 1): void {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    if (this.getSelectedMediaOverlayMode() !== "image-gallery") {
      return;
    }

    const currentSelectedMediaIndex = this.clampSelectedMediaIndex();
    const nextSelectedMediaIndex = Math.max(
      0,
      Math.min(currentSelectedMediaIndex + offset, this.selectedMedia.length - 1)
    );
    if (nextSelectedMediaIndex === currentSelectedMediaIndex) {
      return;
    }

    this.selectedMediaIndex = nextSelectedMediaIndex;
    this.renderCurrentState();
  }

  private handleMediaNavigatePrevious(): void {
    this.navigateSelectedMedia(-1);
  }

  private handleMediaNavigateNext(): void {
    this.navigateSelectedMedia(1);
  }

  private appendSelectedImageFiles(
    imageFiles: File[]
  ): "appended" | "blocked-by-video" | "limit-reached" | "no-images" | "inactive" {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return "inactive";
    }

    const mediaOverlayMode = this.getSelectedMediaOverlayMode();
    if (this.selectedMedia.length > 0 && mediaOverlayMode !== "image-gallery") {
      return "blocked-by-video";
    }

    const remainingSlots = MAX_IMAGE_ATTACHMENTS - this.selectedMedia.length;
    if (remainingSlots <= 0) {
      return "limit-reached";
    }

    const nextImageFiles = imageFiles.filter((file) => file.type.startsWith("image/")).slice(0, remainingSlots);
    if (nextImageFiles.length === 0) {
      return "no-images";
    }

    const firstNewSelectedMediaIndex = this.selectedMedia.length;
    this.hasCaptureFieldEdits = true;
    this.selectedMedia = [...this.selectedMedia, ...nextImageFiles.map((file) => createSelectedCaptureMedia(file))];
    this.selectedMediaIndex = firstNewSelectedMediaIndex;
    this.showingMediaPreview = false;
    this.syncRuntimeStateForMediaSelection();
    this.renderCurrentState();
    return "appended";
  }

  private async handleMediaAddAttachment(): Promise<void> {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    if (this.getSelectedMediaOverlayMode() !== "image-gallery") {
      return;
    }

    const remainingSlots = MAX_IMAGE_ATTACHMENTS - this.selectedMedia.length;
    if (remainingSlots <= 0) {
      return;
    }

    const pickedFiles = await this.pickMediaFiles({
      accept: "image/*",
      multiple: true
    });
    this.appendSelectedImageFiles(pickedFiles);
  }

  private replaceCurrentSelectedMedia(
    replacementMedia: SelectedCaptureMedia,
    mediaOverlayMode: "image-gallery" | "video"
  ): void {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    const currentSelectedMediaIndex = this.clampSelectedMediaIndex();
    const currentSelectedMedia = this.selectedMedia[currentSelectedMediaIndex];
    if (!currentSelectedMedia) {
      return;
    }

    this.hasCaptureFieldEdits = true;
    this.revokeSelectedMediaPreview(currentSelectedMedia);

    if (mediaOverlayMode === "video") {
      this.selectedMedia = [replacementMedia];
      this.selectedMediaIndex = 0;
    } else {
      const nextSelectedMedia = [...this.selectedMedia];
      nextSelectedMedia[currentSelectedMediaIndex] = replacementMedia;
      this.selectedMedia = nextSelectedMedia;
      this.selectedMediaIndex = currentSelectedMediaIndex;
    }

    if (replacementMedia.previewKind !== "image" || !replacementMedia.previewUrl) {
      this.showingMediaPreview = false;
    }

    this.syncRuntimeStateForMediaSelection();
    this.renderCurrentState();
  }

  private async handleMediaReplaceAttachment(): Promise<void> {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    const mediaOverlayMode = this.getSelectedMediaOverlayMode();
    if (mediaOverlayMode === "image-gallery") {
      const pickedFiles = await this.pickMediaFiles({
        accept: "image/*",
        multiple: false
      });
      const nextImageFile = pickedFiles.find((file) => file.type.startsWith("image/"));
      if (!nextImageFile) {
        return;
      }

      this.replaceCurrentSelectedMedia(createSelectedCaptureMedia(nextImageFile), mediaOverlayMode);
      return;
    }

    if (mediaOverlayMode !== "video") {
      return;
    }

    const pickedFiles = await this.pickMediaFiles({
      accept: "video/*",
      multiple: false
    });
    const nextVideoFile = pickedFiles.find((file) => file.type.startsWith("video/"));
    if (!nextVideoFile) {
      return;
    }

    this.replaceCurrentSelectedMedia(createSelectedCaptureMedia(nextVideoFile), mediaOverlayMode);
  }

  private resumeCapture(): void {
    this.showingCloseConfirm = false;
    this.renderCurrentState();
  }

  private handleCapturePromptSecondaryAction(): void {
    if (this.showingMediaReplaceConfirm) {
      this.cancelMediaReplaceConfirm();
      return;
    }

    this.resumeCapture();
  }

  private async handleCapturePromptPrimaryAction(): Promise<void> {
    if (this.showingMediaReplaceConfirm) {
      await this.confirmMediaReplaceConfirm();
      return;
    }

    this.close();
  }

  private resolveSecondaryAction(): (() => void) | undefined {
    if (this.runtimeState?.phase === "save-failed" && this.flowContext === "global") {
      return () => {
        this.retrySaveFailed();
      };
    }

    if (this.step === "saved-feedback" && this.flowContext === "global") {
      return () => {
        this.handleSavedFeedbackSecondaryAction();
      };
    }

    return undefined;
  }

  private clampSelectedMediaIndex(index = this.selectedMediaIndex): number {
    if (this.selectedMedia.length === 0) {
      this.selectedMediaIndex = 0;
      return 0;
    }

    const clampedIndex = Math.max(0, Math.min(index, this.selectedMedia.length - 1));
    this.selectedMediaIndex = clampedIndex;
    return clampedIndex;
  }

  private getCurrentSelectedMedia(): SelectedCaptureMedia | undefined {
    if (this.selectedMedia.length === 0) {
      this.selectedMediaIndex = 0;
      return undefined;
    }

    return this.selectedMedia[this.clampSelectedMediaIndex()];
  }

  private getSelectedMediaOverlayMode(): "image-gallery" | "video" | undefined {
    if (this.selectedMedia.length === 0) {
      return undefined;
    }

    if (this.selectedMedia.every(({ file }) => file.type.startsWith("image/"))) {
      return "image-gallery";
    }

    const [firstSelectedMedia] = this.selectedMedia;
    if (this.selectedMedia.length === 1 && firstSelectedMedia?.file.type.startsWith("video/")) {
      return "video";
    }

    return undefined;
  }

  private handleMediaPreviewOpen(): void {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    const currentSelectedMedia = this.getCurrentSelectedMedia();
    if (!currentSelectedMedia?.previewUrl || currentSelectedMedia.previewKind !== "image") {
      return;
    }

    this.showMediaPreview();
  }

  private handleMediaPreviewClose(): void {
    this.hideMediaPreview();
  }

  // 运行时状态到渲染层状态的适配与事件绑定。
  private renderCurrentState(): void {
    if (!this.runtimeState) {
      return;
    }

    const activeEditableFieldState = captureQuickCaptureEditableFieldState(this.contentEl);
    const model = deriveQuickCaptureStateModel(this.runtimeState, {
      attachedMediaLabels: this.selectedMedia.map(({ file }) => file.name),
      interfaceLanguage: this.plugin.settings?.interfaceLanguage
    });
    const selectedMediaIndex = this.clampSelectedMediaIndex();
    const currentSelectedMedia = this.getCurrentSelectedMedia();
    const mediaOverlayMode = this.getSelectedMediaOverlayMode();
    const isImageGallery = mediaOverlayMode === "image-gallery";
    const isAiPolishAvailableInFlow = this.shouldShowAiPolishTrigger(this.flowContext);
    const state = buildWriteViewState({
      ...model,
      aiPolishVisible: isAiPolishAvailableInFlow,
      aiPolishState: isAiPolishAvailableInFlow ? this.aiPolishSession?.state : undefined,
      aiPolishSourceValue: isAiPolishAvailableInFlow ? this.aiPolishSession?.sourceValue : undefined,
      aiPolishPolishedValue: isAiPolishAvailableInFlow ? this.aiPolishSession?.polishedValue : undefined,
      aiPolishErrorMessage: isAiPolishAvailableInFlow ? this.aiPolishSession?.errorMessage : undefined,
      attachedMediaCount: this.selectedMedia.length,
      attachedMediaLabels: this.selectedMedia.map(({ file }) => file.name),
      attachedMediaPreviewUrl: currentSelectedMedia?.previewUrl,
      attachedMediaPreviewKind: currentSelectedMedia?.previewKind,
      mediaOverlayMode,
      selectedMediaIndex,
      canSelectPreviousMedia: isImageGallery && selectedMediaIndex > 0,
      canSelectNextMedia: isImageGallery && selectedMediaIndex < this.selectedMedia.length - 1,
      canAddMoreImages: isImageGallery && this.selectedMedia.length < MAX_IMAGE_ATTACHMENTS,
      mediaPreviewVisible: this.showingMediaPreview,
      closeConfirmVisible: this.showingCloseConfirm && this.step === "capture",
      mediaReplaceConfirmVisible: this.showingMediaReplaceConfirm && this.step === "capture",
      emptySubmitFeedbackVisible: this.showingEmptySubmitFeedback && this.step === "capture",
      hasCaptureFieldEdits: this.hasCaptureFieldEdits,
      poolOptions: this.runtimePoolOptions,
      interfaceLanguage: this.plugin.settings?.interfaceLanguage
    });

    renderWriteView(
      this.contentEl,
      state,
      createQuickCaptureModalActions({
        onClose: () => {
          this.handleCloseAction();
        },
        onSubmit: () => {
          return this.handleSubmit();
        },
        onSecondaryAction: this.resolveSecondaryAction(),
        onPoolPickerToggle: () => {
          this.togglePoolPicker();
        },
        onPoolSelect: (poolId) => {
          this.selectPool(poolId);
        },
        onBodyInputChange: (value, options) => {
          this.handleBodyInputChange(value, options);
        },
        onBodyPaste: (payload) => {
          return this.handleBodyPaste(payload);
        },
        onTitleInputChange: (value, options) => {
          this.handleTitleInputChange(value, options);
        },
        onAttachmentPick: () => {
          return this.pickAttachmentFiles();
        },
        onRemoveMediaAttachment: () => {
          this.removeSelectedMediaAttachment();
        },
        onRemoveLinkAttachment: () => {
          this.removeLinkAttachment();
        },
        onMediaNavigatePrevious: () => {
          this.handleMediaNavigatePrevious();
        },
        onMediaNavigateNext: () => {
          this.handleMediaNavigateNext();
        },
        onMediaAddAttachment: () => {
          return this.handleMediaAddAttachment();
        },
        onMediaReplaceAttachment: () => {
          return this.handleMediaReplaceAttachment();
        },
        onCreateFileToggle: (checked) => {
          this.toggleCreateFileChecked(checked);
        },
        onMediaPreviewOpen: () => {
          this.handleMediaPreviewOpen();
        },
        onMediaPreviewClose: () => {
          this.handleMediaPreviewClose();
        },
        onResumeCapture: () => {
          this.handleCapturePromptSecondaryAction();
        },
        onConfirmClose: () => {
          return this.handleCapturePromptPrimaryAction();
        },
        onAiPolishStart: () => {
          return this.handleAiPolishStart();
        },
        onAiPolishRedo: () => {
          return this.handleAiPolishRedo();
        },
        onAiPolishAccept: () => {
          this.handleAiPolishAccept();
        },
        onAiPolishBackToEditing: () => {
          this.handleAiPolishBackToEditing();
        }
      })
    );

    restoreQuickCaptureEditableFieldState(this.contentEl, activeEditableFieldState);
  }

  // 提交保存并根据流程上下文决定下一步。
  private async handleSubmit(): Promise<void> {
    if (this.step === "saved-feedback") {
      this.close();
      if (this.flowContext === "first-use") {
        this.handlers.onChoosePool?.();
        return;
      }

      this.handlers.onBackHome?.();
      return;
    }

    if (!this.runtimeState || (this.runtimeState.phase !== "capture" && this.runtimeState.phase !== "save-failed")) {
      return;
    }

    if (this.showingMediaReplaceConfirm) {
      return;
    }

    if ((this.runtimeState.input.importState ?? "idle") === "loading") {
      return;
    }

    if (this.runtimeState.phase === "capture" && this.aiPolishSession) {
      return;
    }

    const submissionState = this.runtimeState;
    const submissionModel = deriveQuickCaptureStateModel(submissionState, {
      attachedMediaLabels: this.selectedMedia.map(({ file }) => file.name),
      interfaceLanguage: this.plugin.settings?.interfaceLanguage
    });
    if (this.isEmptySubmission(submissionModel)) {
      this.showEmptySubmitFeedback();
      return;
    }

    if (this.flowContext === "global") {
      this.runtimeState = {
        ...submissionState,
        phase: "saving"
      };
      this.renderCurrentState();
    }

    try {
      const savedMediaPaths = await this.saveSelectedMediaFiles();
      const model = submissionModel;
      const sourceUrl = this.runtimeState.input.sourceUrl;
      const contentType = resolveIdeaContentTypeForSave({
        entryMode: this.captureEntryMode,
        sourceUrl,
        selectedMedia: this.selectedMedia
      });
      const linkBody = model.inputText;

      if (this.flowContext === "first-use") {
        await this.plugin.firstUseWorkflow.stageFirstIdeaDraft({
          title: model.titleText,
          body: linkBody,
          contentType,
          sourceType: "quick-capture",
          sourceUrl,
          attachmentPaths: savedMediaPaths,
          createFileChecked: model.createFileChecked,
          tags: []
        });
      } else {
        await this.plugin.quickCaptureWorkflow.saveGlobalDraft({
          title: model.titleText,
          body: linkBody,
          contentType,
          sourceUrl,
          attachmentPaths: savedMediaPaths,
          createFileChecked: model.createFileChecked,
          poolId: model.selectedPoolId,
          tags: []
        });
      }

      if (this.flowContext === "global" && this.runtimeState?.phase !== "saving") {
        return;
      }

      const savedSelection =
        this.flowContext === "global"
          ? {
              poolId: model.selectedPoolId,
              poolLabel: model.selectedPoolLabel,
              createFileChecked: model.createFileChecked
            }
          : undefined;

      this.close();
      this.handlers.onSaved?.(savedSelection);
    } catch (error) {
      if (this.flowContext === "global") {
        this.runtimeState = {
          ...submissionState,
          phase: "save-failed"
        };
        this.renderCurrentState();
        return;
      }

      const text = getInterfaceText(this.plugin.settings?.interfaceLanguage);
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : text.write.attachmentSaveFailed;
      this.toastService.show({
        status: "error",
        message
      });
    }
  }

  // 正文输入、粘贴与链接识别联动。
  private handleBodyInputChange(value: string, options: WriteTextInputChangeOptions = {}): void {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    this.hasCaptureFieldEdits = true;

    if (this.showingEmptySubmitFeedback) {
      this.showingEmptySubmitFeedback = false;
      this.clearEmptySubmitFeedbackTimer();
    }

    const hadSourceUrl = Boolean(this.runtimeState.input.sourceUrl);
    const { typedSourceUrl, nextInput, shouldRenderImmediately } = buildQuickCaptureBodyInputState({
      runtimeInput: this.runtimeState.input,
      value,
      primaryPastedLink: this.primaryPastedLink
    });

    this.runtimeState = {
      ...this.runtimeState,
      input: nextInput
    };

    if (options.isComposing) {
      return;
    }

    if (shouldRenderImmediately) {
      this.renderCurrentState();
    }

    if (this.primaryPastedLink) {
      if (!nextInput.sourceUrl) {
        this.primaryPastedLink = null;
        this.linkImportRequestState = null;
      } else if (typedSourceUrl) {
        this.runtimeState = {
          ...this.runtimeState,
          input: {
            ...this.runtimeState.input,
            text: value,
            sourceUrl: this.primaryPastedLink.sourceUrl,
            importedExcerpt: this.primaryPastedLink.excerpt,
            importState: "idle"
          }
        };
        this.renderCurrentState();
      }
      return;
    }

    if (typedSourceUrl && !hadSourceUrl) {
      void this.startLinkImport({
        requestText: typedSourceUrl,
        bodyPrefix: nextInput.text,
        replaceBody: false
      });
      return;
    }

    if (nextInput.sourceUrl) {
      return;
    }

    this.linkImportRequestState = null;
    if ((this.runtimeState.input.importState ?? "idle") !== "idle") {
      this.runtimeState = {
        ...this.runtimeState,
        input: {
          ...this.runtimeState.input,
          importState: "idle"
        }
      };
      this.renderCurrentState();
    }
  }

  private async handleBodyPaste(payload: WriteBodyPastePayload): Promise<void> {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    const currentKind = detectQuickCaptureContentKind(this.runtimeState.input);
    const text = getInterfaceText(this.plugin.settings?.interfaceLanguage);
    const pastedImages = extractQuickCapturePastedImages(payload.items);

    if (pastedImages.length > 0) {
      payload.preventDefault();
      if (this.captureEntryMode === "link") {
        this.toastService.show({
          status: "info",
          message: text.write.mediaAlreadyLink
        });
        return;
      }

      const appendResult = this.appendSelectedImageFiles(pastedImages);
      if (appendResult === "blocked-by-video") {
        this.toastService.show({
          status: "info",
          message: text.write.mediaAlreadyVideo
        });
      } else if (appendResult === "limit-reached") {
        this.toastService.show({
          status: "info",
          message: text.write.mediaImageLimitReached(MAX_IMAGE_ATTACHMENTS)
        });
      }
      return;
    }

    const pastedText = payload.text.trim();
    if (!pastedText) {
      return;
    }

    if (currentKind === "media" && !isQuickCaptureUrlText(pastedText)) {
      return;
    }

    if (!isQuickCaptureUrlText(pastedText)) {
      return;
    }

    this.hasCaptureFieldEdits = true;

    if (currentKind === "media" && this.selectedMedia.length > 0 && !this.runtimeState.input.sourceUrl) {
      payload.preventDefault();
      this.promptMediaReplaceConfirm(pastedText, this.runtimeState.input.text.trim());
      return;
    }

    if (this.runtimeState.input.sourceUrl) {
      payload.preventDefault();
      if (this.captureEntryMode === "link") {
        this.toastService.show({
          status: "info",
          message: text.write.secondLinkBlockedInLinkCapture
        });
        return;
      }

      this.runtimeState = {
        ...this.runtimeState,
        input: appendQuickCapturePastedLinkText(this.runtimeState.input, pastedText)
      };
      this.renderCurrentState();
      return;
    }

    payload.preventDefault();
    const existingText = this.runtimeState.input.text.trim();

    this.runtimeState = {
      ...this.runtimeState,
      input: {
        ...this.runtimeState.input,
        importState: "loading",
        sourceUrl: pastedText,
        suspendInlineUrlAutoDetection: false
      }
    };
    this.renderCurrentState();

    await this.startLinkImport({
      requestText: pastedText,
      bodyPrefix: existingText,
      replaceBody: false
    });
  }

  // 链接导入请求管理与结果回填。
  private async startLinkImport(options: { requestText?: string; bodyPrefix?: string; replaceBody?: boolean } = {}): Promise<void> {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    const trimmedInput = (options.requestText ?? this.runtimeState.input.text).trim();
    if (!trimmedInput) {
      return;
    }

    const requestSourceUrl =
      options.requestText?.trim() ||
      extractQuickCaptureTypedSourceUrl(trimmedInput) ||
      this.runtimeState.input.sourceUrl;
    if (!requestSourceUrl) {
      return;
    }

    const requestId = this.nextLinkImportRequestId++;
    const requestState = createQuickCaptureLinkImportRequestState({
      requestId,
      inputText: trimmedInput,
      bodyPrefix: options.bodyPrefix,
      replaceBody: options.replaceBody
    });
    this.linkImportRequestState = requestState;

    this.runtimeState = {
      ...this.runtimeState,
      input: {
        ...this.runtimeState.input,
        sourceUrl: requestSourceUrl,
        importState: "loading"
      }
    };
    this.renderCurrentState();

    try {
      const imported = await this.plugin.linkImportService.importFromInput(requestSourceUrl);
      if (!isLatestQuickCaptureLinkImportRequest(this.linkImportRequestState, requestId, trimmedInput)) {
        return;
      }

      if (!this.runtimeState || this.runtimeState.phase !== "capture") {
        return;
      }

      const resolvedState = resolveQuickCaptureLinkImportSuccess({
        runtimeInput: this.runtimeState.input,
        imported,
        bodyPrefix: requestState.bodyPrefix,
        replaceBody: requestState.replaceBody
      });
      this.primaryPastedLink = resolvedState.primaryPastedLink;
      this.runtimeState = {
        ...this.runtimeState,
        input: resolvedState.nextInput
      };

      this.renderCurrentState();

      if (imported.mediaCandidates.length > 0 && this.captureEntryMode !== "link") {
        void this.applyImportedLinkMedia(imported.mediaCandidates, {
          requestId,
          requestText: trimmedInput
        });
      }
    } catch {
      if (!isLatestQuickCaptureLinkImportRequest(this.linkImportRequestState, requestId, trimmedInput)) {
        return;
      }

      if (!this.runtimeState || this.runtimeState.phase !== "capture") {
        return;
      }

      this.runtimeState = {
        ...this.runtimeState,
        input: resolveQuickCaptureLinkImportError({
          runtimeInput: this.runtimeState.input,
          requestSourceUrl
        })
      };
      this.renderCurrentState();
    }
  }

  private async applyImportedLinkMedia(
    mediaCandidates: QuickCaptureImportedMediaCandidate[],
    request: { requestId: number; requestText: string }
  ): Promise<void> {
    try {
      const importedMedia = await createSelectedCaptureMediaFromImportedCandidates(mediaCandidates);
      if (importedMedia.length === 0) {
        return;
      }

      if (!isLatestQuickCaptureLinkImportRequest(this.linkImportRequestState, request.requestId, request.requestText)) {
        releaseSelectedCaptureMediaPreviews(importedMedia);
        return;
      }

      if (!this.runtimeState || this.runtimeState.phase !== "capture" || this.captureEntryMode === "link") {
        releaseSelectedCaptureMediaPreviews(importedMedia);
        return;
      }

      releaseSelectedCaptureMediaPreviews(this.selectedMedia);
      this.selectedMedia = importedMedia;
      this.selectedMediaIndex = 0;
      this.showingMediaPreview = false;
      this.syncRuntimeStateForMediaSelection();
      this.renderCurrentState();
    } catch {
      return;
    }
  }

  // 附件预览与媒体资源管理。
  private removeSelectedMediaAttachment(): void {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    const currentSelectedMediaIndex = this.clampSelectedMediaIndex();
    const removedMedia = this.selectedMedia[currentSelectedMediaIndex];
    if (!removedMedia) {
      return;
    }

    this.hasCaptureFieldEdits = true;
    this.revokeSelectedMediaPreview(removedMedia);

    const remainingSelectedMedia = this.selectedMedia.filter((_, index) => index !== currentSelectedMediaIndex);
    this.selectedMedia = remainingSelectedMedia;

    if (remainingSelectedMedia.length === 0) {
      this.selectedMediaIndex = 0;
      this.showingMediaPreview = false;
      this.runtimeState = {
        ...this.runtimeState,
        input: {
          ...this.runtimeState.input,
          hasMedia: false
        }
      };
      this.renderCurrentState();
      return;
    }

    this.clampSelectedMediaIndex(currentSelectedMediaIndex);
    this.runtimeState = {
      ...this.runtimeState,
      input: {
        ...this.runtimeState.input,
        hasMedia: true
      }
    };
    this.renderCurrentState();
  }

  private removeLinkAttachment(): void {
    if (!this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    this.primaryPastedLink = null;
    this.linkImportRequestState = null;
    this.runtimeState = {
      ...this.runtimeState,
      input: clearQuickCaptureLinkAttachment(this.runtimeState.input)
    };
    this.renderCurrentState();
  }

  private async pickAttachmentFiles(): Promise<void> {
    const files = await this.pickMediaFiles();
    if (files.length === 0 || !this.runtimeState || this.runtimeState.phase !== "capture") {
      return;
    }

    const normalizedFiles = normalizeQuickCapturePickedMediaFiles(files, MAX_IMAGE_ATTACHMENTS);
    if (normalizedFiles.length === 0) {
      return;
    }

    this.hasCaptureFieldEdits = true;
    releaseSelectedCaptureMediaPreviews(this.selectedMedia);
    this.selectedMedia = normalizedFiles.map((file) => createSelectedCaptureMedia(file));
    this.selectedMediaIndex = 0;
    this.showingMediaPreview = false;
    this.syncRuntimeStateForMediaSelection();
    this.renderCurrentState();
  }

  private isEmptySubmission(model: ReturnType<typeof deriveQuickCaptureStateModel>): boolean {
    return model.inputText.trim().length === 0 && !model.sourceUrl?.trim() && this.selectedMedia.length === 0;
  }

  private showEmptySubmitFeedback(): void {
    this.clearEmptySubmitFeedbackTimer();
    this.showingCloseConfirm = false;
    this.showingMediaPreview = false;
    this.showingEmptySubmitFeedback = true;
    this.renderCurrentState();
    this.emptySubmitFeedbackTimer = setTimeout(() => {
      this.emptySubmitFeedbackTimer = null;
      if (!this.runtimeState || this.step !== "capture") {
        return;
      }

      this.showingEmptySubmitFeedback = false;
      this.renderCurrentState();
    }, QuickCaptureModal.EMPTY_SUBMIT_FEEDBACK_DURATION_MS);
  }

  private clearEmptySubmitFeedbackTimer(): void {
    if (!this.emptySubmitFeedbackTimer) {
      return;
    }

    clearTimeout(this.emptySubmitFeedbackTimer);
    this.emptySubmitFeedbackTimer = null;
  }

  // 附件落盘与运行时池选项加载。
  private async saveSelectedMediaFiles(): Promise<string[]> {
    return saveQuickCaptureSelectedMediaFiles({
      selectedMedia: this.selectedMedia,
      mediaStorageDirectory: this.plugin.settings.mediaStorageDirectory,
      selectedPoolLabel: this.runtimeState?.input.selectedPoolLabel ?? "",
      vault: this.plugin.app.vault
    });
  }

  private resolveInitialRuntimePoolOptions(flowContext: QuickCaptureFlowContext): QuickCapturePoolOption[] {
    return flowContext === "global"
      ? createGlobalQuickCapturePoolOptions(this.plugin.settings?.interfaceLanguage)
      : FIRST_USE_QUICK_CAPTURE_POOL_OPTIONS;
  }

  private async resolveRuntimePoolOptions(flowContext: QuickCaptureFlowContext): Promise<QuickCapturePoolOption[]> {
    if (flowContext === "first-use") {
      return FIRST_USE_QUICK_CAPTURE_POOL_OPTIONS;
    }

    try {
      const options = await this.plugin.quickCaptureWorkflow.listGlobalPoolOptions();
      const filteredOptions = options.filter((option) => option.id !== CREATE_NEW_POOL_ID);
      filteredOptions.push({ id: CREATE_NEW_POOL_ID, label: getInterfaceText(this.plugin.settings?.interfaceLanguage).pool.newPoolLabel });
      return filteredOptions;
    } catch {
      return createGlobalQuickCapturePoolOptions(this.plugin.settings?.interfaceLanguage);
    }
  }

  private openPoolCreateModal(): void {
    if (this.runtimeState?.phase === "capture" && this.runtimeState.input.poolDropdownVisible) {
      this.setRuntimeState({
        ...this.runtimeState,
        input: {
          ...this.runtimeState.input,
          poolDropdownVisible: false
        }
      });
      this.renderCurrentState();
    }

    const modal = new PoolModal(
      this.plugin,
      "create",
      {
        onPoolChosen: (poolId, poolName) => {
          void this.handleQuickCapturePoolCreated(poolId, poolName);
        },
        onBackToChoose: () => {
          this.reopenPoolPicker();
        }
      },
      {
        flowContext: "global",
        origin: "quick-capture-pool-picker"
      }
    );
    modal.open();
  }

  private resolveRuntimeState(flowContext: QuickCaptureFlowContext): QuickCaptureRuntimeState {
    const initialText = this.options.initialInputText ?? "";
    const initialSourceUrl =
      this.captureEntryMode === "link" ? extractQuickCaptureTypedSourceUrl(initialText.trim()) : undefined;

    return {
      flowContext,
      phase: this.step,
      input: {
        text: initialText,
        title: this.options.initialTitleText,
        hasManualTitle: this.options.initialTitleText !== undefined,
        hasMedia: this.options.initialHasMedia,
        sourceUrl: initialSourceUrl,
        importState: this.options.initialImportState,
        suspendInlineUrlAutoDetection: false,
        createFileChecked: this.options.initialCreateFileChecked ?? false,
        selectedPoolId: this.options.initialSelectedPoolId,
        selectedPoolLabel: this.options.initialSelectedPoolLabel
      }
    };
  }
}
