/**
 * 写作/速记视图渲染器。
 * 负责快速记录窗口、保存反馈卡片与沉浸写作表单的 DOM 结构和交互绑定。
 */

import { CREATE_NEW_POOL_ID } from "../../plugin/constants";
import type { WriteAiPolishViewState, WriteViewState } from "./write-state";

export interface WriteBodyPastePayload {
  text: string;
  items: DataTransferItem[];
  preventDefault: () => void;
}

export interface WriteTextInputChangeOptions {
  isComposing?: boolean;
}

// 写作与速记渲染层的动作协议。
export interface WriteViewActions {
  onClose: () => void;
  onSubmit: () => void;
  onPoolPickerToggle: () => void;
  onPoolSelect?: (poolId: string) => void;
  onRetryLinkImport: () => void;
  onBodyInputChange?: (value: string, options?: WriteTextInputChangeOptions) => void;
  onBodyPaste?: (payload: WriteBodyPastePayload) => void;
  onTitleInputChange?: (value: string, options?: WriteTextInputChangeOptions) => void;
  onAttachmentPick?: () => void;
  onRemoveMediaAttachment?: () => void;
  onRemoveLinkAttachment?: () => void;
  onMediaNavigatePrevious?: () => void;
  onMediaNavigateNext?: () => void;
  onMediaAddAttachment?: () => void;
  onMediaReplaceAttachment?: () => void;
  onCreateFileToggle?: (checked: boolean) => void;
  onMediaPreviewOpen?: () => void;
  onMediaPreviewClose?: () => void;
  onResumeCapture?: () => void;
  onConfirmClose?: () => void;
  onAiPolishStart?: () => void;
  onAiPolishRedo?: () => void;
  onAiPolishAccept?: () => void;
  onAiPolishBackToEditing?: () => void;
  onSecondaryAction?: () => void;
}

// 基础 DOM 与主题辅助：统一处理节点创建、主题判定和按钮骨架，避免各个速记分支重复拼装底层细节。
function clearContainer(containerEl: HTMLElement): void {
  const withEmpty = containerEl as HTMLElement & { empty?: () => void };
  if (typeof withEmpty.empty === "function") {
    withEmpty.empty();
    return;
  }

  while (containerEl.firstChild) {
    containerEl.removeChild(containerEl.firstChild);
  }
}

function createNode(parent: HTMLElement, tag: string, className?: string, text?: string): HTMLElement {
  const doc = (parent.ownerDocument ?? document) as Document;
  const node = doc.createElement(tag);

  if (className) {
    node.className = className;
  }

  if (text !== undefined) {
    node.textContent = text;
  }

  parent.appendChild(node);
  return node;
}

function createButton(
  parent: HTMLElement,
  className: string,
  label: string,
  onClick: () => void
): HTMLButtonElement {
  const button = createNode(parent, "button", className, label) as HTMLButtonElement;
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function createAttachmentRemoveButton(
  parent: HTMLElement,
  ariaLabel: string,
  onClick: (() => void) | undefined
): HTMLButtonElement {
  const button = createButton(parent, "glitter-write-stage__attachment-remove", "", () => {
    onClick?.();
  });
  button.setAttribute("aria-label", ariaLabel);
  createNode(button, "span", "glitter-write-stage__icon glitter-write-stage__icon--close");
  return button;
}

function createMediaSurfaceButton(
  parent: HTMLElement,
  className: string,
  label: string,
  iconClassName: string,
  onClick: (() => void) | undefined
): HTMLButtonElement {
  const button = createNode(parent, "button", className) as HTMLButtonElement;
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  createNode(button, "span", `glitter-write-stage__icon ${iconClassName}`);
  button.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.stopPropagation();
  });
  button.addEventListener("click", (event) => {
    event?.stopPropagation?.();
    onClick?.();
  });
  return button;
}

function createMediaThumbnailPreviewTrigger(
  parent: HTMLElement,
  label: string,
  onClick: (() => void) | undefined
): HTMLButtonElement {
  const button = createNode(
    parent,
    "button",
    "glitter-write-stage__media-thumbnail-preview-trigger"
  ) as HTMLButtonElement;
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", () => {
    onClick?.();
  });
  return button;
}

function setClassFlag(element: HTMLElement, className: string, enabled: boolean): void {
  const classNames = new Set(element.className.split(/\s+/).filter(Boolean));
  if (enabled) {
    classNames.add(className);
  } else {
    classNames.delete(className);
  }

  element.className = Array.from(classNames).join(" ");
}

function resolveActiveThemeMode(ownerDocument: Document | null | undefined): "obsidian-dark" | "obsidian-light" {
  const body = ownerDocument?.body ?? globalThis.document?.body;
  const classList = body?.classList;

  if (classList?.contains("theme-light")) {
    return "obsidian-light";
  }

  return "obsidian-dark";
}

function setMediaSurfaceActionIconTone(mediaThumbnailSurface: HTMLElement, tone: "light" | "dark"): void {
  setClassFlag(mediaThumbnailSurface, "glitter-write-stage__media-thumbnail-surface--action-icons-light", tone === "light");
  setClassFlag(mediaThumbnailSurface, "glitter-write-stage__media-thumbnail-surface--action-icons-dark", tone === "dark");
}

export function applyMediaSurfaceActionIconToneFallback(mediaThumbnailSurface: HTMLElement): void {
  const fallbackTone = resolveActiveThemeMode(mediaThumbnailSurface.ownerDocument) === "obsidian-light" ? "dark" : "light";
  setMediaSurfaceActionIconTone(mediaThumbnailSurface, fallbackTone);
}

// 媒体浮层按钮取色链路：优先根据缩略图底部采样切换深浅图标，读不到像素时再回退到主题默认值。
function resolveMediaSurfaceActionIconToneFromPixelData(pixelData: Uint8ClampedArray): "light" | "dark" | undefined {
  let weightedLuminance = 0;
  let weightedAlpha = 0;

  for (let index = 0; index < pixelData.length; index += 4) {
    const alpha = (pixelData[index + 3] ?? 0) / 255;
    if (alpha <= 0) {
      continue;
    }

    const red = (pixelData[index] ?? 0) / 255;
    const green = (pixelData[index + 1] ?? 0) / 255;
    const blue = (pixelData[index + 2] ?? 0) / 255;
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    weightedLuminance += luminance * alpha;
    weightedAlpha += alpha;
  }

  if (weightedAlpha <= 0) {
    return undefined;
  }

  return weightedLuminance / weightedAlpha >= 0.56 ? "dark" : "light";
}

