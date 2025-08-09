// vite.config.js
export default {
  server: { port: 5173, hmr: { overlay: false } },
  build: {
    rollupOptions: {
      input: 'index.html',   // ONLY build the main page
    }
  }
}
