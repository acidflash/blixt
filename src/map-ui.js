export const compactLayout = matchMedia('(max-width: 900px), (max-height: 500px)')
export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')

export function setupMapUI(map) {
  const root = document.documentElement
  const layers = document.getElementById('map-controls')
  const legend = document.getElementById('legend')
  const pairs = [
    [document.getElementById('layers-toggle'), layers],
    [document.getElementById('legend-toggle'), legend],
  ]
  let active = null
  let popup = null
  let frame = null

  function closePanel(restoreFocus = false) {
    if (!active) return
    const [button, panel] = active
    panel.classList.remove('is-open')
    button.setAttribute('aria-expanded', 'false')
    active = null
    if (restoreFocus) button.focus({ preventScroll: true })
  }

  for (const pair of pairs) {
    const [button, panel] = pair
    button.addEventListener('click', () => {
      const wasOpen = active === pair
      closePanel()
      if (!wasOpen) {
        map.closePopup()
        active = pair
        panel.classList.add('is-open')
        panel.scrollTop = 0
        button.setAttribute('aria-expanded', 'true')
        panel.focus({ preventScroll: true })
      }
    })
  }

  document.addEventListener('pointerdown', event => {
    if (active && !active.some(element => element.contains(event.target))) closePanel()
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active) {
      event.preventDefault()
      event.stopPropagation()
      closePanel(true)
    }
  }, true)

  function layout() {
    frame = null
    const attribution = document.querySelector('.leaflet-control-attribution')
    root.style.setProperty('--bottom', `calc(${Math.max(32, (attribution?.offsetHeight ?? 0) + 12)}px + env(safe-area-inset-bottom))`)
    root.style.setProperty('--layers-height', `${layers.offsetHeight}px`)
    const status = document.getElementById('status').getBoundingClientRect()
    const location = document.getElementById('location-status')
    root.style.setProperty('--notice-top', `${status.bottom + 8}px`)
    const errorTop = location.hidden ? status.bottom + 8 : location.getBoundingClientRect().bottom + 8
    root.style.setProperty('--map-error-top', `${errorTop}px`)
    map.invalidateSize({ animate: false })
    if (!popup || map.getContainer().classList.contains('leaflet-zoom-anim')) return

    const size = map.getSize()
    let top = status.bottom + 12
    for (const id of ['location-status', 'map-error']) {
      const element = document.getElementById(id)
      if (!element.hidden) top = Math.max(top, element.getBoundingClientRect().bottom + 12)
    }
    const left = 72
    const right = compactLayout.matches ? 12 : layers.offsetWidth + 24
    const bottom = compactLayout.matches
      ? size.y - document.getElementById('mobile-controls').getBoundingClientRect().top + 12
      : (attribution?.offsetHeight ?? 0) + 20
    Object.assign(popup.options, {
      minWidth: 80,
      maxWidth: Math.max(80, Math.min(320, size.x - left - right - 68)),
      maxHeight: Math.max(44, size.y - top - bottom - 56),
      autoPan: false,
    })
    popup.update()
    // Fit the rendered popup after layout/zoom has settled. Starting Leaflet's
    // animated autopan while another pan is running can move it off screen.
    const bounds = popup.getElement().getBoundingClientRect()
    let dx = Math.max(0, bounds.right - (size.x - right))
    let dy = Math.max(0, bounds.bottom - (size.y - bottom))
    if (bounds.left - dx < left) dx = bounds.left - left
    if (bounds.top - dy < top) dy = bounds.top - top
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) map.panBy([dx, dy], { animate: false })
  }

  function scheduleLayout() {
    if (frame === null) frame = requestAnimationFrame(layout)
  }

  const observer = new ResizeObserver(scheduleLayout)
  for (const element of [layers, document.getElementById('status'), document.getElementById('location-status'),
    document.getElementById('map-error'), document.querySelector('.leaflet-control-attribution')]) {
    if (element) observer.observe(element)
  }
  compactLayout.addEventListener('change', () => {
    const focused = document.activeElement
    closePanel()
    for (const [button, panel] of pairs) {
      if (compactLayout.matches && panel.contains(focused)) button.focus({ preventScroll: true })
      if (!compactLayout.matches && focused === button) panel.focus({ preventScroll: true })
    }
    scheduleLayout()
  })
  window.addEventListener('resize', scheduleLayout)
  window.visualViewport?.addEventListener('resize', scheduleLayout)
  map.on('popupopen', event => {
    closePanel()
    popup = event.popup
    popup.getElement()?.querySelector('.leaflet-popup-close-button')?.setAttribute('aria-label', 'Stäng information')
    scheduleLayout()
  })
  map.on('popupclose', () => { popup = null })
  map.on('zoomend', scheduleLayout)
  scheduleLayout()
}

const layerStates = new Map()
const layerLabels = { loading: 'Hämtar…', ready: 'Visas', empty: 'Inga data', error: 'Kunde inte hämta', stale: 'Äldre data visas' }

export function setLayerState(id, state) {
  layerStates.set(id, state)
  renderLayerState(id)
}

export function setLayerEnabled(id, enabled) {
  document.getElementById(`${id}-toggle`).setAttribute('aria-pressed', String(enabled))
  renderLayerState(id)
}

function renderLayerState(id) {
  const button = document.getElementById(`${id}-toggle`)
  const enabled = button.getAttribute('aria-pressed') === 'true'
  const state = layerStates.get(id) ?? 'loading'
  button.dataset.state = state
  button.setAttribute('aria-busy', String(state === 'loading'))
  document.getElementById(`${id}-state`).textContent = !enabled
    ? `Av · ${state === 'ready' ? 'Data tillgängliga' : state === 'stale' ? 'Äldre data' : layerLabels[state]}`
    : layerLabels[state]
}