function sampleMediaSurfaceActionIconTone(
  mediaThumbnailSurface: HTMLElement,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number
): "light" | "dark" | undefined {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return undefined;
  }

  const canvas = mediaThumbnailSurface.ownerDocument?.createElement("canvas") as HTMLCanvasElement | undefined;
  if (!canvas || typeof canvas.getContext !== "function") {
    return undefined;
  }

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return undefined;
  }

  const sampleSourceWidth = Math.max(Math.round(sourceWidth * 0.36), 1);
  const sampleSourceHeight = Math.max(Math.round(sourceHeight * 0.2), 1);
  const sampleSourceX = Math.max(Math.round((sourceWidth - sampleSourceWidth) / 2), 0);
  const sampleSourceY = Math.max(Math.round(sourceHeight - sampleSourceHeight - sourceHeight * 0.04), 0);

  canvas.width = 24;
  canvas.height = 24;

  try {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, sampleSourceX, sampleSourceY, sampleSourceWidth, sampleSourceHeight, 0, 0, canvas.width, canvas.height);
    return resolveMediaSurfaceActionIconToneFromPixelData(context.getImageData(0, 0, canvas.width, canvas.height).data);
  } catch {
    return undefined;
  }
}

export function bindMediaSurfaceActionIconTone(
  mediaThumbnailSurface: HTMLElement,
  previewElement: HTMLImageElement | HTMLVideoElement,
  kind: "image" | "video"
): void {
  applyMediaSurfaceActionIconToneFallback(mediaThumbnailSurface);

  const applyTone = (): void => {
    const tone = kind === "image"
      ? sampleMediaSurfaceActionIconTone(
          mediaThumbnailSurface,
          previewElement,
          (previewElement as HTMLImageElement).naturalWidth ?? 0,
          (previewElement as HTMLImageElement).naturalHeight ?? 0
        )
      : sampleMediaSurfaceActionIconTone(
          mediaThumbnailSurface,
          previewElement,
          (previewElement as HTMLVideoElement).videoWidth ?? 0,
          (previewElement as HTMLVideoElement).videoHeight ?? 0
        );

    if (!tone) {
      applyMediaSurfaceActionIconToneFallback(mediaThumbnailSurface);
      return;
    }

    setMediaSurfaceActionIconTone(mediaThumbnailSurface, tone);
  };

  if (kind === "image") {
    const image = previewElement as HTMLImageElement;
    if (image.complete && (image.naturalWidth ?? 0) > 0 && (image.naturalHeight ?? 0) > 0) {
      applyTone();
    }
    image.addEventListener("load", applyTone);
    image.addEventListener("error", () => applyMediaSurfaceActionIconToneFallback(mediaThumbnailSurface));
    return;
  }

  const video = previewElement as HTMLVideoElement;
  if ((video.readyState ?? 0) >= 2 && (video.videoWidth ?? 0) > 0 && (video.videoHeight ?? 0) > 0) {
    applyTone();
  }
  video.addEventListener("loadeddata", applyTone);
  video.addEventListener("seeked", applyTone);
  video.addEventListener("error", () => applyMediaSurfaceActionIconToneFallback(mediaThumbnailSurface));
}

function hasQuickCaptureMeaningfulInput(state: WriteViewState): boolean {
  const titleValue = state.fields.title.value?.trim() ?? "";
  const titlePlaceholder = state.fields.title.placeholder.trim();
  const bodyValue = state.fields.body.value?.trim() ?? "";

  return bodyValue.length > 0 || (titleValue.length > 0 && titleValue !== titlePlaceholder);
}

function hasQuickCaptureBodyInput(state: WriteViewState): boolean {
  return (state.fields.body.value?.trim() ?? "").length > 0;
}

function setAiPolishTriggerVisibility(triggerRow: HTMLElement, value: string | undefined): void {
  setClassFlag(triggerRow, "glitter-write-stage__ai-polish-row--hidden", (value?.trim() ?? "").length === 0);
}

function isQuickCaptureSubmitDirty(state: WriteViewState): boolean {
  const explicitDirtyState = state.quickCapture?.hasCaptureFieldEdits;
  if (explicitDirtyState !== undefined) {
    return explicitDirtyState;
  }

  return hasQuickCaptureMeaningfulInput(state);
}

function isAiPolishReviewLayout(aiPolish: WriteAiPolishViewState | undefined): boolean {
  return aiPolish?.state === "reviewing" || aiPolish?.state === "error";
}

// 触发器保持纯图标+文字样式，只在正文非空时显示，并在请求中切换到 loading 文案。
function createAiPolishTrigger(
  bodyPanel: HTMLElement,
  state: WriteViewState,
  aiPolish: WriteAiPolishViewState,
  actions: WriteViewActions,
  initialBodyValue: string | undefined
): HTMLElement {
  const labels = state.quickCapture?.labels;
  const triggerLabel = aiPolish.state === "loading" ? (labels?.aiPolishLoading ?? "AI polishing...") : (labels?.aiPolishTrigger ?? "AI polish");
  const triggerRow = createNode(bodyPanel, "div", "glitter-write-stage__ai-polish-row");
  const trigger = createButton(triggerRow, "glitter-write-stage__ai-polish-trigger", "", () => {
    if (aiPolish.state === "loading") {
      return;
    }

    actions.onAiPolishStart?.();
  });

  trigger.setAttribute("aria-label", triggerLabel);
  createNode(trigger, "span", "glitter-write-stage__icon glitter-write-stage__icon--sparkles");
  createNode(trigger, "span", "glitter-write-stage__ai-polish-trigger-label", triggerLabel);
  trigger.disabled = aiPolish.state === "loading";
  setAiPolishTriggerVisibility(triggerRow, initialBodyValue);
  return triggerRow;
}

