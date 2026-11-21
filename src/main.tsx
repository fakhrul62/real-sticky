import { createRoot } from 'react-dom/client'
import * as Tooltip from '@radix-ui/react-tooltip'
import '@fontsource-variable/dm-sans'
import '@fontsource-variable/space-grotesk'
import './styles.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <Tooltip.Provider delayDuration={450} skipDelayDuration={200}>
    <App />
  </Tooltip.Provider>,
)
