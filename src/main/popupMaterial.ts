import type { BrowserWindow } from 'electron'

/** Keep the native desktop blur inside the same inset rounded surface as the renderer. */
export function attachPopupMaterial(window: BrowserWindow): void {
  if (process.platform !== 'darwin') return

  try {
    // Load AppKit only on macOS; koffi already ships with the application.
    const koffi: typeof import('koffi') = require('koffi')
    const objc = koffi.load('/usr/lib/libobjc.A.dylib')
    const selector = objc.func('void *sel_registerName(const char *name)')
    const getClass = objc.func('void *objc_getClass(const char *name)')
    const get = objc.func('objc_msgSend', 'void *', ['void *', 'void *'])
    const isKind = objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'void *'])
    const count = objc.func('objc_msgSend', 'uintptr_t', ['void *', 'void *'])
    const item = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'uintptr_t'])
    const setBool = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'bool'])
    const setDouble = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'double'])
    const point = koffi.struct({ x: 'double', y: 'double' })
    const size = koffi.struct({ width: 'double', height: 'double' })
    const rect = koffi.struct({ origin: point, size })
    const setFrame = objc.func('objc_msgSend', 'void', ['void *', 'void *', rect])
    const effectClass = getClass('NSVisualEffectView')
    const view = koffi.decode(window.getNativeWindowHandle(), 'void *')
    const content = get(get(view, selector('window')), selector('contentView'))

    const findEffect = (node: unknown, depth = 0): unknown => {
      if (!node || depth > 16) return null
      if (isKind(node, selector('isKindOfClass:'), effectClass)) return node
      const children = get(node, selector('subviews'))
      const length = Number(count(children, selector('count')))
      for (let index = 0; index < length; index++) {
        const found = findEffect(item(children, selector('objectAtIndex:'), index), depth + 1)
        if (found) return found
      }
      return null
    }

    const effect = findEffect(content)
    if (!effect) throw new Error('Native popup material view unavailable')
    setBool(effect, selector('setWantsLayer:'), true)
    const layer = get(effect, selector('layer'))
    setDouble(layer, selector('setCornerRadius:'), 26)
    setBool(layer, selector('setMasksToBounds:'), true)

    const update = (): void => {
      if (window.isDestroyed()) return
      const { width, height } = window.getContentBounds()
      setFrame(effect, selector('setFrame:'), {
        origin: { x: 20, y: 20 },
        size: { width: Math.max(0, width - 40), height: Math.max(0, height - 40) }
      })
      // Electron can reset native material radii during a layout pass.
      setDouble(layer, selector('setCornerRadius:'), 26)
    }
    update()
    const afterLayout = (): void => { setImmediate(update) }
    window.on('resize', afterLayout)
    window.on('show', afterLayout)
    window.once('ready-to-show', afterLayout)
    window.once('closed', () => {
      window.removeListener('resize', afterLayout)
      window.removeListener('show', afterLayout)
    })
  } catch (error) {
    // Preserve transparent shadow margins if native material cannot be shaped.
    window.setVibrancy(null)
    console.warn('[popup] Native rounded material unavailable:', error)
  }
}