// 评审态把原文编辑区保留在左侧，右侧结果区独立滚动，并通过中间圆形按钮执行采纳/重做/取消。
function createAiPolishReviewLayout(
  bodyPanel: HTMLElement,
  state: WriteViewState,
  aiPolish: WriteAiPolishViewState,
  actions: WriteViewActions
): HTMLElement {
  const labels = state.quickCapture?.labels;
  const reviewLayout = createNode(bodyPanel, "div", "glitter-write-stage__ai-polish-review");
  const sourcePane = createNode(
    reviewLayout,
    "div",
    "glitter-write-stage__ai-polish-pane glitter-write-stage__ai-polish-pane--source"
  );
  const divider = createNode(reviewLayout, "div", "glitter-write-stage__ai-polish-divider");
  const dividerActions = createNode(divider, "div", "glitter-write-stage__ai-polish-divider-actions");
  const adoptButton = createMediaSurfaceButton(
    dividerActions,
    "glitter-write-stage__ai-polish-action glitter-write-stage__ai-polish-adopt",
    labels?.aiPolishAccept ?? "Accept result",
    "glitter-write-stage__icon--check",
    () => {
      if (!aiPolish.resultMatchesCurrentSource || aiPolish.state === "error") {
        return;
      }

      actions.onAiPolishAccept?.();
    }
  );
  const canAdopt = aiPolish.resultMatchesCurrentSource && aiPolish.state !== "error";
  adoptButton.disabled = !canAdopt;
  createMediaSurfaceButton(
    dividerActions,
    "glitter-write-stage__ai-polish-action glitter-write-stage__ai-polish-redo",
    labels?.aiPolishRedo ?? "Redo",
    "glitter-write-stage__icon--refresh",
    () => actions.onAiPolishRedo?.()
  );
  createMediaSurfaceButton(
    dividerActions,
    "glitter-write-stage__ai-polish-action glitter-write-stage__ai-polish-back",
    labels?.aiPolishBack ?? "Cancel",
    "glitter-write-stage__icon--close",
    () => actions.onAiPolishBackToEditing?.()
  );

  const resultPane = createNode(
    reviewLayout,
    "div",
    "glitter-write-stage__ai-polish-pane glitter-write-stage__ai-polish-pane--result"
  );
  const resultScroll = createNode(resultPane, "div", "glitter-write-stage__ai-polish-result-scroll");
  const resultText =
    aiPolish.state === "error"
      ? aiPolish.errorMessage?.trim() || labels?.aiPolishDefaultError || "AI polish failed. Please redo and try again."
      : aiPolish.polishedValue?.trim() || labels?.aiPolishEmptyResult || "No polished result yet";
  createNode(
    resultScroll,
    "p",
    `glitter-write-stage__ai-polish-result${aiPolish.state === "error" ? " glitter-write-stage__ai-polish-result--error" : ""}`,
    resultText
  );

  if (aiPolish.state !== "error" && !aiPolish.resultMatchesCurrentSource) {
    createNode(resultScroll, "p", "glitter-write-stage__ai-polish-stale-warning", labels?.aiPolishStaleWarning ?? "The original text has changed. Redo before accepting this result.");
  }

  return sourcePane;
}

// 缩略图表面的悬浮控件由这里统一装配，保证图片轮播、视频替换和删除动作都落在同一层真实 UI 上。
function renderMediaThumbnailSurfaceControls(
  mediaThumbnailSurface: HTMLElement,
  state: WriteViewState,
  actions: WriteViewActions
): void {
  const mediaOverlayMode = state.quickCapture?.mediaOverlayMode;
  const attachedMediaCount = state.quickCapture?.attachedMediaCount ?? 0;

  if (mediaOverlayMode !== "image-gallery" && mediaOverlayMode !== "video") {
    return;
  }

  const labels = state.quickCapture?.labels;
  const controls = createNode(mediaThumbnailSurface, "div", "glitter-write-stage__media-surface-controls");

  if (mediaOverlayMode === "image-gallery") {
    const totalMediaCount = Math.max(attachedMediaCount, 1);
    const selectedMediaIndex = state.quickCapture?.selectedMediaIndex ?? 0;
    createNode(
      controls,
      "span",
      "glitter-write-stage__media-surface-page-chip",
      `${Math.min(selectedMediaIndex + 1, totalMediaCount)} / ${totalMediaCount}`
    );
  }

  if (mediaOverlayMode === "image-gallery" && attachedMediaCount >= 2) {
    const navRow = createNode(controls, "div", "glitter-write-stage__media-surface-nav");
    const previousButton = createMediaSurfaceButton(
      navRow,
      "glitter-write-stage__media-surface-nav-button glitter-write-stage__media-surface-nav-button--previous",
      labels?.previousImage ?? "上一张",
      "glitter-write-stage__icon--chevron-left",
      actions.onMediaNavigatePrevious
    );
    previousButton.disabled = !(state.quickCapture?.canSelectPreviousMedia ?? false);

    const nextButton = createMediaSurfaceButton(
      navRow,
      "glitter-write-stage__media-surface-nav-button glitter-write-stage__media-surface-nav-button--next",
      labels?.nextImage ?? "下一张",
      "glitter-write-stage__icon--chevron-right",
      actions.onMediaNavigateNext
    );
    nextButton.disabled = !(state.quickCapture?.canSelectNextMedia ?? false);
  }

  const actionRow = createNode(controls, "div", "glitter-write-stage__media-surface-actions");

  if (mediaOverlayMode === "image-gallery") {
    const addButton = createMediaSurfaceButton(
      actionRow,
      "glitter-write-stage__media-surface-action glitter-write-stage__media-surface-action--add",
      labels?.addImage ?? "增加图片",
      "glitter-write-stage__icon--plus",
      actions.onMediaAddAttachment
    );
    addButton.disabled = !(state.quickCapture?.canAddMoreImages ?? false);

    createMediaSurfaceButton(
      actionRow,
      "glitter-write-stage__media-surface-action glitter-write-stage__media-surface-action--replace",
      labels?.replaceImage ?? "替换当前图片",
      "glitter-write-stage__icon--replace",
      actions.onMediaReplaceAttachment
    );
    createMediaSurfaceButton(
      actionRow,
      "glitter-write-stage__media-surface-action glitter-write-stage__media-surface-action--remove",
      labels?.removeImage ?? "删除当前图片",
      "glitter-write-stage__icon--trash",
      actions.onRemoveMediaAttachment
    );
    return;
  }

  createMediaSurfaceButton(
    actionRow,
    "glitter-write-stage__media-surface-action glitter-write-stage__media-surface-action--replace",
    labels?.replaceVideo ?? "替换视频",
    "glitter-write-stage__icon--replace",
    actions.onMediaReplaceAttachment
  );
  createMediaSurfaceButton(
    actionRow,
    "glitter-write-stage__media-surface-action glitter-write-stage__media-surface-action--remove",
    labels?.removeVideo ?? "删除视频",
    "glitter-write-stage__icon--trash",
    actions.onRemoveMediaAttachment
  );
}

