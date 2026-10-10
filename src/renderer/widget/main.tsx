import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Widget } from './Widget'
import './widget.css'
import './border-beam.css'

const container = document.getElementById('root')
if (!container) throw new Error('widget root element is missing')

// The widget must never take keyboard focus: under Wayland a focused window would
// receive the synthetic Ctrl+V instead of the user's application. Only the review
// and dismiss buttons are meant to be clickable, so text selection and drag are off.
window.addEventListener('mousedown', (event) => {
  const target = event.target as HTMLElement | null
  if (target?.closest('button')) return
  event.preventDefault()
})
window.addEventListener('contextmenu', (event) => event.preventDefault())

createRoot(container).render(
  <StrictMode>
    <Widget />
  </StrictMode>
)