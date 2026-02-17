const monitorState = document.getElementById("monitorState");
const quizState = document.getElementById("quizState");
const quizInfo = document.getElementById("quizInfo");
const toggleBtn = document.getElementById("toggleBtn");
const windowBtn = document.getElementById("windowBtn");

function render(state) {
  monitorState.textContent = state.monitorEnabled ? "enabled" : "disabled";
  quizState.textContent = state.quizDetected ? "yes" : "no";
  const infoParts = [state.questionProgress, state.pageTitle, state.url].filter(
    (x) => x && x !== "-",
  );
  quizInfo.textContent = infoParts.length > 0 ? infoParts.join(" | ") : "-";
  toggleBtn.textContent = state.monitorEnabled
    ? "Disable monitoring"
    : "Enable monitoring";
}

async function loadStatus() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  render(state);
}

toggleBtn.addEventListener("click", async () => {
  const state = await chrome.runtime.sendMessage({ type: "TOGGLE_MONITOR" });
  render(state);
});

windowBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "OPEN_MONITOR_WINDOW" });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "STATUS_PUSH") {
    render(message.payload);
  }
});

loadStatus();