// 快速记录采集态渲染：在同一入口下编排文本、链接、媒体三种内容态，并在需要时切入 AI 润色评审与局部反馈覆盖层。
function renderQuickCaptureCapture(
  stage: HTMLElement,
  state: WriteViewState,
  actions: WriteViewActions
): void {
  const card = createNode(stage, "div", "glitter-write-stage__modal-card");

  const header = createNode(card, "header", "glitter-write-stage__modal-header");
  createNode(header, "h2", "glitter-write-stage__title", state.title);

  const contentKind = state.contentKind ?? "text";
  const autoTitle = createNode(card, "label", "glitter-write-stage__auto-title");
  createNode(
    autoTitle,
    "span",
    `glitter-write-stage__icon glitter-write-stage__icon--${contentKind === "media" ? "image" : contentKind === "link" ? "link" : "clock"}`
  );
  const titleInput = createNode(
    autoTitle,
    "input",
    "glitter-write-stage__auto-title-text"
  ) as HTMLInputElement;
  titleInput.type = "text";
  titleInput.value = state.fields.title.value ?? state.fields.title.placeholder;
  titleInput.placeholder = state.fields.title.placeholder;
  titleInput.setAttribute("aria-label", state.fields.title.label);
  titleInput.addEventListener("focus", () => {
    titleInput.select?.();
  });
  titleInput.addEventListener("click", () => {
    titleInput.select?.();
  });
  titleInput.addEventListener("input", (event) => {
    const compositionEvent = event as InputEvent & { isComposing?: boolean };
    actions.onTitleInputChange?.(titleInput.value, {
      isComposing: compositionEvent.isComposing
    });
  });

  const bodyPanel = createNode(
    card,
    "section",
    `glitter-write-stage__body-panel glitter-write-stage__body-panel--${contentKind}`
  );
  const aiPolish = state.quickCapture?.aiPolish;
  const shouldUseAiPolishReviewLayout =
    state.flowContext === "global" && contentKind !== "media" && isAiPolishReviewLayout(aiPolish);
  const shouldMountAiPolishTrigger =
    state.flowContext === "global" && contentKind !== "media" && aiPolish?.visible === true && !shouldUseAiPolishReviewLayout;

  let bodyInputHost: HTMLElement = shouldUseAiPolishReviewLayout && aiPolish
    ? createAiPolishReviewLayout(bodyPanel, state, aiPolish, actions)
    : bodyPanel;
  let aiPolishTriggerRow: HTMLElement | null = null;

  if (contentKind === "media") {
    const mediaLayout = createNode(bodyPanel, "div", "glitter-write-stage__media-layout");
    const mediaPreviewUrl = state.quickCapture?.attachedMediaPreviewUrl;
    const mediaPreviewKind = state.quickCapture?.attachedMediaPreviewKind;
    const mediaPreviewVisible = state.quickCapture?.mediaPreviewVisible ?? false;
    const mediaThumbnailInteractive = Boolean(mediaPreviewUrl && mediaPreviewKind === "image");
    const mediaThumbnailSurface = createNode(
      mediaLayout,
      "div",
      "glitter-write-stage__media-thumbnail-surface"
    ) as HTMLElement;
    const mediaThumbnailContentHost = mediaThumbnailInteractive
      ? createMediaThumbnailPreviewTrigger(mediaThumbnailSurface, state.quickCapture?.labels?.mediaPreviewOpen ?? "View large preview", actions.onMediaPreviewOpen)
      : mediaThumbnailSurface;

    if (mediaPreviewUrl && mediaPreviewKind === "image") {
      const mediaThumbnailImage = createNode(
        mediaThumbnailContentHost,
        "img",
        "glitter-write-stage__media-thumbnail-image"
      ) as HTMLImageElement;
      mediaThumbnailImage.setAttribute("src", mediaPreviewUrl);
      mediaThumbnailImage.setAttribute("alt", state.quickCapture?.labels?.selectedImage ?? "Selected media image thumbnail");
      bindMediaSurfaceActionIconTone(mediaThumbnailSurface, mediaThumbnailImage, "image");
    } else if (mediaPreviewUrl && mediaPreviewKind === "video") {
      const mediaThumbnailVideo = createNode(
        mediaThumbnailSurface,
        "video",
        "glitter-write-stage__media-thumbnail-video"
      ) as HTMLVideoElement;
      mediaThumbnailVideo.setAttribute("src", mediaPreviewUrl);
      mediaThumbnailVideo.setAttribute("muted", "");
      mediaThumbnailVideo.setAttribute("playsinline", "");
      mediaThumbnailVideo.setAttribute("autoplay", "");
      mediaThumbnailVideo.setAttribute("loop", "");
      mediaThumbnailVideo.setAttribute("aria-label", state.quickCapture?.labels?.selectedVideo ?? "Selected media video thumbnail");
      bindMediaSurfaceActionIconTone(mediaThumbnailSurface, mediaThumbnailVideo, "video");
    } else {
      applyMediaSurfaceActionIconToneFallback(mediaThumbnailSurface);
      createNode(mediaThumbnailSurface, "span", "glitter-write-stage__icon glitter-write-stage__icon--media");
    }

    renderMediaThumbnailSurfaceControls(mediaThumbnailSurface, state, actions);

    const mediaInputsColumn = createNode(mediaLayout, "div", "glitter-write-stage__media-inputs-column");
    bodyInputHost = createNode(mediaInputsColumn, "div", "glitter-write-stage__media-editor-shell");

    if (mediaPreviewVisible && mediaPreviewUrl && mediaPreviewKind === "image") {
      const mediaPreviewOverlay = createNode(card, "div", "glitter-write-stage__media-preview-overlay");
      const mediaPreviewDialog = createNode(mediaPreviewOverlay, "div", "glitter-write-stage__media-preview-dialog");
      const mediaPreviewClose = createButton(
        mediaPreviewDialog,
        "glitter-write-stage__media-preview-close",
        "",
        () => actions.onMediaPreviewClose?.()
      );
      mediaPreviewClose.setAttribute("aria-label", state.quickCapture?.labels?.mediaPreviewClose ?? "关闭大图预览");
      createNode(mediaPreviewClose, "span", "glitter-write-stage__icon glitter-write-stage__icon--close");
      const mediaPreviewImage = createNode(
        mediaPreviewDialog,
        "img",
        "glitter-write-stage__media-preview-image"
      ) as HTMLImageElement;
      mediaPreviewImage.setAttribute("src", mediaPreviewUrl);
      mediaPreviewImage.setAttribute("alt", state.quickCapture?.labels?.mediaPreviewImage ?? "媒体大图预览");
    }
  }

  const bodyInputClassName = [
    "glitter-write-stage__body-editor",
    "glitter-write-stage__textarea",
    "glitter-write-stage__textarea--panel-blend",
    shouldUseAiPolishReviewLayout ? "glitter-write-stage__ai-polish-source" : ""
  ]
    .filter(Boolean)
    .join(" ");

  const bodyInput = createNode(bodyInputHost, "textarea", bodyInputClassName) as HTMLTextAreaElement;
  bodyInput.value = state.fields.body.value ?? "";
  bodyInput.placeholder = state.fields.body.inputPlaceholder ?? state.fields.body.placeholder;
  bodyInput.autofocus = state.fields.body.autofocus;

  bodyInput.addEventListener("input", (event) => {
    const compositionEvent = event as InputEvent & { isComposing?: boolean };
    if (aiPolishTriggerRow) {
      setAiPolishTriggerVisibility(aiPolishTriggerRow, bodyInput.value);
    }
    actions.onBodyInputChange?.(bodyInput.value, {
      isComposing: compositionEvent.isComposing
    });
  });
  bodyInput.addEventListener("paste", (event: ClipboardEvent) => {
    const clipboardData = event.clipboardData;
    if (!clipboardData) {
      return;
    }

    actions.onBodyPaste?.({
      text: clipboardData.getData("text/plain"),
      items: Array.from(clipboardData.items ?? []),
      preventDefault: () => event.preventDefault()
    });
  });

  if (shouldMountAiPolishTrigger && aiPolish) {
    aiPolishTriggerRow = createAiPolishTrigger(
      bodyPanel,
      state,
      aiPolish,
      actions,
      hasQuickCaptureBodyInput(state) ? state.fields.body.value : undefined
    );
  }

  if (!shouldUseAiPolishReviewLayout && contentKind === "link" && state.linkImport?.attachmentLabel) {
    const linkAttachRow = createNode(bodyPanel, "div", "glitter-write-stage__link-attachment-row");
    createAttachmentRemoveButton(linkAttachRow, state.quickCapture?.labels?.linkAttachmentRemove ?? "移除已加载链接", actions.onRemoveLinkAttachment);

    const linkAttachmentPrimary = createNode(
      linkAttachRow,
      state.linkImport.attachmentUrl ? "a" : "div",
      "glitter-write-stage__link-attachment-primary"
    );
    if (state.linkImport.attachmentUrl) {
      linkAttachmentPrimary.setAttribute("href", state.linkImport.attachmentUrl);
      linkAttachmentPrimary.setAttribute("target", "_blank");
      linkAttachmentPrimary.setAttribute("rel", "noopener noreferrer");
    }
    createNode(
      linkAttachmentPrimary,
      "span",
      `glitter-write-stage__icon glitter-write-stage__icon--${state.linkImport.attachmentIcon ?? "paperclip"}`
    );
    createNode(linkAttachmentPrimary, "span", "glitter-write-stage__link-attachment-text", state.linkImport.attachmentLabel);

    if (state.linkImport.status === "loading" && state.linkImport.message) {
      const loading = createNode(bodyPanel, "div", "glitter-write-stage__link-loading");
      createNode(loading, "p", undefined, state.linkImport.message);
    }

  } else if (!shouldUseAiPolishReviewLayout && contentKind !== "media") {
    const clipHint = createButton(bodyPanel, "glitter-write-stage__clip-hint", "", () => actions.onAttachmentPick?.());
    clipHint.setAttribute("aria-label", state.quickCapture?.labels?.attachmentPick ?? "添加图片或视频附件");
    createNode(clipHint, "span", "glitter-write-stage__icon glitter-write-stage__icon--paperclip");
    createNode(
      clipHint,
      "span",
      "glitter-write-stage__clip-hint-text",
      state.quickCapture?.clipHint ?? "粘贴附件/链接后自动识别"
    );
  }

  const poolRow = createNode(card, "div", "glitter-write-stage__pool-row");
  const isFirstUsePoolLocked = state.flowContext === "first-use";
  const poolButton = createButton(poolRow, "glitter-write-stage__pool-button", "", () => actions.onPoolPickerToggle());
  poolButton.disabled = isFirstUsePoolLocked;
  poolButton.setAttribute("aria-disabled", isFirstUsePoolLocked ? "true" : "false");
  poolButton.setAttribute("aria-expanded", state.poolPicker?.dropdownVisible ? "true" : "false");
  createNode(poolButton, "span", "glitter-write-stage__icon glitter-write-stage__icon--waves");
  createNode(poolButton, "span", "glitter-write-stage__pool-button-text", state.fields.poolHint);
  createNode(
    poolButton,
    "span",
    `glitter-write-stage__icon glitter-write-stage__icon--${state.poolPicker?.dropdownVisible ? "chevron-up" : "chevron-down"}`
  );

  if (state.poolPicker?.dropdownVisible) {
    const poolDropdown = createNode(poolRow, "div", "glitter-write-stage__pool-dropdown");
    const regularOptions = state.poolPicker.options.filter((option) => option.id !== CREATE_NEW_POOL_ID);
    const createOption = state.poolPicker.options.find((option) => option.id === CREATE_NEW_POOL_ID);

    if (regularOptions.length > 0) {
      const optionsShell = createNode(poolDropdown, "div", "glitter-write-stage__pool-container glitter-write-stage__pool-container--options");
      const scrollArea = createNode(optionsShell, "div", "glitter-write-stage__pool-scroll");
      const optionsGroup = createNode(scrollArea, "div", "glitter-write-stage__pool-group glitter-write-stage__pool-group--options");
      regularOptions.forEach((option) => {
        const optionButton = createButton(optionsGroup, "glitter-write-stage__pool-option", option.label, () => {
          actions.onPoolSelect?.(option.id);
        });
        optionButton.dataset.poolId = option.id;
        setClassFlag(
          optionButton,
          "glitter-write-stage__pool-option--selected",
          option.id === state.poolPicker?.selectedId
        );
      });
    }

    if (createOption) {
      const createShell = createNode(poolDropdown, "div", "glitter-write-stage__pool-container glitter-write-stage__pool-container--create");
      const createGroup = createNode(createShell, "div", "glitter-write-stage__pool-group glitter-write-stage__pool-group--create");
      const createLabel = createNode(createGroup, "p", "glitter-write-stage__pool-group-label", state.poolPicker.createActionLabel);
      createLabel.setAttribute("aria-hidden", "true");
      const createButtonEl = createButton(createGroup, "glitter-write-stage__pool-option glitter-write-stage__pool-option--create", "", () => {
        actions.onPoolSelect?.(createOption.id);
      });
      createButtonEl.dataset.poolId = createOption.id;
      createButtonEl.setAttribute("aria-label", createOption.label);
      createNode(createButtonEl, "span", "glitter-write-stage__icon glitter-write-stage__icon--waves");
      createNode(createButtonEl, "span", "glitter-write-stage__pool-option-text", createOption.label);
    }
  }

  const footer = createNode(card, "footer", "glitter-write-stage__footer glitter-write-stage__footer--quick-capture");
  createNode(
    footer,
    "p",
    "glitter-write-stage__shortcut-hint",
    state.quickCapture?.shortcutHint ?? "Esc 关闭 · Cmd/Ctrl+Enter 保存"
  );
  const actionsRow = createNode(footer, "div", "glitter-write-stage__quick-actions");

  const createFileToggle = createNode(actionsRow, "label", "glitter-write-stage__create-file-toggle");
  createFileToggle.setAttribute("aria-label", state.quickCapture?.createFileActionLabel ?? "保存灵感并创建文件");
  const createFileCheckbox = createNode(
    createFileToggle,
    "input",
    "glitter-write-stage__create-file-checkbox"
  ) as HTMLInputElement;
  createFileCheckbox.type = "checkbox";
  createFileCheckbox.checked = state.quickCapture?.createFileChecked ?? false;
  createFileCheckbox.addEventListener("change", () => {
    actions.onCreateFileToggle?.(createFileCheckbox.checked);
  });
  const createFileIndicator = createNode(createFileToggle, "span", "glitter-write-stage__create-file-indicator");
  createNode(createFileIndicator, "span", "glitter-write-stage__icon glitter-write-stage__icon--check");
  createNode(
    createFileToggle,
    "span",
    "glitter-write-stage__create-file-text",
    state.quickCapture?.createFileActionLabel ?? "保存灵感并创建文件"
  );

  const isQuickCaptureSubmit = state.phase === "capture";
  const isGlobalCaptureSubmit = state.flowContext === "global" && state.phase === "capture";
  const primaryButtonClassName = [
    "glitter-write-stage__action-primary",
    "glitter-write-stage__action-primary--with-icon",
    `glitter-write-stage__action-primary--${state.footer.primaryAction.tone}`,
    isQuickCaptureSubmit ? "glitter-write-stage__action-primary--capture-submit" : ""
  ]
    .filter(Boolean)
    .join(" ");

  const primaryButton = createButton(actionsRow, primaryButtonClassName, "", () => actions.onSubmit());
  primaryButton.disabled = state.importState === "loading" || state.footer.primaryAction.disabled === true;
  if (isQuickCaptureSubmit) {
    primaryButton.setAttribute("data-dirty", isQuickCaptureSubmitDirty(state) ? "true" : "false");
  }
  createNode(primaryButton, "span", "glitter-write-stage__icon glitter-write-stage__icon--save");
  createNode(primaryButton, "span", "glitter-write-stage__action-primary-text", state.footer.primaryAction.label);

  if (isGlobalCaptureSubmit) {
    primaryButton.setAttribute("aria-describedby", "glitter-write-stage-submit-tooltip");
    const submitTooltip = createNode(
      primaryButton,
      "span",
      "glitter-write-stage__submit-tooltip",
      state.quickCapture?.labels?.defaultSaveHelperText ?? "默认仅保存为灵感（不创建 .md 文件）"
    );
    submitTooltip.id = "glitter-write-stage-submit-tooltip";
  }

  if (state.footer.statusText) {
    createNode(footer, "p", "glitter-write-stage__status", state.footer.statusText);
  }

  if (state.quickCapture?.closeConfirm?.visible) {
    const closeConfirm = createNode(card, "div", "glitter-write-stage__close-confirm");
    createNode(closeConfirm, "h3", "glitter-write-stage__close-confirm-title", state.quickCapture.closeConfirm.title);
    createNode(
      closeConfirm,
      "p",
      "glitter-write-stage__close-confirm-description",
      state.quickCapture.closeConfirm.description
    );
    const closeConfirmActions = createNode(closeConfirm, "div", "glitter-write-stage__close-confirm-actions");
    createButton(
      closeConfirmActions,
      "glitter-write-stage__close-confirm-secondary",
      state.quickCapture.closeConfirm.resumeLabel,
      () => actions.onResumeCapture?.()
    );
    createButton(
      closeConfirmActions,
      "glitter-write-stage__close-confirm-primary",
      state.quickCapture.closeConfirm.exitLabel,
      () => actions.onConfirmClose?.()
    );
  }

  if (state.quickCapture?.mediaReplaceConfirm?.visible) {
    const mediaReplaceConfirm = createNode(
      card,
      "div",
      "glitter-write-stage__close-confirm glitter-write-stage__close-confirm--media-replace"
    );
    createNode(
      mediaReplaceConfirm,
      "h3",
      "glitter-write-stage__close-confirm-title",
      state.quickCapture.mediaReplaceConfirm.title
    );
    createNode(
      mediaReplaceConfirm,
      "p",
      "glitter-write-stage__close-confirm-description",
      state.quickCapture.mediaReplaceConfirm.description
    );
    const mediaReplaceActions = createNode(
      mediaReplaceConfirm,
      "div",
      "glitter-write-stage__close-confirm-actions"
    );
    createButton(
      mediaReplaceActions,
      "glitter-write-stage__close-confirm-secondary",
      state.quickCapture.mediaReplaceConfirm.keepLabel,
      () => actions.onResumeCapture?.()
    );
    createButton(
      mediaReplaceActions,
      "glitter-write-stage__close-confirm-primary",
      state.quickCapture.mediaReplaceConfirm.replaceLabel,
      () => actions.onConfirmClose?.()
    );
  }

  if (state.quickCapture?.emptySubmitFeedback?.visible) {
    const feedback = createNode(card, "div", "glitter-write-stage__empty-submit-feedback");
    createNode(feedback, "div", "glitter-write-stage__empty-submit-feedback-scrim");
    createNode(
      feedback,
      "div",
      "glitter-write-stage__empty-submit-feedback-dialog",
      state.quickCapture.emptySubmitFeedback.message
    );
  }
}

