if (!window.__quizHelperActive) {
  window.__quizHelperActive = true;

  const QUESTION_SELECTOR = ".component__body.mcq__body";
  const CODE_PRECODE_SELECTOR = "code-window-webcomponent-mcq[precode]";
  const CODE_LINE_SELECTORS = [
    "pre.line-numbers .command",
    "pre[class*='line-numbers'] .command",
    "code-window-webcomponent-mcq .command",
  ];
  const ANSWER_LABEL_SELECTOR =
    "label.mcq__item-label, .mcq__item-label.js-item-label";
  const MARK_STYLE_KEY = "quizHelperMarked";
  let monitorEnabled = false;
  let observer = null;
  let timer = null;
  let queued = false;
  let lastHash = "";

  function collectRoots(startRoot = document) {
    const roots = [];
    const seen = new Set();
    const queue = [startRoot];
    while (queue.length > 0) {
      const root = queue.pop();
      if (!root || seen.has(root)) {
        continue;
      }
      seen.add(root);
      roots.push(root);
      if (!root.querySelectorAll) {
        continue;
      }
      const all = root.querySelectorAll("*");
      for (const node of all) {
        if (node.shadowRoot) {
          queue.push(node.shadowRoot);
        }
        if (
          node.tagName === "TEMPLATE" &&
          node.hasAttribute("shadowrootmode") &&
          node.content
        ) {
          queue.push(node.content);
        }
      }
    }
    return roots;
  }

  function queryAllDeep(selector) {
    const found = new Set();
    const roots = collectRoots(document);
    for (const root of roots) {
      if (!root.querySelectorAll) {
        continue;
      }
      for (const node of root.querySelectorAll(selector)) {
        found.add(node);
      }
    }
    return Array.from(found);
  }

  function queryAllDeepIn(startRoot, selector) {
    const found = new Set();
    const roots = collectRoots(startRoot);
    for (const root of roots) {
      if (!root.querySelectorAll) {
        continue;
      }
      for (const node of root.querySelectorAll(selector)) {
        found.add(node);
      }
    }
    return Array.from(found);
  }

  function hasDeep(selector) {
    return queryAllDeep(selector).length > 0;
  }

  function normalizeText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeCodeLine(value) {
    return (value || "").replace(/\u00a0/g, " ").replace(/\s+$/g, "");
  }

  function trimTrailingEmptyLines(lines) {
    const next = [...lines];
    while (next.length > 0 && next[next.length - 1].trim().length === 0) {
      next.pop();
    }
    return next;
  }

  function decodeHtml(value) {
    const parser = new DOMParser().parseFromString(value || "", "text/html");
    return parser.documentElement.textContent || "";
  }

  function textFromFirst(selectors) {
    for (const selector of selectors) {
      const node = queryAllDeep(selector).find(
        (el) => (el.textContent || "").trim().length > 0,
      );
      if (node) {
        return normalizeText(node.textContent);
      }
    }
    return "-";
  }

  function isQuizDetected() {
    const hasAbsContainer = hasDeep(".abs__container.has-arrows");
    const hasBlockStrip = hasDeep(
      "assessment-block-strip-view, .attempted-blocks-wrapper",
    );
    const hasToolbar = hasDeep(
      "assessment-toolbar-view, .secure-toolbar-container",
    );
    const hasStart = hasDeep(
      "adaptive-start-screen-view, .assessment-start-screen, .start-button.start",
    );
    const hasMcq = hasDeep(
      "mcq-view, .component.is-question.mcq, .mcq__widget-inner",
    );
    const hasQuestionBody = hasDeep(QUESTION_SELECTOR);
    const hasQuestionLabel = hasDeep(
      ".question-label-container .question-label, .component__title-inner.mcq__title-inner",
    );
    const optionCount = queryAllDeep(
      ".mcq__item, .js-mcq-item, .mcq__item-label",
    ).length;
    if ((hasMcq || hasQuestionBody) && optionCount >= 2 && hasToolbar) {
      return true;
    }
    if (hasStart && hasToolbar) {
      return true;
    }
    const structureScore = [
      hasAbsContainer,
      hasBlockStrip,
      hasToolbar,
      hasQuestionLabel,
    ].filter(Boolean).length;
    return (
      structureScore >= 3 &&
      (hasMcq || hasQuestionBody || hasStart || optionCount >= 2)
    );
  }

  function getQuestionProgress() {
    return textFromFirst([
      `${QUESTION_SELECTOR} .component__body-inner`,
      QUESTION_SELECTOR,
      ".question-label-container .question-label",
      ".component__title-inner.mcq__title-inner",
      ".module-title",
    ]);
  }

  function closestAcrossShadow(node, selector) {
    let current = node;
    while (current) {
      if (current.matches && current.matches(selector)) {
        return current;
      }
      if (current.parentNode) {
        current = current.parentNode;
        continue;
      }
      if (current.host) {
        current = current.host;
        continue;
      }
      break;
    }
    return null;
  }

  function getActiveMcqContainer() {
    const questionNode = queryAllDeep(
      `${QUESTION_SELECTOR} .component__body-inner, ${QUESTION_SELECTOR}`,
    ).find((node) => normalizeText(node.textContent).length > 0);
    if (!questionNode) {
      return null;
    }
    return closestAcrossShadow(
      questionNode,
      ".component.is-question.mcq, mcq-view, .mcq__widget, .mcq__widget-inner",
    );
  }

  function getAnswerOrder(label, fallbackIndex) {
    const direct = Number.parseInt(
      label.getAttribute("data-socialgoodpulse-index") || "",
      10,
    );
    if (Number.isFinite(direct)) {
      return direct;
    }
    const fromId = (label.id || "").match(/-(\d+)-label$/);
    if (fromId) {
      return Number.parseInt(fromId[1], 10);
    }
    return fallbackIndex;
  }

  function extractAnswerFromLabel(label) {
    const preferred = label.querySelector(
      ".mcq__item-text-inner code.codel, .mcq__item-text-inner",
    );
    if (preferred) {
      return normalizeText(preferred.textContent);
    }
    return normalizeText(label.textContent);
  }

  function getOrderedAnswerLabels() {
    const activeContainer = getActiveMcqContainer();
    const labels = activeContainer
      ? queryAllDeepIn(activeContainer, ANSWER_LABEL_SELECTOR)
      : queryAllDeep(ANSWER_LABEL_SELECTOR);
    return labels
      .map((label, index) => ({
        label,
        order: getAnswerOrder(label, index),
      }))
      .sort((a, b) => a.order - b.order)
      .map((item) => item.label);
  }

  function getPossibleAnswers() {
    const labels = getOrderedAnswerLabels();
    return labels
      .map((label) => extractAnswerFromLabel(label))
      .filter((text) => text.length > 0);
  }

  function isMultiSelectQuestion() {
    const activeContainer = getActiveMcqContainer();
    const checkboxSelector =
      ".mcq__item-answer-icon.is-checkbox, material-icon[icon='check_box_outline_blank'], material-icon[icon='check_box']";
    if (activeContainer) {
      return queryAllDeepIn(activeContainer, checkboxSelector).length > 0;
    }
    return queryAllDeep(checkboxSelector).length > 0;
  }

  function normalizeAnswerIndices(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const unique = new Set();
    for (const entry of value) {
      const idx = Number.parseInt(entry, 10);
      if (!Number.isInteger(idx) || idx < 0) {
        continue;
      }
      unique.add(idx);
    }
    return Array.from(unique).sort((a, b) => a - b);
  }

  function clearAnswerMarking() {
    const labels = queryAllDeep(ANSWER_LABEL_SELECTOR);
    for (const label of labels) {
      if (label.dataset[MARK_STYLE_KEY] !== "1") {
        continue;
      }
      label.style.outline = "";
      label.style.outlineOffset = "";
      label.style.backgroundColor = "";
      label.style.borderRadius = "";
      label.style.transition = "";
      delete label.dataset[MARK_STYLE_KEY];
    }
  }

  function applyAnswerMarking(answerIndices) {
    clearAnswerMarking();
    const normalizedIndices = normalizeAnswerIndices(answerIndices);
    if (normalizedIndices.length === 0) {
      return;
    }
    const selected = new Set(normalizedIndices);
    const orderedLabels = getOrderedAnswerLabels();
    for (let idx = 0; idx < orderedLabels.length; idx += 1) {
      const label = orderedLabels[idx];
      const isCorrect = selected.has(idx);
      label.dataset[MARK_STYLE_KEY] = "1";
      label.style.outline = isCorrect ? "2px solid #16a34a" : "2px solid #dc2626";
      label.style.outlineOffset = "1px";
      label.style.backgroundColor = isCorrect
        ? "rgba(34, 197, 94, 0.18)"
        : "rgba(239, 68, 68, 0.16)";
      label.style.borderRadius = "8px";
      label.style.transition = "outline-color 120ms ease, background-color 120ms ease";
    }
  }

  function getCodeSnippetFromCommands() {
    for (const selector of CODE_LINE_SELECTORS) {
      const lines = queryAllDeep(selector).map((node) =>
        normalizeCodeLine(node.textContent),
      );
      if (lines.some((line) => line.trim().length > 0)) {
        return trimTrailingEmptyLines(lines).join("\n");
      }
    }
    return "";
  }

  function getCodeSnippetFromPrecodeAttribute() {
    const node = queryAllDeep(CODE_PRECODE_SELECTOR).find((el) =>
      el.hasAttribute("precode"),
    );
    if (!node) {
      return "";
    }
    try {
      const raw = node.getAttribute("precode") || "[]";
      const decoded = decodeHtml(raw);
      const parsed = JSON.parse(decoded);
      if (!Array.isArray(parsed)) {
        return "";
      }
      const lines = parsed.map((entry) => {
        if (typeof entry === "string") {
          return normalizeCodeLine(entry);
        }
        return normalizeCodeLine(entry?.text);
      });
      const result = trimTrailingEmptyLines(lines).join("\n");
      return result.trim().length > 0 ? result : "";
    } catch {
      return "";
    }
  }

  function getCodeSnippet() {
    const fromCommands = getCodeSnippetFromCommands();
    if (fromCommands) {
      return fromCommands;
    }
    const fromPrecode = getCodeSnippetFromPrecodeAttribute();
    if (fromPrecode) {
      return fromPrecode;
    }
    return "-";
  }

  function sendState() {
    if (!monitorEnabled) {
      return;
    }
    const payload = {
      quizDetected: isQuizDetected(),
      questionProgress: getQuestionProgress(),
      possibleAnswers: getPossibleAnswers(),
      multiSelect: isMultiSelectQuestion(),
      codeSnippet: getCodeSnippet(),
      pageTitle: document.title || "-",
      url: location.href,
      updatedAt: new Date().toISOString(),
    };
    const nextHash = JSON.stringify(payload);
    if (nextHash === lastHash) {
      return;
    }
    lastHash = nextHash;
    chrome.runtime
      .sendMessage({ type: "QUIZ_STATE_UPDATE", payload })
      .catch(() => {});
  }

  function queueScan() {
    if (!monitorEnabled || queued) {
      return;
    }
    queued = true;
    setTimeout(() => {
      queued = false;
      sendState();
    }, 120);
  }

  function startWatching() {
    if (observer || !document.documentElement) {
      return;
    }
    observer = new MutationObserver(() => {
      queueScan();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    timer = window.setInterval(() => {
      sendState();
    }, 1500);
    sendState();
  }

  function stopWatching() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (timer) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  function applyState() {
    if (monitorEnabled) {
      startWatching();
    } else {
      stopWatching();
    }
  }

  chrome.storage.local.get({ monitorEnabled: false }, (data) => {
    monitorEnabled = Boolean(data.monitorEnabled);
    applyState();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.monitorEnabled) {
      return;
    }
    monitorEnabled = Boolean(changes.monitorEnabled.newValue);
    applyState();
    if (monitorEnabled) {
      sendState();
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "REQUEST_SCAN") {
      sendState();
      return;
    }
    if (message?.type === "APPLY_AI_MARKING") {
      const answerIndices = Array.isArray(message.payload?.answerIndices)
        ? message.payload.answerIndices
        : [];
      applyAnswerMarking(answerIndices);
    }
  });
}
