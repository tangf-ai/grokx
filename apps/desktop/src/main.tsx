import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Overlay title bar + traffic-light insets only apply on macOS (Tauri titleBarStyle).
if (
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent)
) {
  document.documentElement.classList.add("platform-mac");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
