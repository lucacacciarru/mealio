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
    {
      name: 'mealio-public-asset-manifest',
      generateBundle(_options, bundle) {
        if (this.environment.name !== 'client') return
        this.emitFile({
          type: 'asset',
          fileName: 'mealio-assets.json',
          source: JSON.stringify(Object.keys(bundle).filter((name) => name.startsWith('assets/')).map((name) => `/${name}`)),
        })
      },
    },
    tanstackStart({
      spa: {
        enabled: true,
      },
    }),
    nitro({ preset: 'node-server' }),
    viteReact(),
  ],
})
