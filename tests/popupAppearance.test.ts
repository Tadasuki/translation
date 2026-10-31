import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('翻译弹窗应使用原生背景模糊和中性面板', () => {
  const popupSource = readFileSync('src/main/popup.ts', 'utf8')
  const styles = readFileSync('src/renderer/src/style.css', 'utf8')

  // 当前确认的浮窗使用 popover 原生磨砂材质，避免旧测试要求退回 under-window。
  assert.match(popupSource, /vibrancy:\s*'popover'/u)
  assert.match(popupSource, /visualEffectState:\s*'active'/u)
  assert.doesNotMatch(styles, /glass-noise\.png|radial-gradient/u)
  assert.match(popupSource, /transparent:\s*true[\s\S]*?backgroundColor:\s*'#00000000'/u)
  assert.match(styles, /body\s*\{[^}]*padding:\s*20px;[^}]*overflow:\s*hidden;/su)
  assert.match(styles, /#popup\s*\{[^}]*border-radius:\s*26px;[^}]*overflow:\s*hidden;/su)
  assert.match(styles, /#popup\s*\{[^}]*background:\s*var\(--translation-popup-bg\)/su)
  assert.match(styles, /#popup\s*\{[^}]*backdrop-filter:\s*blur\(28px\)/su)
  assert.match(styles, /#popup\s*\{[^}]*box-shadow:[\s\S]*?var\(--floating-shadow\)/su)
})

/**
 * 宿主保留透明阴影边距，圆角只裁切实际面板。
 * @returns 无返回值。
 * @author zhenghq
 */
test('翻译弹窗宿主保持透明，不用第二层圆角裁掉柔光阴影', () => {
  const styles = readFileSync('src/renderer/src/style.css', 'utf8')

  assert.match(styles, /html\s*,\s*body\s*\{[^}]*background:\s*transparent;[^}]*border-radius:\s*0;/su)
  assert.match(styles, /body\s*\{[^}]*isolation:\s*isolate;/su)
})
