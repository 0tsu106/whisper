import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { log } from "./logger";
import { JobDetailPage } from "./pages/JobDetailPage";
import { JobListPage } from "./pages/JobListPage";
import { NewJobPage } from "./pages/NewJobPage";
import "./styles.css";

window.addEventListener("error", (event) => log.error("window.error", { message: event.message }));
window.addEventListener("unhandledrejection", (event) =>
  log.error("window.unhandled_rejection", { reason: String(event.reason) }),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <header className="app-header">
        <Link to="/">文字起こし</Link>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<JobListPage />} />
          <Route path="/new" element={<NewJobPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="*" element={<p className="muted">ページが見つかりません。</p>} />
        </Routes>
      </main>
    </BrowserRouter>
  </StrictMode>,
);
