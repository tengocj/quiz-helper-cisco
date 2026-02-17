const quizBadge = document.getElementById("quizBadge");
const questionProgress = document.getElementById("questionProgress");
const codeSnippet = document.getElementById("codeSnippet");
const possibleAnswers = document.getElementById("possibleAnswers");
const copyQaBtn = document.getElementById("copyQaBtn");
const copyQaState = document.getElementById("copyQaState");
const pinBtn = document.getElementById("pinBtn");
const pinState = document.getElementById("pinState");
const openaiApiKeyInput = document.getElementById("openaiApiKey");
const aiEnabled = document.getElementById("aiEnabled");
const aiAnswer = document.getElementById("aiAnswer");
const aiStatus = document.getElementById("aiStatus");
const updatedAt = document.getElementById("updatedAt");
const AI_MODEL = "gpt-5-mini";
const monitorShell = document.querySelector(".shell");
let pipWindowRef = null;
let settingsSaveTimer = null;
let currentState = {
  questionProgress: "-",
  codeSnippet: "-",
  possibleAnswers: [],
  multiSelect: false,
  sourceTabId: null,
  sourceFrameId: null,
};
let lastAiHash = "";
let lastMarkingHash = "";
let aiRequestRunning = false;
let aiRequestQueued = false;

function updatePinUi() {
  const pinned = Boolean(pipWindowRef && !pipWindowRef.closed);
  pinBtn.textContent = pinned ? "Unpin" : "Pin On Top";
  pinState.textContent = pinned ? "Pinned (always on top)" : "Not pinned";
}

function restoreFromPip() {
  if (monitorShell && monitorShell.parentNode !== document.body) {
    document.body.insertBefore(monitorShell, document.body.firstChild);
  }
  pipWindowRef = null;
  updatePinUi();
}

async function togglePinOnTop() {
  if (pipWindowRef && !pipWindowRef.closed) {
    pipWindowRef.close();
    restoreFromPip();
    return;
  }
  if (!("documentPictureInPicture" in window)) {
    pinState.textContent = "Pin on top not supported in this Chrome version";
    return;
  }
  try {
    const pipWindow = await window.documentPictureInPicture.requestWindow({
      width: 460,
      height: 720,
    });
    pipWindowRef = pipWindow;
    const styleLink = pipWindow.document.createElement("link");
    styleLink.rel = "stylesheet";
    styleLink.href = chrome.runtime.getURL("monitor.css");
    pipWindow.document.head.append(styleLink);
    pipWindow.document.body.style.margin = "0";
    pipWindow.document.body.append(monitorShell);
    pipWindow.addEventListener("pagehide", () => {
      restoreFromPip();
    });
    updatePinUi();
  } catch {
    pinState.textContent = "Pin on top failed";
  }
}

function normalizeAnswers(answers) {
  if (!Array.isArray(answers)) {
    return [];
  }
  return answers.filter(
    (answer) => typeof answer === "string" && answer.trim().length > 0,
  );
}

function normalizeAnswerIndices(indices) {
  if (!Array.isArray(indices)) {
    return [];
  }
  const unique = new Set();
  for (const value of indices) {
    const idx = Number.parseInt(value, 10);
    if (!Number.isInteger(idx) || idx < 0) {
      continue;
    }
    unique.add(idx);
  }
  return Array.from(unique).sort((a, b) => a - b);
}

function formatPossibleAnswers(answers) {
  const normalized = normalizeAnswers(answers);
  if (normalized.length === 0) {
    return "-";
  }
  return normalized
    .map((answer, index) => `${index + 1}. ${answer}`)
    .join("\n");
}

function buildCopyText(state) {
  const question = state.questionProgress || "-";
  const answers = normalizeAnswers(state.possibleAnswers);
  const formattedAnswers =
    answers.length > 0
      ? answers.map((answer, index) => `${index + 1}. ${answer}`).join("\n")
      : "-";
  return `Question:\n${question}\n\nPossible Answers:\n${formattedAnswers}`;
}

