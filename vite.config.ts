import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  root: "site",
  base: "/rune/",
  plugins: [react()],
  build: {
    emptyOutDir: true,
    outDir: "../dist",
  },
})
