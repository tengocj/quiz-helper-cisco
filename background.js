let monitorEnabled = false;
let monitorWindowId = null;
let activeQuizTabId = null;
const tabStates = new Map();
const tabFrameStates = new Map();

async function loadSettings() {
  const data = await chrome.storage.local.get({ monitorEnabled: false });
  monitorEnabled = Boolean(data.monitorEnabled);
}

function getFrameMap(tabId) {
  let frameMap = tabFrameStates.get(tabId);
  if (!frameMap) {
    frameMap = new Map();
    tabFrameStates.set(tabId, frameMap);
  }
  return frameMap;
}

function getDetectedTabId() {
  let detectedTabId = null;
  let detectedTime = 0;
  for (const [tabId, state] of tabStates) {
    if (!state.quizDetected) {
      continue;
    }
    const time = new Date(state.updatedAt).getTime();
    if (time >= detectedTime) {
      detectedTime = time;
      detectedTabId = tabId;
    }
  }
  return detectedTabId;
}

function computeTabState(tabId, tabMeta) {
  const frameMap = tabFrameStates.get(tabId);
  if (!frameMap || frameMap.size === 0) {
    return null;
  }
  let latest = null;
  let latestQuiz = null;
  for (const [, frameState] of frameMap) {
    if (
      !latest ||
      new Date(frameState.updatedAt).getTime() >=
        new Date(latest.updatedAt).getTime()
    ) {
      latest = frameState;
    }
    if (frameState.quizDetected) {
      if (
        !latestQuiz ||
        new Date(frameState.updatedAt).getTime() >=
          new Date(latestQuiz.updatedAt).getTime()
      ) {
        latestQuiz = frameState;
      }
    }
  }
  const selected = latestQuiz || latest;
  if (!selected) {
    return null;
  }
  return {
    tabId,
    windowId: selected.windowId ?? tabMeta?.windowId ?? null,
    frameId: selected.frameId ?? null,
    quizDetected: Boolean(latestQuiz),
    questionProgress: selected.questionProgress || "-",
    possibleAnswers: Array.isArray(selected.possibleAnswers)
      ? selected.possibleAnswers
      : [],
    multiSelect: Boolean(selected.multiSelect),
    codeSnippet: selected.codeSnippet || "-",
    pageTitle: selected.pageTitle || tabMeta?.title || "-",
    url: selected.url || tabMeta?.url || "-",
    updatedAt: selected.updatedAt || new Date().toISOString(),
  };
}

function getLatestState() {
  if (activeQuizTabId !== null) {
    const active = tabStates.get(activeQuizTabId);
    if (active) {
      return active;
    }
  }
  let latest = null;
  for (const [, value] of tabStates) {
    if (!latest) {
      latest = value;
      continue;
    }
    if (
      new Date(value.updatedAt).getTime() >=
      new Date(latest.updatedAt).getTime()
    ) {
      latest = value;
    }
  }
  return latest;
}

function getSnapshot() {
  const latest = getLatestState();
  return {
    monitorEnabled,
    quizDetected: Boolean(latest?.quizDetected),
    questionProgress: latest?.questionProgress || "-",
    possibleAnswers: Array.isArray(latest?.possibleAnswers)
      ? latest.possibleAnswers
      : [],
    multiSelect: Boolean(latest?.multiSelect),
    codeSnippet: latest?.codeSnippet || "-",
    pageTitle: latest?.pageTitle || "-",
    url: latest?.url || "-",
    updatedAt: latest?.updatedAt || null,
    sourceTabId: latest?.tabId ?? null,
    sourceFrameId: latest?.frameId ?? null,
  };
}

function pushSnapshot() {
  chrome.runtime
    .sendMessage({ type: "STATUS_PUSH", payload: getSnapshot() })
    .catch(() => {});
}

function updateBadge() {
  if (!monitorEnabled) {
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
    return;
  }
  const hasDetected = getDetectedTabId() !== null;
  if (hasDetected) {
    chrome.action.setBadgeBackgroundColor({ color: "#0f62fe" }).catch(() => {});
    chrome.action.setBadgeText({ text: "QUIZ" }).catch(() => {});
    return;
  }
  chrome.action.setBadgeBackgroundColor({ color: "#64748b" }).catch(() => {});
  chrome.action.setBadgeText({ text: "ON" }).catch(() => {});
}

async function setMonitorEnabled(value) {
  monitorEnabled = Boolean(value);
  await chrome.storage.local.set({ monitorEnabled });
  if (!monitorEnabled) {
    activeQuizTabId = null;
  }
  updateBadge();
  pushSnapshot();
  if (monitorEnabled) {
    await openMonitorWindow({ focused: true });
    requestScans();
  }
}

function notifyQuizStarted(url) {
  chrome.action.setBadgeBackgroundColor({ color: "#0f62fe" }).catch(() => {});
  chrome.action.setBadgeText({ text: "QUIZ" }).catch(() => {});
  chrome.runtime
    .sendMessage({
      type: "STATUS_PUSH",
      payload: {
        ...getSnapshot(),
        questionProgress: `Quiz detected: ${url}`,
      },
    })
    .catch(() => {});
}

