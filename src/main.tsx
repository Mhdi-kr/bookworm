import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { registerWebOffline } from "./lib/offline/register";
import "./index.css";

void registerWebOffline();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