// 首次使用保存反馈渲染：强调首条灵感已落地，并把用户下一步导向继续记录或进入灵感池浏览。
function renderFirstUseSaveFeedbackModal(
  stage: HTMLElement,
  state: WriteViewState,
  actions: WriteViewActions
): void {
  const card = createNode(
    stage,
    "div",
    "glitter-write-stage__modal-card glitter-write-stage__success-card glitter-write-stage__first-use-success-card"
  );

  const closeButton = createButton(card, "glitter-write-stage__close-button glitter-write-stage__success-close", "", () => actions.onClose());
  closeButton.setAttribute("aria-label", state.quickCapture?.labels?.closeQuickCapture ?? "关闭提示窗口");
  createNode(closeButton, "span", "glitter-write-stage__icon glitter-write-stage__icon--close");

  const successBadge = createNode(card, "div", "glitter-write-stage__success-badge");
  createNode(successBadge, "span", "glitter-write-stage__success-badge-ring");
  createNode(
    successBadge,
    "span",
    "glitter-write-stage__success-badge-icon glitter-write-stage__icon glitter-write-stage__icon--check"
  );

  createNode(card, "h2", "glitter-write-stage__title", state.title);

  if (state.subtitle.trim()) {
    createNode(card, "p", "glitter-write-stage__subtitle", state.subtitle);
  }

  const nextStep = createNode(
    card,
    "section",
    "glitter-write-stage__success-summary glitter-write-stage__first-use-success-next-step"
  );
  const nextStepTitle = state.choice?.title?.trim() || state.footer.primaryAction.label;
  createNode(nextStep, "h3", "glitter-write-stage__success-summary-title", nextStepTitle);

  const nextStepDescription = state.choice?.options[0]?.description?.trim();
  if (nextStepDescription) {
    createNode(nextStep, "p", "glitter-write-stage__success-summary-line", nextStepDescription);
  }

  const footer = createNode(card, "footer", "glitter-write-stage__footer glitter-write-stage__success-actions");
  const secondaryButton = createButton(
    footer,
    "glitter-write-stage__action-secondary glitter-write-stage__success-action-secondary",
    state.footer.secondaryAction.label,
    () => {
      actions.onSecondaryAction?.();
    }
  );
  secondaryButton.disabled = !actions.onSecondaryAction;

  const primaryButton = createButton(
    footer,
    `glitter-write-stage__action-primary glitter-write-stage__success-action-primary glitter-write-stage__action-primary--${state.footer.primaryAction.tone}`,
    "",
    () => {
      actions.onSubmit();
    }
  );
  createNode(primaryButton, "span", "glitter-write-stage__icon glitter-write-stage__icon--enter-pool");
  createNode(primaryButton, "span", "glitter-write-stage__success-action-text", state.footer.primaryAction.label);
}

