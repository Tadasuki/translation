import sharp from 'sharp'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BUILD_DIRECTORY = 'build'
const ICON_PNG = join(BUILD_DIRECTORY, 'icon.png')

/** SVG 是图标源文件，使用项目已有的 sharp 生成各平台尺寸。 */
async function renderPng(source, size, output) {
  await sharp(source, { density: 144 }).resize(size, size).png().toFile(output)
}

/** 使用 Windows 7+ 支持的 PNG 图像帧生成多尺寸 ICO。 */
async function generateIco() {
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const frames = await Promise.all(sizes.map((size) => sharp(ICON_PNG).resize(size, size).png().toBuffer()))
  const header = Buffer.alloc(6 + sizes.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  sizes.forEach((size, index) => {
    const position = 6 + index * 16
    header[position] = size === 256 ? 0 : size
    header[position + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, position + 4)
    header.writeUInt16LE(32, position + 6)
    header.writeUInt32LE(frames[index].length, position + 8)
    header.writeUInt32LE(offset, position + 12)
    offset += frames[index].length
  })
  writeFileSync(join(BUILD_DIRECTORY, 'icon.ico'), Buffer.concat([header, ...frames]))
}

/** iconutil 生成标准 macOS 图标集，保留 Retina 对应尺寸。 */
async function generateIcns() {
  const output = join(BUILD_DIRECTORY, 'icon.icns')
  if (process.platform !== 'darwin') {
    if (!existsSync(output)) throw new Error('首次生成 ICNS 需要 macOS 的 iconutil')
    return
  }
  const iconset = join(BUILD_DIRECTORY, '.application.iconset')
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset, { recursive: true })
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      await renderPng(ICON_PNG, size, join(iconset, `icon_${size}x${size}.png`))
      await renderPng(ICON_PNG, size * 2, join(iconset, `icon_${size}x${size}@2x.png`))
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', output])
  } finally { rmSync(iconset, { recursive: true, force: true }) }
}

mkdirSync(BUILD_DIRECTORY, { recursive: true })
await renderPng(join(BUILD_DIRECTORY, 'icon.svg'), 1024, ICON_PNG)
await generateIco()
await generateIcns()
await renderPng(join(BUILD_DIRECTORY, 'tray-template.svg'), 18, join(BUILD_DIRECTORY, 'trayTemplate.png'))
await renderPng(join(BUILD_DIRECTORY, 'tray-template.svg'), 36, join(BUILD_DIRECTORY, 'trayTemplate@2x.png'))
await renderPng(join(BUILD_DIRECTORY, 'tray-color.svg'), 32, join(BUILD_DIRECTORY, 'tray.png'))
console.log('Generated SVG, PNG, ICO, ICNS and tray icons.')
