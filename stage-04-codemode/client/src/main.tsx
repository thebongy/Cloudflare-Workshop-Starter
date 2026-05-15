import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { WorkshopApp } from "./WorkshopApp"
import "@cloudflare/kumo/styles/standalone"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkshopApp />
  </StrictMode>,
)
