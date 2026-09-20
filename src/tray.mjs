import path from 'node:path'
import { Menu, nativeImage, nativeTheme, Tray } from 'electron'

// 系统托盘控制器。托盘菜单的每一行都由 main.mjs 注入的 provider 提供：
// 本模块只负责图标与菜单装配，不关心"更新"或"PATH 修复"的具体实现。
//
// providers: {
//   isOpenInBrowserEnabled(), openInBrowser(),
//   dshCommandItems() -> MenuItem[],
//   dshUpdateItem()   -> MenuItem | null,   // 发现 Harness 新版本时才存在
//   desktopUpdateItem() -> MenuItem,
//   restart(), quit(),
// }
// macOS 的托盘用模板图（随菜单栏明暗自动反色），Windows/Linux 按主题选深浅图标。
function resolveIconName() {
  if (process.platform === 'darwin') return 'tray-icon.png'
  return nativeTheme.shouldUseDarkColors ? 'tray-icon-dark.png' : 'tray-icon-light.png'
}

export function createTrayController({ brandDir, onShowWindow, providers }) {
  let tray = null

  function createImage() {
    const iconPath = path.join(brandDir, resolveIconName())
    const iconSize = process.platform === 'darwin' ? 18 : 20
    const image = nativeImage.createFromPath(iconPath).resize({
      width: iconSize,
      height: iconSize,
    })
    if (process.platform === 'darwin') image.setTemplateImage(true)
    return image
  }

  function updateTheme() {
    if (tray) tray.setImage(createImage())
  }

  function buildMenu() {
    const items = [
      {
        label: '在默认浏览器中打开',
        enabled: providers.isOpenInBrowserEnabled(),
        click: providers.openInBrowser,
      },
      { type: 'separator' },
      ...providers.dshCommandItems(),
    ]
    const dshUpdateItem = providers.dshUpdateItem()
    if (dshUpdateItem) items.push(dshUpdateItem)
    items.push(
      providers.desktopUpdateItem(),
      { type: 'separator' },
      { label: '重启', click: providers.restart },
      { label: '退出', click: providers.quit },
    )
    return Menu.buildFromTemplate(items)
  }

  function create() {
    if (tray) return
    tray = new Tray(createImage())
    tray.setToolTip('DeepSeek Harness Desktop')
    tray.on('click', onShowWindow)
    tray.on('right-click', () => tray?.popUpContextMenu(buildMenu()))
    nativeTheme.on('updated', updateTheme)
  }

  function dispose() {
    nativeTheme.removeListener('updated', updateTheme)
  }

  return { create, dispose }
}
