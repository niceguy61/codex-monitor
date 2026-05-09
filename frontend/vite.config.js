import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import process from 'node:process'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': process.env.VITE_DEV_PROXY_TARGET || 'http://127.0.0.1:3001',
      '/codex': process.env.VITE_DEV_PROXY_TARGET || 'http://127.0.0.1:3001',
    },
  },
})