// 全局速记保存反馈渲染：同一套卡片覆盖保存中、失败、完成三种状态，并在保存未结束前锁住底部动作。
function renderGlobalSaveFeedbackModal(
  stage: HTMLElement,
  state: WriteViewState,
  actions: WriteViewActions
): void {
  const card = createNode(
    stage,
    "div",
    "glitter-write-stage__modal-card glitter-write-stage__success-card"
  );

  const closeButton = createButton(card, "glitter-write-stage__close-button glitter-write-stage__success-close", "", () => actions.onClose());
  closeButton.setAttribute("aria-label", state.quickCapture?.labels?.closeQuickCapture ?? "关闭提示窗口");
  createNode(closeButton, "span", "glitter-write-stage__icon glitter-write-stage__icon--close");

  const statusPhase = state.phase ?? "saved-feedback";
  const isSaving = statusPhase === "saving";
  const isSaveFailed = statusPhase === "save-failed";
  const badgeClassName = [
    "glitter-write-stage__success-badge",
    isSaving ? "glitter-write-stage__success-badge--saving" : "",
    isSaveFailed ? "glitter-write-stage__success-badge--error" : ""
  ]
    .filter(Boolean)
    .join(" ");
  const successBadge = createNode(card, "div", badgeClassName);
  createNode(successBadge, "span", "glitter-write-stage__success-badge-ring");
  createNode(
    successBadge,
    "span",
    `glitter-write-stage__success-badge-icon glitter-write-stage__icon glitter-write-stage__icon--${isSaving ? "loader" : isSaveFailed ? "alert" : "check"}`
  );

  createNode(card, "h2", "glitter-write-stage__title", state.title);

  if (state.subtitle.trim()) {
    createNode(card, "p", "glitter-write-stage__subtitle", state.subtitle);
  }

  const summaryClassName = [
    "glitter-write-stage__success-summary",
    isSaveFailed ? "glitter-write-stage__success-summary--error" : ""
  ]
    .filter(Boolean)
    .join(" ");
  const summary = createNode(card, "section", summaryClassName);
  const primarySummary = state.choice?.options[0];
  const summaryTitle = primarySummary?.label?.trim() || state.choice?.title?.trim() || "";

  if (summaryTitle) {
    createNode(summary, "h3", "glitter-write-stage__success-summary-title", summaryTitle);
  }

  if (primarySummary?.description) {
    const summaryDescription = createNode(summary, "div", "glitter-write-stage__success-summary-description");
    primarySummary.description.split("\n").forEach((line) => {
      createNode(summaryDescription, "p", "glitter-write-stage__success-summary-line", line);
    });
  }

  const footer = createNode(card, "footer", "glitter-write-stage__footer glitter-write-stage__success-actions");
  const disableFooterActions = isSaving;
  const secondaryButton = createButton(
    footer,
    "glitter-write-stage__action-secondary glitter-write-stage__success-action-secondary",
    state.footer.secondaryAction.label,
    () => {
      if (disableFooterActions) {
        return;
      }
      actions.onSecondaryAction?.();
    }
  );
  secondaryButton.disabled = disableFooterActions || !actions.onSecondaryAction;

  const primaryButton = createButton(
    footer,
    `glitter-write-stage__action-primary glitter-write-stage__success-action-primary glitter-write-stage__action-primary--${state.footer.primaryAction.tone}`,
    "",
    () => {
      if (disableFooterActions) {
        return;
      }
      actions.onSubmit();
    }
  );
  createNode(
    primaryButton,
    "span",
    `glitter-write-stage__icon glitter-write-stage__icon--${isSaving ? "loader" : isSaveFailed ? "refresh" : "enter-pool"}`
  );
  createNode(primaryButton, "span", "glitter-write-stage__success-action-text", state.footer.primaryAction.label);
  primaryButton.disabled = disableFooterActions;
}

