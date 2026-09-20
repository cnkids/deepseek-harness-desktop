import { isDshUpdateRequired } from '../dsh-runtime.mjs'
import { describeError } from '../redaction.mjs'
import {
  dshUpdateLaunchNotice,
  isDshUpdateNotified,
  readDshUpdateNotice,
  writeDshUpdateNotice,
} from './dsh-update.mjs'

// 提示里要说清"装到哪儿"：系统 Node.js 进用户全局环境，私有 runtime 进应用目录。
function scopeLabel(nodeEnvironment) {
  return nodeEnvironment.source === 'system' ? '用户全局环境' : '应用私有环境'
}

// 启动前的版本决策：首次安装静默完成（没有旧版本可退），已有版本时**每个版本只
// 询问一次**（选择"稍后"就用当前版本启动，托盘仍可随时更新）。
//
// store 是控制器的共享状态：{ getState, setState, markFailed }。
export function createLaunchPreparer({
  resolver,
  runner,
  reportStatus,
  showMessageBox,
  noticePath,
  store,
}) {
  async function askToUpdate({ message, detail }) {
    const { response } = await showMessageBox({
      type: 'info',
      title: '发现 Harness 新版本',
      message,
      detail,
      buttons: ['立即更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    return response === 0
  }

  async function prepare({ nodeEnvironment, installed, env }) {
    store.setState({ installedVersion: installed?.version ?? null, error: null })
    const { version: latestVersion, registry, stale } = await resolver.resolve({
      installedVersion: installed?.version ?? null,
    })
    store.setState({ latestVersion: latestVersion ?? null, registry, stale })

    if (!installed) {
      // 首次安装没有旧版本可退，失败必须让启动流程报出可执行的错（含装到哪个环境）。
      let installation
      try {
        installation = await runner.install({
          nodeEnvironment,
          env,
          version: latestVersion ?? 'latest',
          registry,
          isUpdate: false,
        })
      } catch (error) {
        throw new Error(`无法在${scopeLabel(nodeEnvironment)}安装 DeepSeek Harness：${describeError(error)}`)
      }
      store.setState({ status: 'current', installedVersion: installation.version })
      return { installation, notice: '' }
    }

    const label = scopeLabel(nodeEnvironment)
    if (!isDshUpdateRequired(installed.version, latestVersion)) {
      reportStatus({
        message: 'DeepSeek Harness 已就绪',
        // 没联网查到版本时不能说"已是最新版本"，那会让人以为网络检查通过了。
        detail: `${stale || !latestVersion ? '使用已安装版本' : '已是最新版本'} ${installed.version} · ${label}`,
      })
      store.setState({ status: 'current' })
      return { installation: installed, notice: '' }
    }

    store.setState({ status: 'available' })
    const notice = await readDshUpdateNotice(noticePath)
    if (isDshUpdateNotified(notice, latestVersion)) {
      return { installation: installed, notice: dshUpdateLaunchNotice(store.getState()) }
    }
    await writeDshUpdateNotice(noticePath, latestVersion)

    const confirmed = await askToUpdate({
      message: `DeepSeek Harness v${latestVersion} 已发布，当前安装的是 v${installed.version}。`,
      detail:
        '选择「立即更新」会在本次启动前完成更新；选择「稍后」将先用当前版本启动，之后可从系统托盘随时更新。',
    })
    if (!confirmed) {
      return { installation: installed, notice: dshUpdateLaunchNotice(store.getState()) }
    }

    try {
      const installation = await runner.install({
        nodeEnvironment,
        env,
        version: latestVersion,
        registry,
        isUpdate: true,
      })
      await runner.clearNotice()
      store.setState({ status: 'current', installedVersion: installation.version, error: null })
      return { installation, notice: '' }
    } catch (error) {
      console.warn('[dsh] update failed, using installed version', describeError(error))
      store.markFailed(error, 'update')
      reportStatus({
        message: 'Harness 更新失败',
        detail: `继续使用已安装版本 ${installed.version} · ${label}`,
      })
      return { installation: installed, notice: dshUpdateLaunchNotice(store.getState()) }
    }
  }

  return { prepare }
}
