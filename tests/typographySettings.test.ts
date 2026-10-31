import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSettings } from '../src/shared/settingsDefaults'

test('旧设置补齐默认字体与字号，保留已有外观选择', () => {
  const settings = normalizeSettings({ themePreset: 'sakura', themeMode: 'dark' } as never)
  assert.equal(settings.uiFontFamily, 'default')
  assert.equal(settings.uiFontSize, 14)
  assert.equal(settings.themePreset, 'sakura')
  assert.equal(settings.themeMode, 'dark')
})

test('字体采用固定选项，字号限制为 12–20 且拒绝非数值', () => {
  for (const font of ['default', 'system', 'serif', 'mono']) {
    assert.equal(normalizeSettings({ uiFontFamily: font } as never).uiFontFamily, font)
  }
  for (const [value, expected] of [[10, 12], [24, 20], [15.6, 16], [NaN, 14], [Infinity, 14], ['20', 14]] as const) {
    assert.equal(normalizeSettings({ uiFontSize: value } as never).uiFontSize, expected)
  }
  assert.equal(normalizeSettings({ uiFontFamily: 'invalid' } as never).uiFontFamily, 'default')
})