// 写作与速记视图总入口：先按 shell/phase/flowContext 分发到速记采集、首次完成反馈、全局保存反馈或通用写作表单。
export function renderWriteView(
  containerEl: HTMLElement,
  state: WriteViewState,
  actions: WriteViewActions
): void {
  clearContainer(containerEl);

  const stage = createNode(
    containerEl,
    "section",
    `glitter-plugin-root glitter-write-stage glitter-write-stage--${state.shell}`
  );
  stage.dataset.glitterTheme = resolveActiveThemeMode(containerEl.ownerDocument ?? null);

  const isQuickCaptureCapture =
    state.shell === "quick-capture" &&
    (state.phase === "capture" || state.phase === undefined);

  if (isQuickCaptureCapture) {
    renderQuickCaptureCapture(stage, state, actions);
    return;
  }

  const isFirstUseSavedFeedback =
    state.shell === "quick-capture" &&
    state.flowContext === "first-use" &&
    state.phase === "saved-feedback";

  if (isFirstUseSavedFeedback) {
    renderFirstUseSaveFeedbackModal(stage, state, actions);
    return;
  }

  const isGlobalSavedFeedback =
    state.shell === "quick-capture" &&
    state.flowContext === "global" &&
    (state.phase === "saving" || state.phase === "save-failed" || state.phase === "saved-feedback");

  if (isGlobalSavedFeedback) {
    renderGlobalSaveFeedbackModal(stage, state, actions);
    return;
  }

  const header = createNode(stage, "header", "glitter-write-stage__header");
  createNode(header, "h2", "glitter-write-stage__title", state.title);
  createNode(header, "p", "glitter-write-stage__subtitle", state.subtitle);

  const form = createNode(stage, "div", "glitter-write-stage__form");

  createNode(form, "label", "glitter-write-stage__label glitter-write-stage__label--title", state.fields.title.label);
  const titleInput = createNode(form, "input", "glitter-write-stage__input glitter-write-stage__input--title") as HTMLInputElement;
  titleInput.type = "text";
  titleInput.placeholder = state.fields.title.placeholder;

  createNode(form, "label", "glitter-write-stage__label glitter-write-stage__label--body", state.fields.body.label);
  const bodyInput = createNode(form, "textarea", "glitter-write-stage__textarea glitter-write-stage__textarea--body") as HTMLTextAreaElement;
  bodyInput.value = state.fields.body.value ?? "";
  bodyInput.placeholder = state.fields.body.placeholder;
  bodyInput.autofocus = state.fields.body.autofocus;

  createButton(form, "glitter-write-stage__pool-button", state.fields.poolHint, () => actions.onPoolPickerToggle());

  if (state.linkImport?.status === "loading") {
    const loading = createNode(form, "div", "glitter-write-stage__link-loading");
    createNode(loading, "p", undefined, state.linkImport.message ?? "Loading link metadata...");
  }

  if (state.linkImport?.status === "error") {
    const error = createNode(form, "div", "glitter-write-stage__link-error");
    createNode(error, "strong", undefined, state.linkImport.message ?? "Link import failed");
    createButton(error, "glitter-write-stage__retry-link", "Retry", () => actions.onRetryLinkImport());
  }

  if (state.choice) {
    const choice = createNode(form, "div", "glitter-write-stage__choice");
    createNode(choice, "h3", "glitter-write-stage__choice-title", state.choice.title);

    state.choice.options.forEach((option) => {
      const optionButton = createButton(choice, "glitter-write-stage__choice-option", "", () => actions.onSubmit());
      optionButton.dataset.choiceId = option.id;
      createNode(optionButton, "strong", "glitter-write-stage__choice-label", option.label);
      createNode(optionButton, "span", "glitter-write-stage__choice-description", option.description);
    });
  }

  const footer = createNode(stage, "footer", "glitter-write-stage__footer");
  createButton(
    footer,
    "glitter-write-stage__action-secondary",
    state.footer.secondaryAction.label,
    () => actions.onClose()
  );
  const primaryButton = createButton(
    footer,
    `glitter-write-stage__action-primary glitter-write-stage__action-primary--${state.footer.primaryAction.tone}`,
    state.footer.primaryAction.label,
    () => actions.onSubmit()
  );
  primaryButton.disabled = state.footer.primaryAction.disabled === true;

  if (state.footer.statusText) {
    createNode(footer, "p", "glitter-write-stage__status", state.footer.statusText);
  }
}