function requestScans() {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id || !tab.url) {
        continue;
      }
      chrome.scripting
        .executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ["content.js"],
        })
        .catch(() => {});
      chrome.tabs.sendMessage(tab.id, { type: "REQUEST_SCAN" }).catch(() => {});
    }
  });
}

async function openMonitorWindow(options = {}) {
  const focused = options.focused !== false;
  if (monitorWindowId !== null) {
    if (focused) {
      try {
        await chrome.windows.update(monitorWindowId, { focused: true });
      } catch {
        monitorWindowId = null;
      }
    }
    if (monitorWindowId !== null) {
      return;
    }
  }
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL("monitor.html"),
    type: "popup",
    width: 460,
    height: 620,
    focused,
  });
  monitorWindowId = created.id ?? null;
}

async function focusSourceWindow(windowId) {
  if (typeof windowId !== "number") {
    return;
  }
  await chrome.windows.update(windowId, { focused: true }).catch(() => {});
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === monitorWindowId) {
    monitorWindowId = null;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  tabFrameStates.delete(tabId);
  if (activeQuizTabId === tabId) {
    activeQuizTabId = getDetectedTabId();
  }
  updateBadge();
  pushSnapshot();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabStates.delete(tabId);
    tabFrameStates.delete(tabId);
    if (activeQuizTabId === tabId) {
      activeQuizTabId = getDetectedTabId();
    }
    updateBadge();
    pushSnapshot();
  }
  if (!monitorEnabled) {
    return;
  }
  if (changeInfo.status === "complete") {
    chrome.scripting
      .executeScript({
        target: { tabId, allFrames: true },
        files: ["content.js"],
      })
      .catch(() => {});
    chrome.tabs.sendMessage(tabId, { type: "REQUEST_SCAN" }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_STATUS") {
    sendResponse(getSnapshot());
    return;
  }

  if (message?.type === "TOGGLE_MONITOR") {
    setMonitorEnabled(!monitorEnabled).then(() => {
      sendResponse(getSnapshot());
    });
    return true;
  }

  if (message?.type === "OPEN_MONITOR_WINDOW") {
    openMonitorWindow({ focused: true }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "APPLY_AI_MARKING") {
    const requestedTabId = Number.isInteger(message.payload?.tabId)
      ? message.payload.tabId
      : null;
    const requestedFrameId = Number.isInteger(message.payload?.frameId)
      ? message.payload.frameId
      : null;
    const tabId = requestedTabId ?? activeQuizTabId;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, reason: "no-target-tab" });
      return;
    }
    const forwardPayload = {
      type: "APPLY_AI_MARKING",
      payload: {
        answerIndices: Array.isArray(message.payload?.answerIndices)
          ? message.payload.answerIndices
          : [],
      },
    };
    const sendMarking =
      requestedFrameId !== null
        ? chrome.tabs
            .sendMessage(tabId, forwardPayload, { frameId: requestedFrameId })
            .catch(() => chrome.tabs.sendMessage(tabId, forwardPayload))
        : chrome.tabs.sendMessage(tabId, forwardPayload);
    sendMarking
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch(() => {
        sendResponse({ ok: false, reason: "send-failed" });
      });
    return true;
  }

  if (message?.type === "QUIZ_STATE_UPDATE" && sender.tab?.id) {
    const tabId = sender.tab.id;
    const frameId = typeof sender.frameId === "number" ? sender.frameId : 0;
    const prev = tabStates.get(tabId);
    const frameMap = getFrameMap(tabId);
    frameMap.set(frameId, {
      tabId,
      frameId,
      windowId: sender.tab.windowId,
      quizDetected: Boolean(message.payload?.quizDetected),
      questionProgress: message.payload?.questionProgress || "-",
      possibleAnswers: Array.isArray(message.payload?.possibleAnswers)
        ? message.payload.possibleAnswers
        : [],
      multiSelect: Boolean(message.payload?.multiSelect),
      codeSnippet: message.payload?.codeSnippet || "-",
      pageTitle: message.payload?.pageTitle || sender.tab.title || "-",
      url: message.payload?.url || sender.url || sender.tab.url || "-",
      updatedAt: message.payload?.updatedAt || new Date().toISOString(),
    });
    const curr = computeTabState(tabId, sender.tab);
    if (curr) {
      tabStates.set(tabId, curr);
    } else {
      tabStates.delete(tabId);
    }
    if (curr?.quizDetected) {
      activeQuizTabId = tabId;
    }
    if (
      prev?.quizDetected &&
      !curr?.quizDetected &&
      activeQuizTabId === tabId
    ) {
      activeQuizTabId = getDetectedTabId();
    }
    if (monitorEnabled && !prev?.quizDetected && curr?.quizDetected) {
      notifyQuizStarted(curr.url);
      openMonitorWindow({ focused: false }).catch(() => {});
      focusSourceWindow(curr.windowId).catch(() => {});
    }
    updateBadge();
    pushSnapshot();
  }
});

loadSettings().then(() => {
  updateBadge();
  pushSnapshot();
});
