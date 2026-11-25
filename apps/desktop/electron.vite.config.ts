import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // renderWorker runs OpenSCAD in its own utility process (see
        // src/main/renderHost.ts), so it is an entry of its own.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          renderWorker: resolve(__dirname, 'src/main/renderWorker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    worker: {
      format: 'es',
    },
    plugins: [react()],
  },
});