async function handleCopyQa() {
  try {
    await navigator.clipboard.writeText(buildCopyText(currentState));
    copyQaState.textContent = "Copied";
  } catch {
    copyQaState.textContent = "Copy failed";
  }
}

function buildAiPrompt(state) {
  const answersBlock = state.possibleAnswers
    .map((answer, index) => `${index + 1}. ${answer}`)
    .join("\n");
  const hasCode = state.codeSnippet && state.codeSnippet !== "-";
  const codeBlock = hasCode ? `\nCode Snippet:\n${state.codeSnippet}\n` : "\n";
  const questionType = state.multiSelect
    ? "multiple answers can be correct (checkbox)"
    : "single answer is correct (radio)";
  return `Question Type: ${questionType}

Question:
${state.questionProgress}${codeBlock}
Possible Answers:
${answersBlock}

Return JSON only with:
{
  "answer_indices": [<0-based integer index>, ...],
  "reason": "<short reason>"
}`;
}

function getAiHash(state) {
  return JSON.stringify({
    question: state.questionProgress,
    codeSnippet: state.codeSnippet,
    possibleAnswers: state.possibleAnswers,
    multiSelect: state.multiSelect,
    sourceTabId: state.sourceTabId,
    sourceFrameId: state.sourceFrameId,
  });
}

function clearAiResult(status) {
  aiAnswer.textContent = "-";
  aiStatus.textContent = status;
}

function getMarkingHash(state, answerIndices) {
  return JSON.stringify({
    tabId: state.sourceTabId,
    frameId: state.sourceFrameId,
    question: state.questionProgress,
    answers: state.possibleAnswers,
    answerIndices: normalizeAnswerIndices(answerIndices),
  });
}

async function sendAiMarking(answerIndices) {
  if (!Number.isInteger(currentState.sourceTabId)) {
    return;
  }
  const normalizedIndices = normalizeAnswerIndices(answerIndices);
  const hash = getMarkingHash(currentState, normalizedIndices);
  if (hash === lastMarkingHash) {
    return;
  }
  lastMarkingHash = hash;
  await chrome.runtime
    .sendMessage({
      type: "APPLY_AI_MARKING",
      payload: {
        tabId: currentState.sourceTabId,
        frameId: Number.isInteger(currentState.sourceFrameId)
          ? currentState.sourceFrameId
          : null,
        answerIndices: normalizedIndices,
      },
    })
    .catch(() => {});
}

function scheduleSettingsSave() {
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer);
  }
  settingsSaveTimer = setTimeout(() => {
    chrome.storage.local
      .set({
        openaiApiKey: openaiApiKeyInput.value.trim(),
        aiAutoAnswerEnabled: Boolean(aiEnabled.checked),
      })
      .catch(() => {});
  }, 180);
}

async function fetchAiAnswer(apiKey, state) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You solve one multiple-choice question. Return only JSON with keys answer_indices (array of 0-based integers) and reason (short string). For single-choice, return exactly one index.",
        },
        {
          role: "user",
          content: buildAiPrompt(state),
        },
      ],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      data?.error?.message || `OpenAI request failed (${response.status})`;
    throw new Error(message);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("Invalid OpenAI response");
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("OpenAI response was not valid JSON");
  }
  const answerIndices = Array.isArray(parsed?.answer_indices)
    ? normalizeAnswerIndices(parsed.answer_indices)
    : [];
  if (answerIndices.length === 0) {
    throw new Error("OpenAI returned no valid answer indices");
  }
  return {
    answerIndices,
    reason:
      typeof parsed?.reason === "string" && parsed.reason.trim().length > 0
        ? parsed.reason.trim()
        : "",
  };
}

