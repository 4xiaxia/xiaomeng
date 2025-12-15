import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// For internal debugging, a placeholder key is preset for out-of-the-box use.
const GEMINI_API_KEY = "AIzaSyB07l3ddIh_igdTVDdDkVI9sKZxjCQTJOw";

export default defineConfig(({ mode }) => {
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
