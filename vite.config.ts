import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT ?? 5009),
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tanstackStart({
      spa: {
        enabled: true,
      },
    }),
    nitro({ preset: 'node-server' }),
    viteReact(),
  ],
})