async function maybeAutoAnswer() {
  if (!aiEnabled.checked) {
    clearAiResult("AI disabled");
    await sendAiMarking(null);
    return;
  }
  const apiKey = openaiApiKeyInput.value.trim();
  if (!apiKey) {
    clearAiResult("Add API key to enable AI");
    await sendAiMarking(null);
    return;
  }
  const question = (currentState.questionProgress || "").trim();
  if (!question || question === "-") {
    clearAiResult("Waiting for question");
    await sendAiMarking(null);
    return;
  }
  if (
    !currentState.possibleAnswers ||
    currentState.possibleAnswers.length === 0
  ) {
    clearAiResult("Waiting for possible answers");
    await sendAiMarking(null);
    return;
  }
  const hash = getAiHash(currentState);
  if (hash === lastAiHash) {
    return;
  }
  if (aiRequestRunning) {
    aiRequestQueued = true;
    return;
  }
  aiRequestRunning = true;
  aiStatus.textContent = "Thinking...";
  await sendAiMarking(null);
  try {
    const result = await fetchAiAnswer(apiKey, currentState);
    const validIndicesRaw = result.answerIndices.filter(
      (idx) => idx >= 0 && idx < currentState.possibleAnswers.length,
    );
    const validIndices = currentState.multiSelect
      ? validIndicesRaw
      : validIndicesRaw.slice(0, 1);
    if (validIndices.length === 0) {
      aiAnswer.textContent = "-";
      aiStatus.textContent = "AI returned invalid option";
      await sendAiMarking(null);
      lastAiHash = hash;
    } else {
      aiAnswer.textContent = validIndices
        .map((idx) => `${idx + 1}. ${currentState.possibleAnswers[idx]}`)
        .join("\n");
      aiStatus.textContent =
        result.reason || `AI selected ${validIndices.length} option(s)`;
      await sendAiMarking(validIndices);
      lastAiHash = hash;
    }
  } catch (error) {
    aiAnswer.textContent = "-";
    aiStatus.textContent = `AI error: ${
      error instanceof Error ? error.message : "Request failed"
    }`;
    await sendAiMarking(null);
    lastAiHash = hash;
  } finally {
    aiRequestRunning = false;
    if (aiRequestQueued) {
      aiRequestQueued = false;
      maybeAutoAnswer();
    }
  }
}

function render(state) {
  const quizOn = Boolean(state.quizDetected);
  const answers = normalizeAnswers(state.possibleAnswers);
  currentState = {
    questionProgress: state.questionProgress || "-",
    codeSnippet: state.codeSnippet || "-",
    possibleAnswers: answers,
    multiSelect: Boolean(state.multiSelect),
    sourceTabId: Number.isInteger(state.sourceTabId) ? state.sourceTabId : null,
    sourceFrameId: Number.isInteger(state.sourceFrameId)
      ? state.sourceFrameId
      : null,
  };
  quizBadge.textContent = quizOn ? "Quiz detected" : "No quiz";
  quizBadge.className = quizOn ? "badge on" : "badge off";
  questionProgress.textContent = state.questionProgress || "-";
  codeSnippet.textContent = state.codeSnippet || "-";
  possibleAnswers.textContent = formatPossibleAnswers(answers);
  updatedAt.textContent = state.updatedAt
    ? new Date(state.updatedAt).toLocaleString()
    : "-";
  maybeAutoAnswer();
}

async function init() {
  const [state, settings] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_STATUS" }),
    chrome.storage.local.get({
      openaiApiKey: "",
      aiAutoAnswerEnabled: false,
    }),
  ]);
  openaiApiKeyInput.value = settings.openaiApiKey || "";
  aiEnabled.checked = Boolean(settings.aiAutoAnswerEnabled);
  render(state);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "STATUS_PUSH") {
    render(message.payload);
  }
});

copyQaBtn.addEventListener("click", () => {
  handleCopyQa();
});

pinBtn.addEventListener("click", () => {
  togglePinOnTop();
});

openaiApiKeyInput.addEventListener("input", () => {
  lastAiHash = "";
  scheduleSettingsSave();
  maybeAutoAnswer();
});

aiEnabled.addEventListener("change", () => {
  lastAiHash = "";
  scheduleSettingsSave();
  maybeAutoAnswer();
});

window.addEventListener("beforeunload", () => {
  if (pipWindowRef && !pipWindowRef.closed) {
    pipWindowRef.close();
  }
});

updatePinUi();
init();
